import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { CliError } from '../errors.js';
import {
  commitExists,
  isAncestor,
  isRepo,
  lockFileExists,
  revParseCommit,
  showFile,
} from '../git.js';
import { toPosixRel } from '../paths.js';
import { sha256Hex } from '../canonical.js';
import { readLock } from './lock.js';
import type { BaseInfo, Finding } from '../types.js';

export interface LoadOptions {
  cwd: string;
  root: string;
  criteriaArg: string;
  baseArg: string | null;
  now: () => Date;
}

export interface LoadedCriteria {
  bytes: Buffer;
  base: BaseInfo;
  criteriaPath: string;
  findings: Finding[];
}

const NO_BASE_MESSAGE =
  "no locked base: criteria were read from the working tree, so an agent could have edited them; diff criteria are UNVERIFIED. Run 'agent-receipt-check lock' before the next session.";
const BASE_IS_HEAD_MESSAGE =
  "no lock: HEAD was used as the base. If the agent committed during the session, its commits are inside the base — run 'lock' before the agent starts.";

function criteriaChangedMessage(criteriaPath: string): string {
  return `${criteriaPath} changed after the base (or was deleted); the base version was used — the agent may have edited its own criteria`;
}

function formatAge(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h`;
  const minutes = Math.max(1, Math.floor(ms / 60_000));
  return `${minutes}m`;
}

async function addCriteriaChanged(
  chosen: Buffer,
  absCriteria: string,
  criteriaPath: string,
  findings: Finding[],
): Promise<void> {
  let current: Buffer | null = null;
  try {
    current = await fsPromises.readFile(absCriteria);
  } catch {
    current = null;
  }
  if (current === null || sha256Hex(current) !== sha256Hex(chosen)) {
    findings.push({ id: 'CRITERIA-CHANGED', severity: 'warn', message: criteriaChangedMessage(criteriaPath) });
  }
}

export async function resolveCriteria(opts: LoadOptions): Promise<LoadedCriteria> {
  const absCriteria = path.resolve(opts.cwd, opts.criteriaArg);
  const criteriaPath = toPosixRel(opts.root, absCriteria);
  if (
    criteriaPath === '' ||
    criteriaPath === '..' ||
    criteriaPath.startsWith('../') ||
    path.isAbsolute(criteriaPath)
  ) {
    throw new CliError('criteria file must be inside root');
  }

  const repo = await isRepo(opts.root);
  const findings: Finding[] = [];

  // Rule 1: explicit --base. The lock is not read, only noticed.
  if (opts.baseArg !== null) {
    if (!repo) throw new CliError('--base needs a git repository');
    const sha = await revParseCommit(opts.root, opts.baseArg);
    if (sha === null) throw new CliError(`unknown ref '${opts.baseArg}'`);
    const bytes = await showFile(opts.root, sha, criteriaPath);
    if (bytes === null) {
      throw new CliError(
        `${criteriaPath} is not in ${opts.baseArg}; commit it before the run, or use 'agent-receipt-check lock'`,
      );
    }
    if (await lockFileExists(opts.root)) {
      findings.push({
        id: 'LOCK-IGNORED',
        severity: 'info',
        message: 'a lock file exists but --base was given; the lock was ignored',
      });
    }
    await addCriteriaChanged(bytes, absCriteria, criteriaPath, findings);
    return {
      bytes,
      base: { source: 'ref', ref: opts.baseArg, sha, lockedAt: null },
      criteriaPath,
      findings,
    };
  }

  // Rule 2: a usable lock for this criteria path.
  let ignoredLockPath: string | null = null;
  if (repo) {
    const read = await readLock(opts.root);
    if (!read.ok && !read.missing) {
      throw new CliError(
        `lock file is corrupt or was edited (${read.path}); re-lock before the next run`,
      );
    }
    if (read.ok) {
      if (read.lock.criteriaPath === criteriaPath) {
        if (!(await commitExists(opts.root, read.lock.baseSha))) {
          throw new CliError(
            `lock base ${read.lock.baseSha.slice(0, 7)} not found (history rewritten?)`,
          );
        }
        const createdAt = Date.parse(read.lock.createdAt);
        if (Number.isFinite(createdAt) && opts.now().getTime() - createdAt > 24 * 3_600_000) {
          findings.push({
            id: 'STALE-LOCK',
            severity: 'warn',
            message: `base locked ${formatAge(opts.now().getTime() - createdAt)} ago — re-lock at the start of each session`,
          });
        }
        const ancestor = await isAncestor(opts.root, read.lock.baseSha, 'HEAD');
        if (ancestor !== true) {
          findings.push({
            id: 'BASE-NOT-ANCESTOR',
            severity: 'warn',
            message: `lock base ${read.lock.baseSha.slice(0, 7)} is not an ancestor of HEAD — the branch was switched or history rewritten`,
          });
        }
        const bytes = Buffer.from(read.lock.criteria, 'utf8');
        await addCriteriaChanged(bytes, absCriteria, criteriaPath, findings);
        return {
          bytes,
          base: { source: 'lock', ref: null, sha: read.lock.baseSha, lockedAt: read.lock.createdAt },
          criteriaPath,
          findings,
        };
      }
      ignoredLockPath = read.lock.criteriaPath;
      findings.push({
        id: 'LOCK-IGNORED',
        severity: 'info',
        message: `a lock exists for ${ignoredLockPath}, not ${criteriaPath}; it was ignored`,
      });
    }
  }

  // Rule 3: committed at HEAD, no usable lock.
  if (repo) {
    const headSha = await revParseCommit(opts.root, 'HEAD');
    if (headSha !== null) {
      const bytes = await showFile(opts.root, headSha, criteriaPath);
      if (bytes !== null) {
        findings.push({ id: 'BASE-IS-HEAD', severity: 'warn', message: BASE_IS_HEAD_MESSAGE });
        await addCriteriaChanged(bytes, absCriteria, criteriaPath, findings);
        return {
          bytes,
          base: { source: 'head', ref: null, sha: headSha, lockedAt: null },
          criteriaPath,
          findings,
        };
      }
    }
  }

  // Rule 4: working tree, no base.
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(absCriteria);
  } catch {
    throw new CliError(`criteria file not found: ${criteriaPath}`);
  }
  findings.push({ id: 'NO-BASE', severity: 'info', message: NO_BASE_MESSAGE });
  return {
    bytes,
    base: { source: 'none', ref: null, sha: null, lockedAt: null },
    criteriaPath,
    findings,
  };
}
