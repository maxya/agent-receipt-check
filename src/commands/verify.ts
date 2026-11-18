import path from 'node:path';
import type { VerifyOptions } from '../args.js';
import { runCheck } from '../checks/index.js';
import { sha256Hex } from '../canonical.js';
import { collectEnvSecrets } from '../redact.js';
import { CliError } from '../errors.js';
import { installChildSignalHandlers } from '../exec.js';
import { computeChangedSet, headInfo } from '../git.js';
import { globToRegExp } from '../glob.js';
import { resolveCriteria } from '../criteria/load.js';
import { validateCriteriaBytes } from '../criteria/schema.js';
import { buildReceipt } from '../receipt/build.js';
import { defaultReceiptPath, writeReceipt } from '../receipt/write.js';
import { exitCodeFor, renderHumanReport } from '../report/human.js';
import { resolveRoot } from '../root.js';
import type {
  BaseInfo,
  CheckResult,
  Criterion,
  Finding,
  SecretRef,
} from '../types.js';

/** §4.8 runner list. An entry without `/` matches a basename; one with `/` a full path. */
export const RUNNER_FILES: readonly string[] = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'deno.json',
  'deno.jsonc',
  'tsconfig.json',
  'jest.config.*',
  'vitest.config.*',
  'vite.config.*',
  'playwright.config.*',
  'cypress.config.*',
  'karma.conf.*',
  '.mocharc*',
  'babel.config.*',
  'pytest.ini',
  'conftest.py',
  'pyproject.toml',
  'setup.cfg',
  'tox.ini',
  'Makefile',
  'justfile',
  'Cargo.toml',
  'go.mod',
];

export function runnerMatches(changedPath: string): boolean {
  const base = changedPath.slice(changedPath.lastIndexOf('/') + 1);
  for (const entry of RUNNER_FILES) {
    if (entry.includes('/')) {
      if (globToRegExp(entry).test(changedPath)) return true;
    } else if (globToRegExp(entry).test(base)) {
      return true;
    }
  }
  return false;
}

function listPaths(paths: string[]): string {
  return paths.slice(0, 3).join(', ');
}

function isGitignorePath(p: string): boolean {
  return p === '.gitignore' || p.endsWith('/.gitignore');
}

function headerSecrets(criteria: Criterion[]): SecretRef[] {
  const out: SecretRef[] = [];
  for (const criterion of criteria) {
    if (criterion.type !== 'http' || criterion.headers === undefined) continue;
    for (const value of Object.values(criterion.headers)) {
      if (typeof value !== 'object') continue;
      const envValue = process.env[value.env];
      if (envValue !== undefined && envValue.length > 0) {
        out.push({ name: value.env, value: envValue });
      }
    }
  }
  return out;
}

function dedupeSecrets(secrets: SecretRef[]): SecretRef[] {
  const seen = new Set<string>();
  const out: SecretRef[] = [];
  for (const secret of secrets) {
    const key = `${secret.name}\u0000${secret.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(secret);
  }
  out.sort((a, b) => b.value.length - a.value.length);
  return out;
}

export async function runVerify(opts: VerifyOptions, cwd: string): Promise<number> {
  const root = await resolveRoot(cwd, opts.root);
  const loaded = await resolveCriteria({
    cwd,
    root,
    criteriaArg: opts.criteria,
    baseArg: opts.base,
    now: () => new Date(),
  });

  const validation = validateCriteriaBytes(loaded.bytes, { root, label: loaded.criteriaPath });
  if (!validation.ok || validation.value === null) {
    throw new CliError(validation.errors.join('\n'));
  }

  const criteria = validation.value.criteria;
  const hasTest = criteria.some((criterion) => criterion.type === 'test');
  const claim = opts.claim ?? validation.value.claim;
  const findings: Finding[] = [...loaded.findings];

  // Rule 4 plus a test criterion: say plainly that the commands were unlocked.
  if (loaded.base.source === 'none' && hasTest) {
    for (const finding of findings) {
      if (finding.id === 'NO-BASE') {
        finding.message +=
          ' commands came from an unlocked file — review it before trusting the result.';
      }
    }
  }

  // Compute the changed set once, even when no `diff` criterion exists.
  let changed: Set<string> | { error: string } = { error: 'no base' };
  let hiding: string[] = [];
  if (loaded.base.sha !== null) {
    const raw = await computeChangedSet(root, loaded.base.sha);
    if (raw.error !== null) {
      changed = { error: raw.error };
    } else {
      changed = raw.paths;
      hiding = raw.hiding;

      const gitignores = [...raw.paths].filter(isGitignorePath).sort();
      const affected = [...new Set([...hiding, ...gitignores])];
      if (affected.length > 0) {
        findings.push({
          id: 'GIT-HIDING',
          severity: 'warn',
          message: `git index flags or .gitignore rules changed (${listPaths(affected)}); affected paths were checked directly — an agent may have tried to hide changes`,
        });
      }

      if (hasTest) {
        const runners = [...raw.paths].filter(runnerMatches).sort();
        if (runners.length > 0) {
          findings.push({
            id: 'RUNNER-CHANGED',
            severity: 'warn',
            message: `test-runner config changed since the base (${listPaths(runners)}): locked test commands may now run differently`,
          });
        }
      }
    }
  }

  const secrets = dedupeSecrets([...collectEnvSecrets(process.env), ...headerSecrets(criteria)]);
  const base: BaseInfo = loaded.base;

  const ctx = {
    root,
    base,
    changedSet: async (): Promise<Set<string> | { error: string }> => changed,
    secrets,
    now: () => new Date(),
  };

  const results: CheckResult[] = [];
  const removeHandlers = installChildSignalHandlers();
  try {
    for (const criterion of criteria) {
      results.push(await runCheck(criterion, ctx));
    }
  } finally {
    removeHandlers();
  }

  const now = new Date();
  const info = await headInfo(root);
  const head =
    info === null
      ? null
      : { sha: info.sha, dirty: info.dirty || hiding.length > 0 };

  const receipt = buildReceipt({
    createdAt: now,
    claim,
    base,
    head,
    criteriaPath: loaded.criteriaPath,
    criteriaSha256: sha256Hex(loaded.bytes),
    criteria,
    results,
    findings,
    root,
    secrets,
  });

  const receiptPath =
    opts.out !== null
      ? path.resolve(cwd, opts.out)
      : await defaultReceiptPath(root, receipt.verdict, now);

  const json = `${JSON.stringify(receipt, null, 2)}\n`;

  let writeError: string | null = null;
  try {
    await writeReceipt(receiptPath, receipt);
  } catch (err) {
    writeError = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
  }

  const report = renderHumanReport({
    receipt,
    criteriaSha256: sha256Hex(loaded.bytes),
    receiptPath: writeError === null ? receiptPath : null,
    cwd,
  });

  if (opts.json) {
    process.stdout.write(json);
  } else {
    process.stdout.write(report);
  }

  if (writeError !== null) {
    process.stderr.write(`error: could not write receipt: ${writeError}\n`);
    return 1;
  }

  return exitCodeFor(receipt.verdict, opts.strict);
}
