import { excerpt, redact, scrubPaths } from '../redact.js';
import type { CheckContext, CheckResult, SecretRef, Verdict } from '../types.js';

export function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  return Number.isInteger(seconds) ? String(seconds) : String(Number(seconds.toFixed(3)));
}

export interface ResultOptions {
  secrets?: SecretRef[];
  mode?: 'head' | 'tail';
}

/** Redact → scrub paths → truncate, then attach the measured duration. */
export function makeResult(
  verdict: Verdict,
  evidence: string,
  reason: string,
  started: number,
  ctx: CheckContext,
  opts: ResultOptions = {},
): CheckResult {
  const secrets = opts.secrets ?? ctx.secrets;
  const clean = (text: string): string => scrubPaths(redact(text, secrets), ctx.root);
  return {
    verdict,
    evidence: excerpt(clean(evidence), 400, opts.mode ?? 'head'),
    reason: excerpt(clean(reason), 300, 'head'),
    durationMs: Math.max(0, Math.round(Date.now() - started)),
  };
}
