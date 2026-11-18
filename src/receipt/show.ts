import fs from 'node:fs/promises';
import { verifySeal } from '../canonical.js';
import { excerpt } from '../redact.js';
import { TOOL } from '../version.js';
import type { Receipt, RunVerdict } from '../types.js';

export type ShowResult =
  | { kind: 'unreadable'; code: string }
  | { kind: 'not-a-receipt' }
  | { kind: 'checked'; receipt: Receipt; expected: string; actual: string; valid: boolean };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Read and class the receipt. Never throws; the caller maps the result to an exit code. */
export async function loadReceipt(file: string): Promise<ShowResult> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    return { kind: 'unreadable', code: (err as NodeJS.ErrnoException).code ?? 'UNKNOWN' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'not-a-receipt' };
  }

  const obj = asRecord(parsed);
  if (obj === null) return { kind: 'not-a-receipt' };
  if (obj.schema !== 1) return { kind: 'not-a-receipt' };
  if (obj.tool !== TOOL) return { kind: 'not-a-receipt' };
  if (typeof obj.sha256 !== 'string' || obj.sha256 === '') return { kind: 'not-a-receipt' };

  const seal = verifySeal(obj);
  return {
    kind: 'checked',
    receipt: obj as unknown as Receipt,
    expected: seal.expected,
    actual: seal.actual,
    valid: seal.valid,
  };
}

function utcStamp(iso: string | undefined): string {
  if (typeof iso !== 'string') return 'unknown';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}

function shortSha(sha: string | null | undefined): string {
  return typeof sha === 'string' ? sha.slice(0, 7) : 'none';
}

function baseLabel(receipt: Receipt): string {
  const base = receipt.base;
  if (base === undefined || base === null) return 'base none';
  switch (base.source) {
    case 'lock':
      return `base lock ${shortSha(base.sha)}`;
    case 'ref':
      return `base ref ${base.ref ?? '?'} ${shortSha(base.sha)}`;
    case 'head':
      return `base head ${shortSha(base.sha)}`;
    default:
      return 'base none';
  }
}

function summaryPhrase(verdict: RunVerdict, receipt: Receipt): string {
  const summary = receipt.summary;
  if (summary === undefined) return verdict;
  if (verdict === 'VERIFIED') return `${summary.pass}/${summary.total} criteria passed`;
  if (verdict === 'FAILED') return `${summary.fail} of ${summary.total} failed`;
  return `${summary.pass} passed, ${summary.unverified} unverified`;
}

/** The §4.12 `receipt show` text for a seal-valid receipt. */
export function renderShow(receipt: Receipt): string {
  const lines: string[] = [];
  lines.push(`SEAL OK — receipt sha256 ${receipt.sha256} matches its contents`);
  const verdict = summaryPhrase(receipt.verdict, receipt);
  lines.push(
    `${receipt.verdict} — ${verdict} · created ${utcStamp(receipt.createdAt)} · ${baseLabel(receipt)}`,
  );
  if (typeof receipt.claim === 'string') {
    lines.push(`claim  ${JSON.stringify(excerpt(receipt.claim, 120))}`);
  }
  for (const criterion of receipt.criteria ?? []) {
    lines.push(`${criterion.verdict.padEnd(6)}${criterion.id} — ${criterion.reason}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The §4.12 `receipt show --json` object. */
export function showJson(
  receipt: Receipt,
  expected: string,
  actual: string,
  valid: boolean,
): Record<string, unknown> {
  return { sealValid: valid, expected, actual, receipt };
}
