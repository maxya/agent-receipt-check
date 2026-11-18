import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { resolveInRoot, safeRealpath } from '../paths.js';
import type { CheckContext, CheckResult, FileCriterion, StrOrList } from '../types.js';
import { makeResult } from './common.js';

const LARGE = 50 * 1024 * 1024;
const MATCH_LIMIT = 5 * 1024 * 1024;

function asList(value: StrOrList): string[] {
  return Array.isArray(value) ? value : [value];
}

async function hashFile(abs: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(abs);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function ioCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

export async function runFileCheck(c: FileCriterion, ctx: CheckContext): Promise<CheckResult> {
  const started = Date.now();
  const abs = resolveInRoot(ctx.root, c.path);
  const shouldExist = c.exists ?? true;

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(abs);
  } catch (err) {
    const code = ioCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      if (!shouldExist) {
        return makeResult('PASS', 'absent', 'absent as expected', started, ctx);
      }
      return makeResult('FAIL', 'does not exist', 'missing', started, ctx);
    }
    return makeResult('UNVERIFIED', '', `unreadable: ${code}`, started, ctx);
  }

  if (!shouldExist) {
    return makeResult('FAIL', 'exists', 'exists', started, ctx);
  }
  if (stat.isDirectory()) {
    return makeResult('FAIL', '', 'is a directory, expected a file', started, ctx);
  }

  // A symlink whose target leaves root cannot be checked honestly.
  try {
    const link = await fs.lstat(abs);
    if (link.isSymbolicLink()) {
      const real = safeRealpath(ctx.root, abs);
      if (!real.ok) {
        if (real.escape) {
          return makeResult('UNVERIFIED', '', 'symlink points outside root', started, ctx);
        }
        return makeResult('UNVERIFIED', '', `unreadable: ${real.error ?? 'UNKNOWN'}`, started, ctx);
      }
    }
  } catch (err) {
    return makeResult('UNVERIFIED', '', `unreadable: ${ioCode(err)}`, started, ctx);
  }

  const wantsContains = c.contains !== undefined || c.notContains !== undefined;
  if (wantsContains && stat.size > LARGE) {
    return makeResult('UNVERIFIED', `${stat.size} bytes`, 'too large to inspect', started, ctx);
  }
  if (c.matches !== undefined && stat.size > MATCH_LIMIT) {
    return makeResult('UNVERIFIED', `${stat.size} bytes`, 'too large to inspect', started, ctx);
  }

  let content: string | null = null;
  if (wantsContains || c.matches !== undefined) {
    try {
      content = await fs.readFile(abs, 'utf8');
    } catch (err) {
      return makeResult('UNVERIFIED', '', `unreadable: ${ioCode(err)}`, started, ctx);
    }
  }

  let digest: string | null = null;
  if (c.sha256 !== undefined) {
    try {
      digest = await hashFile(abs);
    } catch (err) {
      return makeResult('UNVERIFIED', '', `unreadable: ${ioCode(err)}`, started, ctx);
    }
  } else {
    // Evidence names a hash; compute it for small files and skip for huge ones.
    if (stat.size <= LARGE) {
      try {
        digest = await hashFile(abs);
      } catch {
        digest = null;
      }
    }
  }

  const evidence = `${stat.size} bytes${digest ? `, sha256 ${digest.slice(0, 12)}…` : ''}`;

  if (c.contains !== undefined && content !== null) {
    for (const needle of asList(c.contains)) {
      if (!content.includes(needle)) {
        return makeResult('FAIL', evidence, `missing "${needle}"`, started, ctx);
      }
    }
  }
  if (c.notContains !== undefined && content !== null) {
    for (const needle of asList(c.notContains)) {
      if (content.includes(needle)) {
        return makeResult('FAIL', evidence, `contains "${needle}"`, started, ctx);
      }
    }
  }
  if (c.matches !== undefined && content !== null) {
    const re = new RegExp(c.matches, 'mu');
    if (!re.test(content)) {
      return makeResult('FAIL', evidence, `does not match /${c.matches}/`, started, ctx);
    }
  }
  if (c.sha256 !== undefined && digest !== null) {
    if (digest !== c.sha256) {
      return makeResult(
        'FAIL',
        evidence,
        `sha256 mismatch (expected ${c.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…)`,
        started,
        ctx,
      );
    }
  }

  return makeResult('PASS', evidence, 'content matches', started, ctx);
}
