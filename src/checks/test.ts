import fs from 'node:fs/promises';
import { runCommand } from '../exec.js';
import { resolveInRoot } from '../paths.js';
import { excerpt, redact, scrubPaths, stripAnsi } from '../redact.js';
import type { CheckContext, CheckResult, StrOrList, TestCriterion } from '../types.js';
import { formatSeconds, makeResult } from './common.js';

function asList(value: StrOrList): string[] {
  return Array.isArray(value) ? value : [value];
}

function firstMissing(text: string, list: StrOrList): string | null {
  for (const needle of asList(list)) {
    if (!text.includes(needle)) return needle;
  }
  return null;
}

function firstPresent(text: string, list: StrOrList): string | null {
  for (const needle of asList(list)) {
    if (text.includes(needle)) return needle;
  }
  return null;
}

function tail(text: string, max: number, ctx: CheckContext): string {
  return excerpt(scrubPaths(redact(text, ctx.secrets), ctx.root), max, 'tail');
}

export async function runTestCheck(c: TestCriterion, ctx: CheckContext): Promise<CheckResult> {
  const started = Date.now();
  const timeoutMs = c.timeoutMs ?? 300_000;

  let cwd = ctx.root;
  if (c.cwd !== undefined) {
    try {
      cwd = resolveInRoot(ctx.root, c.cwd);
    } catch {
      return makeResult('UNVERIFIED', '', `cwd ${c.cwd} does not exist`, started, ctx);
    }
  }
  try {
    const stat = await fs.stat(cwd);
    if (!stat.isDirectory()) {
      return makeResult('UNVERIFIED', '', `cwd ${c.cwd ?? '.'} is not a directory`, started, ctx);
    }
  } catch {
    return makeResult('UNVERIFIED', '', `cwd ${c.cwd ?? '.'} does not exist`, started, ctx);
  }

  const run = await runCommand(c.command, { cwd, timeoutMs });
  const stdout = stripAnsi(run.stdout);
  const stderr = stripAnsi(run.stderr);
  const seconds = formatSeconds(run.durationMs);
  const evidence =
    `exit ${run.code ?? 'null'} in ${seconds}s; ` +
    `stdout tail: "${tail(stdout, 200, ctx)}"; ` +
    `stderr tail: "${tail(stderr, 200, ctx)}"`;
  const opts = { mode: 'tail' as const };

  if (run.spawnError !== null) {
    return makeResult('UNVERIFIED', '', `could not start: ${run.spawnError}`, started, ctx, opts);
  }
  if (run.timedOut) {
    return makeResult(
      'UNVERIFIED',
      evidence,
      `timed out after ${formatSeconds(timeoutMs)}s`,
      started,
      ctx,
      opts,
    );
  }
  if (run.code === 127 || (process.platform === 'win32' && run.code === 9009)) {
    return makeResult('UNVERIFIED', evidence, 'command not found (exit 127)', started, ctx, opts);
  }
  if (run.signal !== null) {
    return makeResult('FAIL', evidence, `terminated by ${run.signal}`, started, ctx, opts);
  }

  const expectedExit = c.expect?.exit ?? 0;
  if (run.code !== expectedExit) {
    return makeResult(
      'FAIL',
      evidence,
      `exited ${run.code ?? 'null'}, expected ${expectedExit}`,
      started,
      ctx,
      opts,
    );
  }

  const expect = c.expect;
  if (expect?.stdoutContains !== undefined) {
    const missing = firstMissing(stdout, expect.stdoutContains);
    if (missing !== null) {
      return makeResult(
        run.stdoutTruncated ? 'UNVERIFIED' : 'FAIL',
        evidence,
        `stdout lacks "${missing}"`,
        started,
        ctx,
        opts,
      );
    }
  }
  if (expect?.stdoutNotContains !== undefined) {
    const present = firstPresent(stdout, expect.stdoutNotContains);
    if (present !== null) {
      return makeResult('FAIL', evidence, `stdout contains "${present}"`, started, ctx, opts);
    }
  }
  if (expect?.stderrContains !== undefined) {
    const missing = firstMissing(stderr, expect.stderrContains);
    if (missing !== null) {
      return makeResult(
        run.stderrTruncated ? 'UNVERIFIED' : 'FAIL',
        evidence,
        `stderr lacks "${missing}"`,
        started,
        ctx,
        opts,
      );
    }
  }
  if (expect?.stderrNotContains !== undefined) {
    const present = firstPresent(stderr, expect.stderrNotContains);
    if (present !== null) {
      return makeResult('FAIL', evidence, `stderr contains "${present}"`, started, ctx, opts);
    }
  }

  return makeResult(
    'PASS',
    evidence,
    `\`${c.command}\` exited ${run.code ?? 0} (${seconds}s)`,
    started,
    ctx,
    opts,
  );
}
