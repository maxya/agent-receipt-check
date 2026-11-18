import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { resolvePointer, runJsonCheck } from '../../../src/checks/json.js';
import type { JsonCriterion } from '../../../src/types.js';
import { makeTempDir } from '../../helpers/repo.js';
import { makeCtx } from './helpers.js';

async function setup(files: Record<string, string>): Promise<{ dir: string; cleanup(): void }> {
  const temp = await makeTempDir();
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(temp.dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return temp;
}

function criterion(c: Omit<JsonCriterion, 'id' | 'type'>, root: string) {
  return runJsonCheck({ id: 'j', type: 'json', ...c }, makeCtx(root));
}

test('json: equals ignores key order', async () => {
  const dir = await setup({ 'x.json': '{"a":1,"b":{"c":2,"d":3}}' });
  try {
    const r = await criterion(
      { file: 'x.json', pointer: '', equals: { b: { d: 3, c: 2 }, a: 1 } },
      dir.dir,
    );
    assert.equal(r.verdict, 'PASS');
  } finally {
    dir.cleanup();
  }
});

test('json: exists on a nested pointer', async () => {
  const dir = await setup({ 'x.json': '{"a":{"b":null}}' });
  try {
    const r = await criterion({ file: 'x.json', pointer: '/a/b', exists: true }, dir.dir);
    assert.equal(r.verdict, 'PASS');
  } finally {
    dir.cleanup();
  }
});

test('json: exists:false passes for a missing pointer', async () => {
  const dir = await setup({ 'x.json': '{"a":1}' });
  try {
    const r = await criterion({ file: 'x.json', pointer: '/nope', exists: false }, dir.dir);
    assert.equal(r.verdict, 'PASS');
  } finally {
    dir.cleanup();
  }
});

test('json: is:"array"', async () => {
  const dir = await setup({ 'x.json': '{"rows":[1,2,3]}' });
  try {
    const r = await criterion({ file: 'x.json', pointer: '/rows', is: 'array' }, dir.dir);
    assert.equal(r.verdict, 'PASS');
  } finally {
    dir.cleanup();
  }
});

test('json: a length range applies to arrays', async () => {
  const dir = await setup({ 'x.json': '{"rows":[1,2]}' });
  try {
    const r = await criterion({ file: 'x.json', pointer: '/rows', min: 3 }, dir.dir);
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, '/rows is 2, expected ≥ 3');
  } finally {
    dir.cleanup();
  }
});

test('json: a missing file FAILs', async () => {
  const dir = await setup({});
  try {
    const r = await criterion({ file: 'nope.json', pointer: '', exists: true }, dir.dir);
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, 'missing');
  } finally {
    dir.cleanup();
  }
});

test('json: invalid JSON FAILs with the parse message', async () => {
  const dir = await setup({ 'x.json': '{not json' });
  try {
    const r = await criterion({ file: 'x.json', pointer: '', exists: true }, dir.dir);
    assert.equal(r.verdict, 'FAIL');
    assert.match(r.reason, /^not valid JSON: /);
  } finally {
    dir.cleanup();
  }
});

test('json: a missing pointer FAILs', async () => {
  const dir = await setup({ 'x.json': '{"a":1}' });
  try {
    const r = await criterion({ file: 'x.json', pointer: '/b', equals: 1 }, dir.dir);
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, 'pointer /b not found');
  } finally {
    dir.cleanup();
  }
});

test('json: a wrong value shows the actual and expected', async () => {
  const dir = await setup({ 'x.json': '{"count":0}' });
  try {
    const r = await criterion({ file: 'x.json', pointer: '/count', equals: 100 }, dir.dir);
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, '/count is 0, expected 100');
  } finally {
    dir.cleanup();
  }
});

test('json: pointer escapes ~0 and ~1', async () => {
  const dir = await setup({ 'x.json': '{"a/b":{"c~d":5}}' });
  try {
    const r = await criterion({ file: 'x.json', pointer: '/a~1b/c~0d', equals: 5 }, dir.dir);
    assert.equal(r.verdict, 'PASS');
  } finally {
    dir.cleanup();
  }
});

test('json: a file over 50 MiB is UNVERIFIED', async () => {
  const dir = await setup({});
  try {
    const big = path.join(dir.dir, 'big.json');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, 51 * 1024 * 1024);
    const r = await criterion({ file: 'big.json', pointer: '', exists: true }, dir.dir);
    assert.equal(r.verdict, 'UNVERIFIED');
    assert.equal(r.reason, 'too large');
  } finally {
    dir.cleanup();
  }
});

test('resolvePointer handles arrays and rejects non-index tokens', () => {
  const doc = { rows: [{ a: 1 }] };
  assert.deepEqual(resolvePointer(doc, '/rows/0/a'), { found: true, value: 1 });
  assert.equal(resolvePointer(doc, '/rows/01').found, false);
  assert.equal(resolvePointer(doc, '/rows/-').found, false);
  assert.equal(resolvePointer(doc, '').found, true);
});
