import fs from 'node:fs/promises';
import { lsTreeType } from '../git.js';
import { globToRegExp, isGlob } from '../glob.js';
import { resolveInRoot } from '../paths.js';
import type { CheckContext, CheckResult, DiffCriterion } from '../types.js';
import { makeResult } from './common.js';

async function isDirectoryPath(
  root: string,
  baseSha: string | null,
  pattern: string,
): Promise<boolean> {
  if (pattern.endsWith('/')) return true;
  try {
    const stat = await fs.stat(resolveInRoot(root, pattern));
    if (stat.isDirectory()) return true;
  } catch {
    // missing in the working tree is fine; the base decides
  }
  if (baseSha !== null && (await lsTreeType(root, baseSha, pattern)) === 'tree') return true;
  return false;
}

export async function matchedPaths(
  root: string,
  baseSha: string | null,
  pattern: string,
  changed: Set<string>,
): Promise<string[]> {
  const sorted = [...changed].sort();
  if (isGlob(pattern)) {
    const re = globToRegExp(pattern.replace(/\/+$/, ''));
    return sorted.filter((p) => re.test(p));
  }
  if (await isDirectoryPath(root, baseSha, pattern)) {
    const prefix = `${pattern.replace(/\/+$/, '')}/`;
    return sorted.filter((p) => p.startsWith(prefix));
  }
  return sorted.filter((p) => p === pattern);
}

function listEvidence(paths: string[]): string {
  const shown = paths.slice(0, 10).join(', ');
  return paths.length > 10 ? `${shown} (+${paths.length - 10} more)` : shown;
}

export async function runDiffCheck(c: DiffCriterion, ctx: CheckContext): Promise<CheckResult> {
  const started = Date.now();
  if (ctx.base.sha === null) {
    return makeResult('UNVERIFIED', 'no base', 'no base to diff against', started, ctx);
  }
  const changed = await ctx.changedSet();
  if (!(changed instanceof Set)) {
    return makeResult('UNVERIFIED', '', `git diff failed: ${changed.error}`, started, ctx);
  }

  const base7 = ctx.base.sha.slice(0, 7);
  const matches = await matchedPaths(ctx.root, ctx.base.sha, c.path, changed);
  const wantChanged = c.changed ?? true;

  if (wantChanged) {
    if (matches.length > 0) {
      return makeResult('PASS', `changed: ${listEvidence(matches)}`, `changed since ${base7}`, started, ctx);
    }
    return makeResult(
      'FAIL',
      'no changed paths',
      `no change under ${c.path} since ${base7}`,
      started,
      ctx,
    );
  }

  if (matches.length === 0) {
    return makeResult('PASS', 'no changed paths', `unchanged since ${base7}`, started, ctx);
  }
  return makeResult(
    'FAIL',
    `changed: ${listEvidence(matches)}`,
    `changed since ${base7}`,
    started,
    ctx,
  );
}
