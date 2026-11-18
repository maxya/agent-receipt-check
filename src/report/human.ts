import path from 'node:path';
import { excerpt } from '../redact.js';
import type { Receipt, ReceiptBase, RunVerdict } from '../types.js';
import { TOOL, VERSION } from '../version.js';

function utcStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

function shortSha(sha: string | null): string {
  return sha === null ? 'none' : sha.slice(0, 7);
}

export function formatBaseLine(base: ReceiptBase): string {
  switch (base.source) {
    case 'lock':
      return `base   lock ${shortSha(base.sha)} · locked ${
        base.lockedAt === null ? 'unknown' : utcStamp(base.lockedAt)
      }`;
    case 'ref':
      return `base   ref ${base.ref ?? '?'} ${shortSha(base.sha)}`;
    case 'head':
      return `base   head ${shortSha(base.sha)}`;
    default:
      return 'base   none (working tree)';
  }
}

export function formatVerdictLine(receipt: Receipt): string {
  const { verdict, summary, criteria } = receipt;
  const failed = criteria.filter((c) => c.verdict === 'FAIL');
  const unverified = criteria.filter((c) => c.verdict === 'UNVERIFIED');

  if (verdict === 'VERIFIED') {
    return `VERIFIED — ${summary.pass}/${summary.total} criteria passed`;
  }
  if (verdict === 'FAILED') {
    const detail = failed.map((c) => `${c.id}: ${c.reason}`).join('; ');
    const tail = summary.unverified > 0 ? `, ${summary.unverified} unverified` : '';
    return `FAILED — ${summary.fail} of ${summary.total} failed (${detail})${tail}`;
  }
  const detail = unverified.map((c) => `${c.id}: ${c.reason}`).join('; ');
  return `UNVERIFIED — ${summary.pass} passed, ${summary.unverified} unverified (${detail})`;
}

export interface HumanReportInput {
  receipt: Receipt;
  criteriaSha256: string;
  receiptPath: string | null;
  cwd: string;
}

/** Render the §4.12 human report. Every value here is already redacted and path-scrubbed. */
export function renderHumanReport(input: HumanReportInput): string {
  const { receipt } = input;
  const lines: string[] = [];

  lines.push(`${TOOL} ${VERSION}`);
  if (receipt.claim !== null) {
    lines.push(`claim  ${JSON.stringify(excerpt(receipt.claim, 120))}`);
  }
  lines.push(formatBaseLine(receipt.base));
  lines.push(`criteria sha256 ${input.criteriaSha256}`);

  for (const finding of receipt.findings) {
    if (finding.severity === 'warn') lines.push(`! ${finding.id} ${finding.message}`);
  }
  for (const criterion of receipt.criteria) {
    lines.push(`${criterion.verdict.padEnd(12)}${criterion.id} — ${criterion.reason}`);
  }

  lines.push(formatVerdictLine(receipt));

  for (const finding of receipt.findings) {
    if (finding.severity === 'info') lines.push(`i ${finding.id} ${finding.message}`);
  }

  if (input.receiptPath !== null) {
    const rel = path.relative(input.cwd, input.receiptPath) || '.';
    lines.push(`receipt ${rel}`);
    lines.push(`receipt sha256 ${receipt.sha256}`);
  }

  return `${lines.join('\n')}\n`;
}

export function exitCodeFor(verdict: RunVerdict, strict: boolean): number {
  if (verdict === 'FAILED') return 2;
  if (verdict === 'UNVERIFIED' && strict) return 2;
  return 0;
}
