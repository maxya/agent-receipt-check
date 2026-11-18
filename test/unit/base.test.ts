import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveCriteria } from '../../src/criteria/load.js';
import { writeLock } from '../../src/criteria/lock.js';
import { VERSION } from '../../src/version.js';
import { makeTempDir, makeTempRepo } from '../helpers/repo.js';
import type { TempRepo } from '../helpers/repo.js';

const CRITERIA = (claim: string): string =>
  JSON.stringify({
    version: 1,
    claim,
    criteria: [{ id: 'x', type: 'file', path: 'x.txt', description: claim }],
  });

function resolve(repo: TempRepo, opts: { baseArg?: string | null; now?: Date } = {}) {
  return resolveCriteria({
    cwd: repo.dir,
    root: repo.dir,
    criteriaArg: 'receipt.criteria.json',
    baseArg: opts.baseArg ?? null,
    now: () => opts.now ?? new Date(),
  });
}

test('rule 4: a non-git directory has no base and reports NO-BASE', async () => {
  const dir = await makeTempDir();
  try {
    const fs = await import('node:fs');
    fs.writeFileSync(`${dir.dir}/receipt.criteria.json`, CRITERIA('x'));
    const loaded = await resolveCriteria({
      cwd: dir.dir,
      root: dir.dir,
      criteriaArg: 'receipt.criteria.json',
      baseArg: null,
      now: () => new Date(),
    });
    assert.equal(loaded.base.source, 'none');
    assert.equal(loaded.base.sha, null);
    assert.equal(loaded.findings.filter((f) => f.id === 'NO-BASE').length, 1);
    assert.match(loaded.findings[0]!.message, /criteria were read from the working tree/);
  } finally {
    dir.cleanup();
  }
});

test('rule 3: committed criteria without a lock use HEAD and warn BASE-IS-HEAD', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('receipt.criteria.json', CRITERIA('head'));
    repo.commitAll('base');
    const loaded = await resolve(repo);
    assert.equal(loaded.base.source, 'head');
    assert.equal(loaded.base.sha, repo.git(['rev-parse', 'HEAD']).trim());
    assert.ok(loaded.findings.some((f) => f.id === 'BASE-IS-HEAD'));
  } finally {
    repo.cleanup();
  }
});

test('rule 1: --base HEAD~1 reads the old criteria bytes', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('receipt.criteria.json', CRITERIA('old'));
    repo.write('x.txt', 'x');
    repo.commitAll('first');
    repo.write('receipt.criteria.json', CRITERIA('new'));
    repo.commitAll('second');
    const loaded = await resolve(repo, { baseArg: 'HEAD~1' });
    assert.equal(loaded.base.source, 'ref');
    assert.equal(loaded.base.ref, 'HEAD~1');
    assert.match(loaded.bytes.toString('utf8'), /old/);
    assert.ok(loaded.findings.some((f) => f.id === 'CRITERIA-CHANGED'));
  } finally {
    repo.cleanup();
  }
});

test('rule 1: an unknown ref exits 1', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('receipt.criteria.json', CRITERIA('x'));
    repo.commitAll('base');
    await assert.rejects(resolve(repo, { baseArg: 'nope' }), /unknown ref 'nope'/);
  } finally {
    repo.cleanup();
  }
});

test('rule 1: criteria not in the ref exits 1 with the lock hint', async () => {
  const repo = await makeTempRepo();
  try {
    repo.commitAll('empty');
    repo.write('receipt.criteria.json', CRITERIA('x'));
    await assert.rejects(
      resolve(repo, { baseArg: 'HEAD' }),
      /is not in HEAD; commit it before the run, or use 'agent-receipt-check lock'/,
    );
  } finally {
    repo.cleanup();
  }
});

test('rule 1: --base outside git exits 1', async () => {
  const dir = await makeTempDir();
  try {
    const fs = await import('node:fs');
    fs.writeFileSync(`${dir.dir}/receipt.criteria.json`, CRITERIA('x'));
    await assert.rejects(
      resolveCriteria({
        cwd: dir.dir,
        root: dir.dir,
        criteriaArg: 'receipt.criteria.json',
        baseArg: 'HEAD',
        now: () => new Date(),
      }),
      /--base needs a git repository/,
    );
  } finally {
    dir.cleanup();
  }
});

test('rule 2: the locked bytes win after the agent edits and commits the criteria', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('receipt.criteria.json', CRITERIA('locked'));
    repo.write('x.txt', 'x');
    repo.commitAll('base');
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    await writeLock(repo.dir, {
      baseSha: sha,
      criteriaPath: 'receipt.criteria.json',
      criteriaBytes: Buffer.from(CRITERIA('locked')),
      version: VERSION,
      now: new Date(),
    });
    repo.write('receipt.criteria.json', CRITERIA('weakened'));
    repo.commitAll('weaken');
    const loaded = await resolve(repo);
    assert.equal(loaded.base.source, 'lock');
    assert.match(loaded.bytes.toString('utf8'), /locked/);
    assert.ok(loaded.findings.some((f) => f.id === 'CRITERIA-CHANGED'));
  } finally {
    repo.cleanup();
  }
});

test('rule 2: a corrupt lock exits 1 and does not fall back', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('receipt.criteria.json', CRITERIA('locked'));
    repo.commitAll('base');
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    const file = await writeLock(repo.dir, {
      baseSha: sha,
      criteriaPath: 'receipt.criteria.json',
      criteriaBytes: Buffer.from(CRITERIA('locked')),
      version: VERSION,
      now: new Date(),
    });
    const fs = await import('node:fs');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    parsed.criteria = CRITERIA('tampered');
    fs.writeFileSync(file, JSON.stringify(parsed, null, 2));
    await assert.rejects(resolve(repo), /lock file is corrupt or was edited/);
  } finally {
    repo.cleanup();
  }
});

test('rule 2: a lock older than 24h warns STALE-LOCK', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('receipt.criteria.json', CRITERIA('locked'));
    repo.commitAll('base');
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    const created = new Date(Date.now() - 25 * 3_600_000);
    await writeLock(repo.dir, {
      baseSha: sha,
      criteriaPath: 'receipt.criteria.json',
      criteriaBytes: Buffer.from(CRITERIA('locked')),
      version: VERSION,
      now: created,
    });
    const loaded = await resolve(repo, { now: new Date() });
    const stale = loaded.findings.find((f) => f.id === 'STALE-LOCK');
    assert.ok(stale);
    assert.match(stale.message, /re-lock at the start of each session/);
  } finally {
    repo.cleanup();
  }
});

test('rule 2: a base that no longer exists exits 1', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('receipt.criteria.json', CRITERIA('locked'));
    repo.commitAll('base');
    await writeLock(repo.dir, {
      baseSha: 'a'.repeat(40),
      criteriaPath: 'receipt.criteria.json',
      criteriaBytes: Buffer.from(CRITERIA('locked')),
      version: VERSION,
      now: new Date(),
    });
    await assert.rejects(resolve(repo), /not found \(history rewritten\?\)/);
  } finally {
    repo.cleanup();
  }
});

test('rule 2: a lock base on an unrelated history warns BASE-NOT-ANCESTOR', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('receipt.criteria.json', CRITERIA('locked'));
    repo.commitAll('base');
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    await writeLock(repo.dir, {
      baseSha: sha,
      criteriaPath: 'receipt.criteria.json',
      criteriaBytes: Buffer.from(CRITERIA('locked')),
      version: VERSION,
      now: new Date(),
    });
    repo.git(['checkout', '-q', '--orphan', 'other']);
    repo.git(['commit', '-q', '-m', 'orphan commit', '--allow-empty']);
    const loaded = await resolve(repo);
    assert.ok(loaded.findings.some((f) => f.id === 'BASE-NOT-ANCESTOR'));
  } finally {
    repo.cleanup();
  }
});

test('a lock for a different criteria path is ignored with LOCK-IGNORED', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('other.criteria.json', CRITERIA('other'));
    repo.write('receipt.criteria.json', CRITERIA('mine'));
    repo.commitAll('base');
    const sha = repo.git(['rev-parse', 'HEAD']).trim();
    await writeLock(repo.dir, {
      baseSha: sha,
      criteriaPath: 'other.criteria.json',
      criteriaBytes: Buffer.from(CRITERIA('other')),
      version: VERSION,
      now: new Date(),
    });
    const loaded = await resolve(repo);
    assert.ok(loaded.findings.some((f) => f.id === 'LOCK-IGNORED'));
    assert.notEqual(loaded.base.source, 'lock');
  } finally {
    repo.cleanup();
  }
});
