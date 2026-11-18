import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDiffCheck } from '../../../src/checks/diff.js';
import { computeChangedSet } from '../../../src/git.js';
import type { DiffCriterion } from '../../../src/types.js';
import { makeTempRepo } from '../../helpers/repo.js';
import { makeCtx } from './helpers.js';

async function checkWithRepo(
  repo: Awaited<ReturnType<typeof makeTempRepo>>,
  base: string,
  c: Omit<DiffCriterion, 'id' | 'type'>,
) {
  const changed = await computeChangedSet(repo.dir, base);
  assert.equal(changed.error, null);
  return runDiffCheck(
    { id: 'd', type: 'diff', ...c },
    makeCtx(repo.dir, changed.paths, base),
  );
}

test('diff: UNVERIFIED when there is no base', async () => {
  const repo = await makeTempRepo();
  try {
    repo.commitAll('init');
    const r = await runDiffCheck(
      { id: 'd', type: 'diff', path: 'x.txt' },
      makeCtx(repo.dir, new Set(['x.txt']), null),
    );
    assert.equal(r.verdict, 'UNVERIFIED');
    assert.equal(r.reason, 'no base to diff against');
  } finally {
    repo.cleanup();
  }
});

test('diff: changed:true PASSes for an untracked new file', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('a.txt', 'a');
    repo.commitAll('base');
    const base = repo.git(['rev-parse', 'HEAD']).trim();
    repo.write('new.txt', 'new');
    const r = await checkWithRepo(repo, base, { path: 'new.txt', changed: true });
    assert.equal(r.verdict, 'PASS');
    assert.match(r.evidence, /new\.txt/);
  } finally {
    repo.cleanup();
  }
});

test('diff: changed:false PASSes for an untouched prefix', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('test/a.mjs', 'a');
    repo.write('src/x.ts', 'x');
    repo.commitAll('base');
    const base = repo.git(['rev-parse', 'HEAD']).trim();
    repo.write('src/x.ts', 'changed');
    const r = await checkWithRepo(repo, base, { path: 'test/', changed: false });
    assert.equal(r.verdict, 'PASS');
    assert.equal(r.reason, `unchanged since ${base.slice(0, 7)}`);
  } finally {
    repo.cleanup();
  }
});

test('diff: changed:true FAILs when nothing changed', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('a.txt', 'a');
    repo.commitAll('base');
    const base = repo.git(['rev-parse', 'HEAD']).trim();
    const r = await checkWithRepo(repo, base, { path: 'a.txt', changed: true });
    assert.equal(r.verdict, 'FAIL');
    assert.match(r.reason, /no change under a\.txt since [0-9a-f]{7}/);
  } finally {
    repo.cleanup();
  }
});

test('diff: changed:false FAILs when a file under the prefix changed', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('test/a.mjs', 'a');
    repo.commitAll('base');
    const base = repo.git(['rev-parse', 'HEAD']).trim();
    repo.write('test/a.mjs', 'changed');
    const r = await checkWithRepo(repo, base, { path: 'test/', changed: false });
    assert.equal(r.verdict, 'FAIL');
    assert.match(r.evidence, /test\/a\.mjs/);
  } finally {
    repo.cleanup();
  }
});

test('diff: deleting a directory still counts as a change', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('test/a.mjs', 'a');
    repo.commitAll('base');
    const base = repo.git(['rev-parse', 'HEAD']).trim();
    repo.rm('test');
    const r = await checkWithRepo(repo, base, { path: 'test', changed: false });
    assert.equal(r.verdict, 'FAIL');
    assert.match(r.evidence, /test\/a\.mjs/);
  } finally {
    repo.cleanup();
  }
});

test('diff: src never matches src2', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('src/a.ts', 'a');
    repo.write('src2/b.ts', 'b');
    repo.commitAll('base');
    const base = repo.git(['rev-parse', 'HEAD']).trim();
    repo.write('src2/b.ts', 'changed');
    const r = await checkWithRepo(repo, base, { path: 'src', changed: false });
    assert.equal(r.verdict, 'PASS');
  } finally {
    repo.cleanup();
  }
});

test('diff: globs match changed paths', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('a.ts', 'a');
    repo.commitAll('base');
    const base = repo.git(['rev-parse', 'HEAD']).trim();
    repo.write('nested/b.ts', 'b');
    const r = await checkWithRepo(repo, base, { path: '**/*.ts', changed: true });
    assert.equal(r.verdict, 'PASS');
    assert.match(r.evidence, /nested\/b\.ts/);
  } finally {
    repo.cleanup();
  }
});
