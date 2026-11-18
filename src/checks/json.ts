import fs from 'node:fs/promises';
import { canonicalize } from '../canonical.js';
import { resolveInRoot } from '../paths.js';
import type { CheckContext, CheckResult, JsonCriterion, Range } from '../types.js';
import { makeResult } from './common.js';

const MAX_SIZE = 50 * 1024 * 1024;

function ioCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

export interface PointerResult {
  found: boolean;
  value: unknown;
}

/** RFC 6901 pointer resolution (`""` = the whole document). */
export function resolvePointer(doc: unknown, pointer: string): PointerResult {
  if (pointer === '') return { found: true, value: doc };
  let current = doc;
  for (const rawToken of pointer.slice(1).split('/')) {
    const token = rawToken.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return { found: false, value: undefined };
      const index = Number(token);
      if (index >= current.length) return { found: false, value: undefined };
      current = current[index];
    } else if (typeof current === 'object' && current !== null) {
      const obj = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(obj, token)) {
        return { found: false, value: undefined };
      }
      current = obj[token];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: current };
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') {
    return Array.from(value).length <= 40 ? JSON.stringify(value) : `string(${Array.from(value).length} chars)`;
  }
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'object') return `object(${Object.keys(value as object).length} keys)`;
  return typeof value;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  try {
    return canonicalize(a) === canonicalize(b);
  } catch {
    return false;
  }
}

function rangeFailure(pointer: string, value: unknown, c: Range): string | null {
  let target: number | null = null;
  if (typeof value === 'number') target = value;
  else if (Array.isArray(value)) target = value.length;
  else if (typeof value === 'string') target = Array.from(value).length;

  const label = pointer === '' ? '(root)' : pointer;
  if (target === null) {
    return `${label} is ${describe(value)}, expected a number, array or string`;
  }
  if (c.exact !== undefined) {
    return target === c.exact ? null : `${label} is ${target}, expected ${c.exact}`;
  }
  const expectations: string[] = [];
  let bad = false;
  if (c.min !== undefined) {
    expectations.push(`≥ ${c.min}`);
    if (target < c.min) bad = true;
  }
  if (c.max !== undefined) {
    expectations.push(`≤ ${c.max}`);
    if (target > c.max) bad = true;
  }
  return bad ? `${label} is ${target}, expected ${expectations.join(' and ')}` : null;
}

export async function runJsonCheck(c: JsonCriterion, ctx: CheckContext): Promise<CheckResult> {
  const started = Date.now();
  const abs = resolveInRoot(ctx.root, c.file);
  const label = c.pointer === '' ? '(root)' : c.pointer;

  let size: number;
  try {
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) return makeResult('FAIL', '', 'is a directory', started, ctx);
    size = stat.size;
  } catch (err) {
    const code = ioCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return makeResult('FAIL', 'does not exist', 'missing', started, ctx);
    }
    return makeResult('UNVERIFIED', '', `unreadable: ${code}`, started, ctx);
  }

  if (size > MAX_SIZE) {
    return makeResult('UNVERIFIED', `${size} bytes`, 'too large', started, ctx);
  }

  let doc: unknown;
  try {
    const text = await fs.readFile(abs, 'utf8');
    doc = JSON.parse(text);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== undefined && !(err instanceof SyntaxError)) {
      return makeResult('UNVERIFIED', '', `unreadable: ${ioCode(err)}`, started, ctx);
    }
    return makeResult('FAIL', '', `not valid JSON: ${(err as Error).message}`, started, ctx);
  }

  const resolved = resolvePointer(doc, c.pointer);
  const evidence = `${c.file} ${label}`;

  if (c.exists !== undefined) {
    if (resolved.found === c.exists) {
      return makeResult(
        'PASS',
        evidence,
        resolved.found ? `${label} exists` : `${label} is absent`,
        started,
        ctx,
      );
    }
    return makeResult(
      'FAIL',
      evidence,
      resolved.found ? `${label} exists` : `pointer ${label} not found`,
      started,
      ctx,
    );
  }

  if (!resolved.found) {
    return makeResult('FAIL', evidence, `pointer ${label} not found`, started, ctx);
  }

  if ('equals' in c && c.equals !== undefined) {
    if (deepEqual(resolved.value, c.equals)) {
      return makeResult('PASS', evidence, `${label} = ${describe(resolved.value)}`, started, ctx);
    }
    return makeResult(
      'FAIL',
      evidence,
      `${label} is ${describe(resolved.value)}, expected ${describe(c.equals)}`,
      started,
      ctx,
    );
  }

  if (c.is !== undefined) {
    const value = resolved.value;
    let ok: boolean;
    switch (c.is) {
      case 'integer':
        ok = typeof value === 'number' && Number.isInteger(value);
        break;
      case 'number':
        ok = typeof value === 'number';
        break;
      case 'null':
        ok = value === null;
        break;
      case 'array':
        ok = Array.isArray(value);
        break;
      case 'object':
        ok = typeof value === 'object' && value !== null && !Array.isArray(value);
        break;
      default:
        ok = typeof value === c.is;
    }
    if (ok) {
      return makeResult('PASS', evidence, `${label} is ${c.is}`, started, ctx);
    }
    return makeResult(
      'FAIL',
      evidence,
      `${label} is ${typeName(value)}, expected ${c.is}`,
      started,
      ctx,
    );
  }

  const failure = rangeFailure(c.pointer, resolved.value, c);
  if (failure !== null) return makeResult('FAIL', evidence, failure, started, ctx);
  return makeResult('PASS', evidence, `${label} = ${describe(resolved.value)}`, started, ctx);
}
