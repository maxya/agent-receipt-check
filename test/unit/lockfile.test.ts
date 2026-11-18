import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { readLock, writeLock } from '../../src/criteria/lock.js';
import { VERSION } from '../../src/version.js';
import { makeTempRepo } from '../helpers/repo.js';

async function setup(): Promise<{ dir: string; sha: string; cleanup(): void }> {
  const repo = await makeTempRepo();
  repo.write('x.txt', 'x');
  repo.commitAll('base');
  return {
    dir: repo.dir,
    sha: repo.git(['rev-parse', 'HEAD']).trim(),
    cleanup: repo.cleanup,
  };
}

const bytes = Buffer.from('{"version":1,"criteria":[]}', 'utf8');

test('writeLock then readLock round-trips and stays inside .git', async () => {
  const repo = await setup();
  try {
    const file = await writeLock(repo.dir, {
      baseSha: repo.sha,
      criteriaPath: 'receipt.criteria.json',
      criteriaBytes: bytes,
      version: VERSION,
      now: new Date('2026-11-18T09:12:03.120Z'),
    });
    assert.ok(file.includes(`.git${process.platform === 'win32' ? '\\' : '/'}agent-receipt`));
    const read = await readLock(repo.dir);
    assert.equal(read.ok, true);
    if (!read.ok) return;
    assert.equal(read.lock.baseSha, repo.sha);
    assert.equal(read.lock.criteriaPath, 'receipt.criteria.json');
    assert.equal(read.lock.criteria, bytes.toString('utf8'));
    assert.match(read.lock.sha256, /^[0-9a-f]{64}$/);
  } finally {
    repo.cleanup();
  }
});

test('a missing lock is reported as missing', async () => {
  const repo = await setup();
  try {
    const read = await readLock(repo.dir);
    assert.equal(read.ok, false);
    if (!read.ok) assert.equal(read.missing, true);
  } finally {
    repo.cleanup();
  }
});

test('editing the criteria text breaks the lock', async () => {
  const repo = await setup();
  try {
    const file = await writeLock(repo.dir, {
      baseSha: repo.sha,
      criteriaPath: 'receipt.criteria.json',
      criteriaBytes: bytes,
      version: VERSION,
      now: new Date(),
    });
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    parsed.criteria = '{"version":1,"criteria":[]} ';
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
    const read = await readLock(repo.dir);
    assert.equal(read.ok, false);
    if (!read.ok) assert.equal(read.missing, false);
  } finally {
    repo.cleanup();
  }
});

test('editing a sealed field breaks the lock seal', async () => {
  const repo = await setup();
  try {
    const file = await writeLock(repo.dir, {
      baseSha: repo.sha,
      criteriaPath: 'receipt.criteria.json',
      criteriaBytes: bytes,
      version: VERSION,
      now: new Date(),
    });
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    parsed.baseSha = 'a'.repeat(40);
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
    const read = await readLock(repo.dir);
    assert.equal(read.ok, false);
  } finally {
    repo.cleanup();
  }
});

test('a non-JSON lock file is corrupt', async () => {
  const repo = await setup();
  try {
    const file = await writeLock(repo.dir, {
      baseSha: repo.sha,
      criteriaPath: 'receipt.criteria.json',
      criteriaBytes: bytes,
      version: VERSION,
      now: new Date(),
    });
    fs.writeFileSync(file, 'not json');
    const read = await readLock(repo.dir);
    assert.equal(read.ok, false);
    if (!read.ok) assert.equal(read.missing, false);
  } finally {
    repo.cleanup();
  }
});
