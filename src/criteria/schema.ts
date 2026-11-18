import { isAbsoluteAny, resolveInRoot } from '../paths.js';
import type { Criterion } from '../types.js';

export interface ValidateOptions {
  root: string;
  label?: string;
}

export interface ValidatedCriteria {
  version: 1;
  claim: string | null;
  criteria: Criterion[];
}

export interface ValidationResult {
  ok: boolean;
  value: ValidatedCriteria | null;
  errors: string[];
}

const TYPES = new Set(['test', 'file', 'diff', 'http', 'count', 'json']);
const JSON_TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'null',
  'array',
  'object',
]);
const UNITS = new Set(['lines', 'csv-rows', 'jsonl']);

const COMMON = ['id', 'type', 'description'];
const TYPE_KEYS: Record<string, string[]> = {
  test: ['command', 'cwd', 'timeoutMs', 'expect'],
  file: ['path', 'exists', 'contains', 'notContains', 'matches', 'sha256'],
  diff: ['path', 'changed'],
  http: ['url', 'timeoutMs', 'headers', 'expect'],
  count: ['dir', 'file', 'glob', 'unit', 'min', 'max', 'exact'],
  json: ['file', 'pointer', 'equals', 'exists', 'is', 'min', 'max', 'exact'],
};

const TEST_EXPECT_KEYS = [
  'exit',
  'stdoutContains',
  'stdoutNotContains',
  'stderrContains',
  'stderrNotContains',
];
const HTTP_EXPECT_KEYS = ['status', 'bodyContains', 'bodyNotContains', 'bodyMatches'];
const RANGE_KEYS = ['min', 'max', 'exact'];

interface Ctx {
  root: string;
  fail: (loc: string, msg: string) => void;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function charLength(s: string): number {
  return Array.from(s).length;
}

function reqString(
  obj: Record<string, unknown>,
  key: string,
  loc: string,
  ctx: Ctx,
  max?: number,
): string | null {
  if (!(key in obj)) {
    ctx.fail(`${loc}.${key}`, 'is required');
    return null;
  }
  const v = obj[key];
  if (typeof v !== 'string') {
    ctx.fail(`${loc}.${key}`, 'must be a string');
    return null;
  }
  if (max !== undefined && charLength(v) > max) {
    ctx.fail(`${loc}.${key}`, `must be at most ${max} characters`);
    return null;
  }
  return v;
}

function optString(
  obj: Record<string, unknown>,
  key: string,
  loc: string,
  ctx: Ctx,
  max?: number,
): string | undefined {
  if (!(key in obj)) return undefined;
  const v = obj[key];
  if (typeof v !== 'string') {
    ctx.fail(`${loc}.${key}`, 'must be a string');
    return undefined;
  }
  if (max !== undefined && charLength(v) > max) {
    ctx.fail(`${loc}.${key}`, `must be at most ${max} characters`);
    return undefined;
  }
  return v;
}

function optBool(
  obj: Record<string, unknown>,
  key: string,
  loc: string,
  ctx: Ctx,
): boolean | undefined {
  if (!(key in obj)) return undefined;
  const v = obj[key];
  if (typeof v !== 'boolean') {
    ctx.fail(`${loc}.${key}`, 'must be a boolean');
    return undefined;
  }
  return v;
}

function intValue(
  value: unknown,
  loc: string,
  ctx: Ctx,
  opts: { min?: number; max?: number; nonNegative?: boolean } = {},
): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      ctx.fail(loc, 'non-integer numbers are not supported in v1');
    } else {
      ctx.fail(loc, 'must be an integer');
    }
    return null;
  }
  if (opts.nonNegative && value < 0) {
    ctx.fail(loc, 'must be a non-negative integer');
    return null;
  }
  if (opts.min !== undefined && value < opts.min) {
    ctx.fail(loc, `must be at least ${opts.min}`);
    return null;
  }
  if (opts.max !== undefined && value > opts.max) {
    ctx.fail(loc, `must be at most ${opts.max}`);
    return null;
  }
  return value;
}

function optInt(
  obj: Record<string, unknown>,
  key: string,
  loc: string,
  ctx: Ctx,
  opts: { min?: number; max?: number; nonNegative?: boolean } = {},
): number | undefined {
  if (!(key in obj)) return undefined;
  const n = intValue(obj[key], `${loc}.${key}`, ctx, opts);
  return n === null ? undefined : n;
}

function validateRange(
  obj: Record<string, unknown>,
  loc: string,
  ctx: Ctx,
  required: boolean,
): void {
  const hasMin = 'min' in obj;
  const hasMax = 'max' in obj;
  const hasExact = 'exact' in obj;
  if (!hasMin && !hasMax && !hasExact) {
    if (required) ctx.fail(`${loc}.min`, 'one of min/max/exact is required');
    return;
  }
  const min = optInt(obj, 'min', loc, ctx, { nonNegative: true });
  const max = optInt(obj, 'max', loc, ctx, { nonNegative: true });
  optInt(obj, 'exact', loc, ctx, { nonNegative: true });
  if (hasExact && (hasMin || hasMax)) {
    ctx.fail(`${loc}.exact`, 'cannot be combined with min/max');
  }
  if (min !== undefined && max !== undefined && min > max) {
    ctx.fail(`${loc}.min`, 'must not be greater than max');
  }
}

function strOrList(
  obj: Record<string, unknown>,
  key: string,
  loc: string,
  ctx: Ctx,
): void {
  if (!(key in obj)) return;
  const v = obj[key];
  if (typeof v === 'string') return;
  if (Array.isArray(v)) {
    if (v.length === 0) {
      ctx.fail(`${loc}.${key}`, 'must not be an empty array');
      return;
    }
    for (let i = 0; i < v.length; i++) {
      if (typeof v[i] !== 'string') ctx.fail(`${loc}.${key}[${i}]`, 'must be a string');
    }
    return;
  }
  ctx.fail(`${loc}.${key}`, 'must be a string or an array of strings');
}

function regexField(
  obj: Record<string, unknown>,
  key: string,
  loc: string,
  ctx: Ctx,
): void {
  if (!(key in obj)) return;
  const v = obj[key];
  if (typeof v !== 'string') {
    ctx.fail(`${loc}.${key}`, 'must be a string');
    return;
  }
  try {
    new RegExp(v, 'mu');
  } catch (err) {
    ctx.fail(`${loc}.${key}`, `invalid regex: ${(err as Error).message}`);
  }
}

function relativePath(value: string, loc: string, ctx: Ctx): void {
  if (value.length === 0) {
    ctx.fail(loc, 'must not be empty');
    return;
  }
  if (value.includes('\0')) {
    ctx.fail(loc, 'must not contain NUL');
    return;
  }
  if (isAbsoluteAny(value)) {
    ctx.fail(loc, 'must be a relative path');
    return;
  }
  try {
    resolveInRoot(ctx.root, value);
  } catch (err) {
    ctx.fail(loc, (err as Error).message);
  }
}

function validatePathField(
  obj: Record<string, unknown>,
  key: string,
  loc: string,
  ctx: Ctx,
): void {
  const v = reqString(obj, key, loc, ctx);
  if (v !== null) relativePath(v, `${loc}.${key}`, ctx);
}

function checkKeys(
  obj: Record<string, unknown>,
  allowed: string[],
  loc: string,
  ctx: Ctx,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) ctx.fail(loc, `unknown key ${JSON.stringify(key)}`);
  }
}

function checkSafeIntegers(value: unknown, loc: string, ctx: Ctx): void {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      ctx.fail(loc, 'non-integer numbers are not supported in v1');
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      checkSafeIntegers(value[i], `${loc}[${i}]`, ctx);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      checkSafeIntegers(v, loc === '' ? k : `${loc}.${k}`, ctx);
    }
  }
}

function validatePointer(pointer: string, loc: string, ctx: Ctx): void {
  if (pointer === '') return;
  if (!pointer.startsWith('/')) {
    ctx.fail(loc, 'must be empty or start with "/"');
    return;
  }
  for (const rawToken of pointer.slice(1).split('/')) {
    for (let i = 0; i < rawToken.length; i++) {
      if (rawToken[i] === '~' && rawToken[i + 1] !== '0' && rawToken[i + 1] !== '1') {
        ctx.fail(loc, 'invalid RFC 6901 escape (only ~0 and ~1 are allowed)');
        return;
      }
    }
  }
}

function validateTestExpect(
  obj: Record<string, unknown>,
  loc: string,
  ctx: Ctx,
): void {
  if (!('expect' in obj)) return;
  const expect = obj.expect;
  if (!isPlainObject(expect)) {
    ctx.fail(`${loc}.expect`, 'must be an object');
    return;
  }
  const eloc = `${loc}.expect`;
  checkKeys(expect, TEST_EXPECT_KEYS, eloc, ctx);
  if ('exit' in expect) intValue(expect.exit, `${eloc}.exit`, ctx);
  for (const key of ['stdoutContains', 'stdoutNotContains', 'stderrContains', 'stderrNotContains']) {
    strOrList(expect, key, eloc, ctx);
  }
}

function validateHttpHeaders(
  obj: Record<string, unknown>,
  loc: string,
  ctx: Ctx,
): void {
  if (!('headers' in obj)) return;
  const headers = obj.headers;
  if (!isPlainObject(headers)) {
    ctx.fail(`${loc}.headers`, 'must be an object');
    return;
  }
  for (const [name, value] of Object.entries(headers)) {
    const hloc = `${loc}.headers.${name}`;
    if (name.length === 0) ctx.fail(hloc, 'header name must not be empty');
    if (typeof value === 'string') continue;
    if (!isPlainObject(value)) {
      ctx.fail(hloc, 'must be a string or { "env": "VAR_NAME" }');
      continue;
    }
    checkKeys(value, ['env'], hloc, ctx);
    if (!('env' in value)) {
      ctx.fail(hloc, 'must contain "env"');
    } else if (typeof value.env !== 'string' || value.env.length === 0) {
      ctx.fail(`${hloc}.env`, 'must be a non-empty string');
    }
  }
}

function validateHttpExpect(
  obj: Record<string, unknown>,
  loc: string,
  ctx: Ctx,
): void {
  if (!('expect' in obj)) return;
  const expect = obj.expect;
  if (!isPlainObject(expect)) {
    ctx.fail(`${loc}.expect`, 'must be an object');
    return;
  }
  const eloc = `${loc}.expect`;
  checkKeys(expect, HTTP_EXPECT_KEYS, eloc, ctx);
  if ('status' in expect) {
    const status = expect.status;
    if (Array.isArray(status)) {
      if (status.length === 0) ctx.fail(`${eloc}.status`, 'must not be an empty array');
      for (let i = 0; i < status.length; i++) {
        intValue(status[i], `${eloc}.status[${i}]`, ctx);
      }
    } else {
      intValue(status, `${eloc}.status`, ctx);
    }
  }
  strOrList(expect, 'bodyContains', eloc, ctx);
  strOrList(expect, 'bodyNotContains', eloc, ctx);
  regexField(expect, 'bodyMatches', eloc, ctx);
}

function validateCriterion(
  raw: unknown,
  index: number,
  ctx: Ctx,
): Criterion | null {
  let loc = `criteria[${index}]`;
  if (!isPlainObject(raw)) {
    ctx.fail(loc, 'must be an object');
    return null;
  }
  if (typeof raw.id === 'string') loc = `criteria[${index}] (${JSON.stringify(raw.id)})`;

  const id = reqString(raw, 'id', loc, ctx);
  if (id !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) {
    ctx.fail(`${loc}.id`, 'must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');
  }
  optString(raw, 'description', loc, ctx, 500);

  const type = reqString(raw, 'type', loc, ctx);
  if (type === null) return null;
  if (!TYPES.has(type)) {
    ctx.fail(`${loc}.type`, 'must be one of test, file, diff, http, count, json');
    return null;
  }

  checkKeys(raw, [...COMMON, ...(TYPE_KEYS[type] ?? [])], loc, ctx);

  switch (type) {
    case 'test': {
      reqString(raw, 'command', loc, ctx);
      if ('cwd' in raw) {
        const cwd = reqString(raw, 'cwd', loc, ctx);
        if (cwd !== null) relativePath(cwd, `${loc}.cwd`, ctx);
      }
      optInt(raw, 'timeoutMs', loc, ctx, { min: 100, max: 3_600_000 });
      validateTestExpect(raw, loc, ctx);
      break;
    }
    case 'file': {
      validatePathField(raw, 'path', loc, ctx);
      const exists = optBool(raw, 'exists', loc, ctx);
      strOrList(raw, 'contains', loc, ctx);
      strOrList(raw, 'notContains', loc, ctx);
      regexField(raw, 'matches', loc, ctx);
      if ('sha256' in raw) {
        const digest = reqString(raw, 'sha256', loc, ctx);
        if (digest !== null) {
          if (!/^[a-fA-F0-9]{64}$/.test(digest)) {
            ctx.fail(`${loc}.sha256`, 'must be 64 hex characters');
          } else {
            raw.sha256 = digest.toLowerCase();
          }
        }
      }
      if (exists === false) {
        for (const key of ['contains', 'notContains', 'matches', 'sha256']) {
          if (key in raw) ctx.fail(`${loc}.${key}`, 'is not allowed when exists is false');
        }
      }
      break;
    }
    case 'diff': {
      validatePathField(raw, 'path', loc, ctx);
      optBool(raw, 'changed', loc, ctx);
      break;
    }
    case 'http': {
      const url = reqString(raw, 'url', loc, ctx);
      if (url !== null) {
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            ctx.fail(`${loc}.url`, 'must be an http or https URL');
          }
        } catch {
          ctx.fail(`${loc}.url`, 'must be a valid URL');
        }
      }
      optInt(raw, 'timeoutMs', loc, ctx, { min: 100, max: 3_600_000 });
      validateHttpHeaders(raw, loc, ctx);
      validateHttpExpect(raw, loc, ctx);
      break;
    }
    case 'count': {
      const hasDir = 'dir' in raw;
      const hasFile = 'file' in raw;
      if (hasDir === hasFile) {
        ctx.fail(loc, 'exactly one of dir or file is required');
      }
      if (hasDir) {
        validatePathField(raw, 'dir', loc, ctx);
        if ('glob' in raw) {
          const g = reqString(raw, 'glob', loc, ctx);
          if (g !== null && g.length === 0) ctx.fail(`${loc}.glob`, 'must not be empty');
        }
      }
      if (hasFile) {
        validatePathField(raw, 'file', loc, ctx);
        const unit = reqString(raw, 'unit', loc, ctx);
        if (unit !== null && !UNITS.has(unit)) {
          ctx.fail(`${loc}.unit`, 'must be one of lines, csv-rows, jsonl');
        }
      }
      validateRange(raw, loc, ctx, true);
      break;
    }
    case 'json': {
      validatePathField(raw, 'file', loc, ctx);
      const pointer = reqString(raw, 'pointer', loc, ctx);
      if (pointer !== null) validatePointer(pointer, `${loc}.pointer`, ctx);
      optBool(raw, 'exists', loc, ctx);
      if ('is' in raw) {
        const is = reqString(raw, 'is', loc, ctx);
        if (is !== null && !JSON_TYPES.has(is)) {
          ctx.fail(`${loc}.is`, 'must be one of string, number, integer, boolean, null, array, object');
        }
      }
      const assertions =
        Number('equals' in raw) +
        Number('exists' in raw) +
        Number('is' in raw) +
        Number(RANGE_KEYS.some((k) => k in raw));
      if (assertions !== 1) {
        ctx.fail(loc, 'exactly one assertion of equals, exists, is or min/max/exact is required');
      }
      if (RANGE_KEYS.some((k) => k in raw)) validateRange(raw, loc, ctx, false);
      break;
    }
  }
  return raw as unknown as Criterion;
}

export function validateCriteriaBytes(bytes: Buffer, opts: ValidateOptions): ValidationResult {
  const label = opts.label ?? 'criteria.json';
  const errors: string[] = [];
  const fail = (loc: string, msg: string): void => {
    errors.push(loc === '' ? `${label}: ${msg}` : `${label}: ${loc}: ${msg}`);
  };
  const ctx: Ctx = { root: opts.root, fail };

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, value: null, errors: [`${label}: file is not valid UTF-8`] };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      value: null,
      errors: [`${label}: invalid JSON: ${(err as Error).message}`],
    };
  }

  if (!isPlainObject(raw)) {
    return { ok: false, value: null, errors: [`${label}: top level must be a JSON object`] };
  }

  checkSafeIntegers(raw, '', ctx);
  checkKeys(raw, ['version', 'claim', 'criteria'], '', ctx);

  const version = raw.version;
  if (!('version' in raw)) fail('', 'version is required');
  else if (version !== 1) fail('version', 'must be 1');

  if ('claim' in raw) optString(raw, 'claim', '', ctx, 2000);

  let criteria: Criterion[] = [];
  if (!('criteria' in raw)) {
    fail('', 'criteria is required');
  } else if (!Array.isArray(raw.criteria)) {
    fail('criteria', 'must be an array');
  } else if (raw.criteria.length === 0) {
    fail('criteria', 'must not be empty');
  } else if (raw.criteria.length > 200) {
    fail('criteria', 'must contain at most 200 items');
  } else {
    const seen = new Set<string>();
    const validated: Criterion[] = [];
    for (let i = 0; i < raw.criteria.length; i++) {
      const criterion = validateCriterion(raw.criteria[i], i, ctx);
      if (criterion !== null) {
        if (seen.has(criterion.id)) {
          fail(`criteria[${i}] (${JSON.stringify(criterion.id)})`, 'duplicate id');
        } else {
          seen.add(criterion.id);
        }
        validated.push(criterion);
      }
    }
    criteria = validated;
  }

  if (errors.length > 0) return { ok: false, value: null, errors };

  const claim = typeof raw.claim === 'string' ? raw.claim : null;
  return {
    ok: true,
    value: { version: 1, claim, criteria },
    errors: [],
  };
}
