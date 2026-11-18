import { createHash } from 'node:crypto';

/** Sort strings by Unicode code point, the same order Python's `sort_keys=True` uses. */
export function byCodePoint(a: string, b: string): number {
  const A = Array.from(a);
  const B = Array.from(b);
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const d = A[i]!.codePointAt(0)! - B[i]!.codePointAt(0)!;
    if (d) return d;
  }
  return A.length - B.length;
}

/**
 * Canonical JSON: sorted keys (code-point order), no whitespace, JSON string escaping,
 * integers only. Matches Python's `json.dumps(v, sort_keys=True, separators=(',',':'),
 * ensure_ascii=False)` for the values a receipt can hold.
 */
export function canonicalize(v: unknown): string {
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'boolean' || t === 'string') return JSON.stringify(v);
  if (t === 'number') {
    const n = v as number;
    if (!Number.isFinite(n)) throw new Error('non-finite number in receipt');
    if (!Number.isSafeInteger(n)) throw new Error('non-integer number in receipt');
    return JSON.stringify(n);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  if (t === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort(byCodePoint);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(',')}}`;
  }
  throw new Error(`cannot canonicalize ${t}`);
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

function roundTrip(obj: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(obj)) as Record<string, unknown>;
}

/** Add a seal over the canonical bytes of `obj` (with any existing `sha256` excluded). */
export function seal<T extends Record<string, unknown>>(obj: T): T & { sha256: string } {
  const clean = roundTrip(obj);
  delete clean.sha256;
  const sha256 = sha256Hex(canonicalize(clean));
  return { ...(clean as T), sha256 };
}

export interface SealCheck {
  valid: boolean;
  expected: string;
  actual: string;
}

/** Compare a stored seal (`expected`) with the seal computed from the object's contents. */
export function verifySeal(obj: Record<string, unknown>): SealCheck {
  const expected = typeof obj.sha256 === 'string' ? obj.sha256 : '';
  const clean = roundTrip(obj);
  delete clean.sha256;
  const actual = sha256Hex(canonicalize(clean));
  return { valid: expected !== '' && expected === actual, expected, actual };
}
