import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { isAbsoluteAny, resolveInRoot, safeRealpath, toPosixRel } from '../../src/paths.js';

const root = process.cwd();

test('absolute paths are rejected in POSIX and win32 forms', () => {
  assert.equal(isAbsoluteAny('/etc/passwd'), true);
  assert.equal(isAbsoluteAny('C:\\Windows\\x'), true);
  assert.throws(() => resolveInRoot(root, '/etc/passwd'), /relative/);
  assert.throws(() => resolveInRoot(root, 'C:\\x'), /relative/);
});

test('NUL bytes are rejected', () => {
  assert.throws(() => resolveInRoot(root, 'a\0b'), /NUL/);
});

test('parent escapes are rejected, including lookalike names', () => {
  assert.throws(() => resolveInRoot(root, '../x'), /escapes root/);
  assert.throws(() => resolveInRoot(root, 'a/../../x'), /escapes root/);
  assert.doesNotThrow(() => resolveInRoot(root, '..foo/x'));
  assert.equal(resolveInRoot(root, 'a/b'), path.join(root, 'a/b'));
});

test('toPosixRel uses forward slashes', () => {
  assert.equal(toPosixRel('/r', '/r/a/b'), 'a/b');
});

test('safeRealpath accepts an inside target', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arc-paths-')));
  try {
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'x');
    const result = safeRealpath(dir, file);
    assert.equal(result.ok, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('safeRealpath flags a symlink that escapes root', (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink creation needs privileges on Windows');
    return;
  }
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'arc-paths-')));
  const rootDir = path.join(base, 'root');
  const outside = path.join(base, 'outside.txt');
  fs.mkdirSync(rootDir);
  fs.writeFileSync(outside, 'secret');
  try {
    fs.symlinkSync(outside, path.join(rootDir, 'link.txt'));
    const result = safeRealpath(rootDir, path.join(rootDir, 'link.txt'));
    assert.deepEqual(result, { ok: false, escape: true });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('safeRealpath reports a missing path', () => {
  const result = safeRealpath(root, path.join(root, 'definitely-missing-xyz'));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.escape, false);
});
