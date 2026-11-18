import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runCountDirCheck, runCountFileCheck } from '../../../src/checks/count.js';
import type { CountDirCriterion, CountFileCriterion } from '../../../src/types.js';
import { makeTempDir } from '../../helpers/repo.js';
import { makeCtx } from './helpers.js';

async function setup(): Promise<{ dir: string; cleanup(): void }> {
  const temp = await makeTempDir();
  fs.mkdirSync(path.join(temp.dir, 'files/nested'), { recursive: true });
  fs.mkdirSync(path.join(temp.dir, 'files/.git'), { recursive: true });
  fs.writeFileSync(path.join(temp.dir, 'files/a.txt'), 'a');
  fs.writeFileSync(path.join(temp.dir, 'files/b.txt'), 'b');
  fs.writeFileSync(path.join(temp.dir, 'files/nested/c.txt'), 'c');
  fs.writeFileSync(path.join(temp.dir, 'files/.git/ignored.txt'), 'g');
  return temp;
}

function dirCheck(c: Omit<CountDirCriterion, 'id' | 'type'>, root: string) {
  return runCountDirCheck({ id: 'c', type: 'count', ...c }, makeCtx(root));
}

function fileCheck(c: Omit<CountFileCriterion, 'id' | 'type'>, root: string) {
  return runCountFileCheck({ id: 'c', type: 'count', ...c }, makeCtx(root));
}

test('count dir: the default **/* counts every file at any depth and skips .git', async () => {
  const dir = await setup();
  try {
    const r = await dirCheck({ dir: 'files', min: 1 }, dir.dir);
    assert.equal(r.verdict, 'PASS');
    assert.match(r.evidence, /^3 files/);
  } finally {
    dir.cleanup();
  }
});

test('count dir: * counts top-level files only', async () => {
  const dir = await setup();
  try {
    const r = await dirCheck({ dir: 'files', glob: '*', exact: 2 }, dir.dir);
    assert.equal(r.verdict, 'PASS');
  } finally {
    dir.cleanup();
  }
});

test('count dir: symlinks are not followed or counted', async (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink creation needs privileges on Windows');
    return;
  }
  const dir = await setup();
  try {
    fs.symlinkSync(path.join(dir.dir, 'files/a.txt'), path.join(dir.dir, 'files/link.txt'));
    const r = await dirCheck({ dir: 'files', exact: 3 }, dir.dir);
    assert.equal(r.verdict, 'PASS');
  } finally {
    dir.cleanup();
  }
});

test('count dir: a missing directory counts 0 and passes a max-only range', async () => {
  const dir = await setup();
  try {
    const r = await dirCheck({ dir: 'absent', max: 5 }, dir.dir);
    assert.equal(r.verdict, 'PASS');
    assert.match(r.evidence, /does not exist/);
  } finally {
    dir.cleanup();
  }
});

test('count dir: a missing directory fails a min-only range', async () => {
  const dir = await setup();
  try {
    const r = await dirCheck({ dir: 'absent', min: 1 }, dir.dir);
    assert.equal(r.verdict, 'FAIL');
    assert.match(r.reason, /^0 files, expected ≥ 1/);
  } finally {
    dir.cleanup();
  }
});

test('count dir: an out-of-range count FAILs', async () => {
  const dir = await setup();
  try {
    const r = await dirCheck({ dir: 'files', min: 10 }, dir.dir);
    assert.equal(r.verdict, 'FAIL');
  } finally {
    dir.cleanup();
  }
});

test('count dir: a file instead of a directory FAILs', async () => {
  const dir = await setup();
  try {
    const r = await dirCheck({ dir: 'files/a.txt', min: 1 }, dir.dir);
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, 'not a directory');
  } finally {
    dir.cleanup();
  }
});

test('count dir: an unreadable directory is UNVERIFIED', async (t) => {
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
    fs.chmodSync(path.join(dir.dir, 'files'), 0o000);
    const r = await dirCheck({ dir: 'files', min: 1 }, dir.dir);
    assert.equal(r.verdict, 'UNVERIFIED');
    assert.match(r.reason, /unreadable: EACCES/);
  } finally {
    fs.chmodSync(path.join(dir.dir, 'files'), 0o755);
    dir.cleanup();
  }
});

test('count file: lines counts non-empty lines', async () => {
  const dir = await setup();
  try {
    fs.writeFileSync(path.join(dir.dir, 'lines.txt'), 'a\n\nb\n \nc\n');
    const r = await fileCheck({ file: 'lines.txt', unit: 'lines', exact: 3 }, dir.dir);
    assert.equal(r.verdict, 'PASS');
  } finally {
    dir.cleanup();
  }
});

test('count file: csv-rows subtracts the header', async () => {
  const dir = await setup();
  try {
    fs.writeFileSync(path.join(dir.dir, 'rows.csv'), 'id,name\n1,a\n2,b\n');
    const r = await fileCheck({ file: 'rows.csv', unit: 'csv-rows', exact: 2 }, dir.dir);
    assert.equal(r.verdict, 'PASS');
    assert.match(r.reason, /2 csv rows/);
  } finally {
    dir.cleanup();
  }
});

test('count file: csv-rows floors at zero for a header-only file', async () => {
  const dir = await setup();
  try {
    fs.writeFileSync(path.join(dir.dir, 'rows.csv'), 'id,name\n');
    const r = await fileCheck({ file: 'rows.csv', unit: 'csv-rows', exact: 0 }, dir.dir);
    assert.equal(r.verdict, 'PASS');
  } finally {
    dir.cleanup();
  }
});

test('count file: jsonl counts valid records', async () => {
  const dir = await setup();
  try {
    fs.writeFileSync(path.join(dir.dir, 'x.jsonl'), '{"a":1}\n{"a":2}\n\n{"a":3}\n');
    const r = await fileCheck({ file: 'x.jsonl', unit: 'jsonl', exact: 3 }, dir.dir);
    assert.equal(r.verdict, 'PASS');
  } finally {
    dir.cleanup();
  }
});

test('count file: an invalid jsonl line names the line number', async () => {
  const dir = await setup();
  try {
    fs.writeFileSync(path.join(dir.dir, 'x.jsonl'), '{"a":1}\nnot json\n');
    const r = await fileCheck({ file: 'x.jsonl', unit: 'jsonl', min: 1 }, dir.dir);
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, 'line 2 is not valid JSON');
  } finally {
    dir.cleanup();
  }
});

test('count file: a missing file counts 0 and passes an exact-0 range', async () => {
  const dir = await setup();
  try {
    const r = await fileCheck({ file: 'absent.csv', unit: 'csv-rows', exact: 0 }, dir.dir);
    assert.equal(r.verdict, 'PASS');
    assert.match(r.evidence, /does not exist/);
  } finally {
    dir.cleanup();
  }
});
