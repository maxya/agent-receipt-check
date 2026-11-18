import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runFileCheck } from '../../../src/checks/file.js';
import type { FileCriterion } from '../../../src/types.js';
import { makeTempDir } from '../../helpers/repo.js';
import { makeCtx } from './helpers.js';

async function setup(): Promise<{ dir: string; cleanup(): void }> {
  const temp = await makeTempDir();
  fs.writeFileSync(path.join(temp.dir, 'hello.txt'), 'hello world\nsecond line\n');
  fs.mkdirSync(path.join(temp.dir, 'sub'));
  fs.writeFileSync(path.join(temp.dir, 'empty.txt'), '');
  return temp;
}

function criterion(c: Omit<FileCriterion, 'id' | 'type'>, root: string) {
  return runFileCheck({ id: 'f', type: 'file', ...c }, makeCtx(root));
}

test('file: PASS when it exists', async () => {
  const dir = await setup();
  try {
    const r = await criterion({ path: 'hello.txt' }, dir.dir);
    assert.equal(r.verdict, 'PASS');
    assert.match(r.evidence, /^24 bytes, sha256 [0-9a-f]{12}…$/);
  } finally {
    dir.cleanup();
  }
});

test('file: PASS on contains', async () => {
  const dir = await setup();
  try {
    const r = await criterion({ path: 'hello.txt', contains: ['hello', 'second'] }, dir.dir);
    assert.equal(r.verdict, 'PASS');
  } finally {
    dir.cleanup();
  }
});

test('file: PASS on matches', async () => {
  const dir = await setup();
  try {
    const r = await criterion({ path: 'hello.txt', matches: '^second line$' }, dir.dir);
    assert.equal(r.verdict, 'PASS');
  } finally {
    dir.cleanup();
  }
});

test('file: PASS on sha256', async () => {
  const dir = await setup();
  try {
    const sha = createHash('sha256').update('hello world\nsecond line\n').digest('hex');
    const r = await criterion({ path: 'hello.txt', sha256: sha }, dir.dir);
    assert.equal(r.verdict, 'PASS');
  } finally {
    dir.cleanup();
  }
});

test('file: exists:false PASSes when absent', async () => {
  const dir = await setup();
  try {
    const r = await criterion({ path: 'nope.txt', exists: false }, dir.dir);
    assert.equal(r.verdict, 'PASS');
    assert.equal(r.reason, 'absent as expected');
  } finally {
    dir.cleanup();
  }
});

test('file: FAIL when missing', async () => {
  const dir = await setup();
  try {
    const r = await criterion({ path: 'nope.txt' }, dir.dir);
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, 'missing');
  } finally {
    dir.cleanup();
  }
});

test('file: FAIL when it is a directory', async () => {
  const dir = await setup();
  try {
    const r = await criterion({ path: 'sub' }, dir.dir);
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, 'is a directory, expected a file');
  } finally {
    dir.cleanup();
  }
});

test('file: FAIL on a content mismatch', async () => {
  const dir = await setup();
  try {
    const r = await criterion({ path: 'hello.txt', contains: 'goodbye' }, dir.dir);
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, 'missing "goodbye"');
  } finally {
    dir.cleanup();
  }
});

test('file: FAIL when exists:false but present', async () => {
  const dir = await setup();
  try {
    const r = await criterion({ path: 'hello.txt', exists: false }, dir.dir);
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, 'exists');
  } finally {
    dir.cleanup();
  }
});

test('file: UNVERIFIED on an unreadable file', async (t) => {
  if (process.platform === 'win32') {
    t.skip('chmod semantics differ on Windows');
    return;
  }
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root ignores mode bits');
    return;
  }
  const dir = await setup();
  try {
    fs.chmodSync(path.join(dir.dir, 'hello.txt'), 0o000);
    const r = await criterion({ path: 'hello.txt', contains: 'hello' }, dir.dir);
    assert.equal(r.verdict, 'UNVERIFIED');
    assert.match(r.reason, /unreadable: EACCES/);
  } finally {
    dir.cleanup();
  }
});

test('file: UNVERIFIED when a symlink escapes root', async (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink creation needs privileges on Windows');
    return;
  }
  const temp = await makeTempDir();
  try {
    const root = path.join(temp.dir, 'root');
    fs.mkdirSync(root);
    const outside = path.join(temp.dir, 'outside.txt');
    fs.writeFileSync(outside, 'secret');
    fs.symlinkSync(outside, path.join(root, 'link.txt'));
    const r = await criterion({ path: 'link.txt' }, root);
    assert.equal(r.verdict, 'UNVERIFIED');
    assert.equal(r.reason, 'symlink points outside root');
  } finally {
    temp.cleanup();
  }
});

test('file: UNVERIFIED when it is too large to inspect', async () => {
  const dir = await setup();
  try {
    const big = path.join(dir.dir, 'big.bin');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, 51 * 1024 * 1024);
    const r = await criterion({ path: 'big.bin', contains: 'x' }, dir.dir);
    assert.equal(r.verdict, 'UNVERIFIED');
    assert.equal(r.reason, 'too large to inspect');
  } finally {
    dir.cleanup();
  }
});
