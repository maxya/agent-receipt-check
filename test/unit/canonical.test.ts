import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  byCodePoint,
  canonicalize,
  seal,
  sha256Hex,
  verifySeal,
} from '../../src/canonical.js';

const golden = {
  schema: 1,
  claim: 'h\u00e9llo \u2028 \u007f \u0001 "q" \u65e5\u672c \ud83d\ude00',
  z: [3, true, null],
  a: { b: 'x\n\t' },
};

test('golden canonical hash matches the cross-checked Python value', () => {
  assert.equal(
    sha256Hex(canonicalize(golden)),
    '89cb84feb1ae320a22054005a470ea46f21a4cddcf63e66aa585c66a17f84371',
  );
});

test('key order does not change the canonical form', () => {
  const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
  const b = { c: { y: 2, z: 1 }, a: 2, b: 1 };
  assert.equal(canonicalize(a), canonicalize(b));
});

test('nested arrays and mixed scalars', () => {
  assert.equal(
    canonicalize({ x: [1, [2, { b: true, a: null }]] }),
    '{"x":[1,[2,{"a":null,"b":true}]]}',
  );
});

test('undefined object keys are dropped', () => {
  assert.equal(canonicalize({ a: 1, b: undefined }), '{"a":1}');
});

test('non-integers and non-finite numbers throw', () => {
  assert.throws(() => canonicalize({ n: 1.5 }), /non-integer/);
  assert.throws(() => canonicalize({ n: NaN }), /non-finite/);
  assert.throws(() => canonicalize({ n: Infinity }), /non-finite/);
});

test('keys sort by code point, not UTF-16 code unit', () => {
  assert.ok(byCodePoint('\uff61', '\ud83d\ude00') < 0);
  const text = canonicalize({ '\ud83d\ude00': 2, '\uff61': 1 });
  assert.equal(text, '{"\uff61":1,"\ud83d\ude00":2}');
});

test('seal verifies and a one-character change breaks it', () => {
  const sealed = seal({ schema: 1, verdict: 'PASS', n: 1 });
  assert.equal(typeof sealed.sha256, 'string');
  assert.equal(sealed.sha256.length, 64);
  const good = verifySeal(sealed as unknown as Record<string, unknown>);
  assert.equal(good.valid, true);

  const bad = verifySeal({ ...sealed, verdict: 'FAIL' });
  assert.equal(bad.valid, false);
  assert.notEqual(bad.expected, bad.actual);
});

test('seal is stable across a JSON round-trip', () => {
  const sealed = seal({ a: [1, 2], b: '\u2028' });
  const reparsed = JSON.parse(JSON.stringify(sealed)) as Record<string, unknown>;
  assert.equal(verifySeal(reparsed).valid, true);
});

test('Python can re-check the seal (skipped when python3 is absent)', (t) => {
  let python: string | null = null;
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    python = 'python3';
  } catch {
    python = null;
  }
  if (python === null) {
    t.skip('python3 not on PATH');
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'arc-canonical-'));
  try {
    const sealed = seal({
      schema: 1,
      claim: 'h\u00e9llo \u2028 \ud83d\ude00',
      '\uff61': 1,
      '\ud83d\ude00': 2,
    });
    const file = path.join(dir, 'receipt.json');
    writeFileSync(file, `${JSON.stringify(sealed, null, 2)}\n`);
    const script =
      "import json,sys,hashlib;d=json.load(open(sys.argv[1],encoding='utf-8'));s=d.pop('sha256');" +
      "c=hashlib.sha256(json.dumps(d,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest();" +
      "print('OK' if c==s else 'BROKEN',c)";
    const out = execFileSync(python, ['-c', script, file], { encoding: 'utf8' }).trim();
    assert.ok(out.startsWith('OK'), out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
