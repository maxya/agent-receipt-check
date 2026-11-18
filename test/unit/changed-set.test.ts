import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { computeChangedSet, lsTreeType } from '../../src/git.js';
import { makeTempRepo } from '../helpers/repo.js';

test('the changed set covers committed, staged, unstaged, untracked and deleted paths', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('committed.txt', 'a');
    repo.write('staged.txt', 'a');
    repo.write('unstaged.txt', 'a');
    repo.write('deleted.txt', 'a');
    repo.write('old-name.txt', 'a');
    repo.write('.gitignore', 'ignored.log\n');
    repo.commitAll('base');
    const base = repo.git(['rev-parse', 'HEAD']).trim();

    repo.write('committed.txt', 'b');
    repo.commitAll('committed change');
    repo.write('staged.txt', 'b');
    repo.git(['add', 'staged.txt']);
    repo.write('unstaged.txt', 'b');
    fs.rmSync(path.join(repo.dir, 'deleted.txt'));
    repo.write('untracked.txt', 'new');
    repo.write('ignored.log', 'ignored');
    fs.renameSync(path.join(repo.dir, 'old-name.txt'), path.join(repo.dir, 'new-name.txt'));

    const result = await computeChangedSet(repo.dir, base);
    assert.equal(result.error, null);
    for (const expected of [
      'committed.txt',
      'staged.txt',
      'unstaged.txt',
      'deleted.txt',
      'untracked.txt',
      'old-name.txt',
      'new-name.txt',
    ]) {
      assert.ok(result.paths.has(expected), `missing ${expected}`);
    }
    assert.equal(result.paths.has('ignored.log'), false);
  } finally {
    repo.cleanup();
  }
});

test('skip-worktree edits are detected directly and reported as hiding', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('test/a.mjs', 'one');
    repo.commitAll('base');
    const base = repo.git(['rev-parse', 'HEAD']).trim();
    repo.git(['update-index', '--skip-worktree', 'test/a.mjs']);
    repo.write('test/a.mjs', 'two');
    assert.equal(repo.git(['status', '--porcelain']).trim(), '');
    const result = await computeChangedSet(repo.dir, base);
    assert.ok(result.paths.has('test/a.mjs'));
    assert.ok(result.hiding.includes('test/a.mjs'));
  } finally {
    repo.cleanup();
  }
});

test('assume-unchanged edits are detected directly and reported as hiding', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('test/a.mjs', 'one');
    repo.commitAll('base');
    const base = repo.git(['rev-parse', 'HEAD']).trim();
    repo.git(['update-index', '--assume-unchanged', 'test/a.mjs']);
    repo.write('test/a.mjs', 'two');
    assert.equal(repo.git(['status', '--porcelain']).trim(), '');
    const result = await computeChangedSet(repo.dir, base);
    assert.ok(result.paths.has('test/a.mjs'));
    assert.ok(result.hiding.includes('test/a.mjs'));
  } finally {
    repo.cleanup();
  }
});

test('a file added to .git/info/exclude is still in the changed set', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('x.txt', 'x');
    repo.commitAll('base');
    const base = repo.git(['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(path.join(repo.dir, '.git/info/exclude'), 'hidden.txt\n');
    repo.write('hidden.txt', 'hidden');
    assert.equal(repo.git(['status', '--porcelain']).trim(), '');
    const result = await computeChangedSet(repo.dir, base);
    assert.ok(result.paths.has('hidden.txt'));
  } finally {
    repo.cleanup();
  }
});

test('a new .gitignore rule is visible while the file it hides is not', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('x.txt', 'x');
    repo.commitAll('base');
    const base = repo.git(['rev-parse', 'HEAD']).trim();
    repo.write('.gitignore', 'secret.txt\n');
    repo.write('secret.txt', 'hidden');
    const result = await computeChangedSet(repo.dir, base);
    assert.ok(result.paths.has('.gitignore'));
    assert.equal(result.paths.has('secret.txt'), false);
  } finally {
    repo.cleanup();
  }
});

test('lsTreeType distinguishes trees, blobs and missing paths', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('test/a.mjs', 'x');
    repo.write('file.txt', 'x');
    repo.commitAll('base');
    const base = repo.git(['rev-parse', 'HEAD']).trim();
    assert.equal(await lsTreeType(repo.dir, base, 'test'), 'tree');
    assert.equal(await lsTreeType(repo.dir, base, 'file.txt'), 'blob');
    assert.equal(await lsTreeType(repo.dir, base, 'missing'), null);
  } finally {
    repo.cleanup();
  }
});
