import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { sha256Hex } from '../../src/canonical.js';
import { runCli } from '../helpers/cli.js';
import { makeTempDir, makeTempRepo } from '../helpers/repo.js';

const VALID = JSON.stringify({
  version: 1,
  criteria: [{ id: 'a', type: 'file', path: 'x.txt' }],
});

test('lock outside a git repository exits 1', async () => {
  const dir = await makeTempDir();
  try {
    fs.writeFileSync(`${dir.dir}/receipt.criteria.json`, VALID);
    const r = await runCli(['lock'], { cwd: dir.dir });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /lock needs a git repository/);
  } finally {
    dir.cleanup();
  }
});

test('lock in a repository with no commits exits 1', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('receipt.criteria.json', VALID);
    const r = await runCli(['lock'], { cwd: repo.dir, env: repo.env });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /make an initial commit before locking/);
  } finally {
    repo.cleanup();
  }
});

test('lock with invalid criteria exits 1 and writes no lock', async () => {
  const repo = await makeTempRepo();
  try {
    repo.commitAll('init');
    repo.write(
      'receipt.criteria.json',
      JSON.stringify({ version: 1, criteria: [{ id: 'a', type: 'file' }] }),
    );
    const r = await runCli(['lock'], { cwd: repo.dir, env: repo.env });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /path: is required/);
    assert.equal(repo.exists('.git/agent-receipt/lock.json'), false);
  } finally {
    repo.cleanup();
  }
});

test('lock writes under .git, prints the full hash, and does not dirty the tree', async () => {
  const repo = await makeTempRepo();
  try {
    repo.commitAll('init');
    repo.write('receipt.criteria.json', VALID);
    repo.commitAll('criteria');
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    const before = repo.git(['status', '--porcelain']);
    const r = await runCli(['lock'], { cwd: repo.dir, env: repo.env });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(repo.exists('.git/agent-receipt/lock.json'));
    assert.match(r.stdout, /locked receipt\.criteria\.json/);
    assert.match(r.stdout, new RegExp(`base     ${sha.slice(0, 7)} \\(HEAD\\)`));
    assert.match(r.stdout, new RegExp(`criteria sha256 ${sha256Hex(Buffer.from(VALID))}`));
    assert.match(r.stdout, /run `agent-receipt-check verify` when it says done/);
    assert.equal(repo.git(['status', '--porcelain']), before);
  } finally {
    repo.cleanup();
  }
});

test('locking twice replaces the previous lock', async () => {
  const repo = await makeTempRepo();
  try {
    repo.commitAll('init');
    repo.write('receipt.criteria.json', VALID);
    const first = await runCli(['lock'], { cwd: repo.dir, env: repo.env });
    assert.equal(first.code, 0, first.stderr);
    const second = await runCli(['lock'], { cwd: repo.dir, env: repo.env });
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /replaced previous lock \(base [0-9a-f]{7}, criteria [0-9a-f]{12}\)/);
  } finally {
    repo.cleanup();
  }
});

test('--root pointing at a subdirectory is rejected', async () => {
  const repo = await makeTempRepo();
  try {
    repo.commitAll('init');
    repo.write('receipt.criteria.json', VALID);
    fs.mkdirSync(`${repo.dir}/sub`);
    const r = await runCli(['lock', '--root', 'sub'], { cwd: repo.dir, env: repo.env });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--root must be the repository top level/);
  } finally {
    repo.cleanup();
  }
});

test('--root at the top level is accepted', async () => {
  const repo = await makeTempRepo();
  try {
    repo.commitAll('init');
    repo.write('receipt.criteria.json', VALID);
    const r = await runCli(['lock', '--root', '.'], { cwd: repo.dir, env: repo.env });
    assert.equal(r.code, 0, r.stderr);
  } finally {
    repo.cleanup();
  }
});

test('lock from a subdirectory resolves the criteria against cwd', async () => {
  const repo = await makeTempRepo();
  try {
    repo.commitAll('init');
    repo.write('sub/receipt.criteria.json', VALID);
    fs.mkdirSync(`${repo.dir}/sub`, { recursive: true });
    const r = await runCli(['lock'], { cwd: `${repo.dir}/sub`, env: repo.env });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /locked sub\/receipt\.criteria\.json/);
  } finally {
    repo.cleanup();
  }
});
