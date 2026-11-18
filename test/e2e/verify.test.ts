import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { verifySeal } from '../../src/canonical.js';
import { runCli } from '../helpers/cli.js';
import { makeTempDir, makeTempRepo } from '../helpers/repo.js';
import type { TempRepo } from '../helpers/repo.js';

interface CriteriaShape {
  version: number;
  claim?: string;
  criteria: unknown[];
}

function writeCriteria(repo: TempRepo, value: CriteriaShape): void {
  repo.write('receipt.criteria.json', JSON.stringify(value));
}

function lock(repo: TempRepo): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCli(['lock'], { cwd: repo.dir, env: repo.env });
}

function verify(
  repo: TempRepo,
  args: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCli(['verify', ...args], { cwd: repo.dir, env: repo.env });
}

function receiptFiles(dir: string): string[] {
  const folder = path.join(dir, '.git/agent-receipt/receipts');
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(folder, name));
}

const FILE_PASS = { version: 1, criteria: [{ id: 'file-x', type: 'file', path: 'x.txt' }] };

async function passingRepo(): Promise<TempRepo> {
  const repo = await makeTempRepo();
  repo.write('x.txt', 'x');
  repo.commitAll('base');
  writeCriteria(repo, FILE_PASS);
  const locked = await lock(repo);
  assert.equal(locked.code, 0, locked.stderr);
  return repo;
}

test('VERIFIED exits 0 and writes a sealed receipt under .git', async () => {
  const repo = await passingRepo();
  try {
    const r = await verify(repo);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^agent-receipt-check 0\.1\.0$/m);
    assert.match(r.stdout, /^VERIFIED — 1\/1 criteria passed$/m);
    assert.match(r.stdout, /^PASS {8}file-x — content matches$/m);
    assert.match(r.stdout, /^receipt \.git\/agent-receipt\/receipts\/\d{8}T\d{9}Z-VERIFIED\.json$/m);
    assert.match(r.stdout, /^receipt sha256 [0-9a-f]{64}$/m);
    const files = receiptFiles(repo.dir);
    assert.equal(files.length, 1);
    const parsed = JSON.parse(fs.readFileSync(files[0]!, 'utf8')) as Record<string, unknown>;
    assert.equal(parsed.verdict, 'VERIFIED');
    assert.equal(verifySeal(parsed).valid, true);
  } finally {
    repo.cleanup();
  }
});

test('FAILED exits 2 and the verdict line names the criterion', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('x.txt', 'x');
    repo.commitAll('base');
    writeCriteria(repo, {
      version: 1,
      criteria: [{ id: 'missing-file', type: 'file', path: 'nope.txt' }],
    });
    await lock(repo);
    const r = await verify(repo);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stdout, /^FAIL {8}missing-file — missing$/m);
    assert.match(r.stdout, /^FAILED — 1 of 1 failed \(missing-file: missing\)$/m);
  } finally {
    repo.cleanup();
  }
});

test('UNVERIFIED exits 0, and exits 2 with --strict', async () => {
  const dir = await makeTempDir();
  try {
    fs.writeFileSync(
      path.join(dir.dir, 'receipt.criteria.json'),
      JSON.stringify({
        version: 1,
        criteria: [{ id: 'diff-x', type: 'diff', path: 'x.txt' }],
      }),
    );
    const relaxed = await runCli(['verify'], { cwd: dir.dir });
    assert.equal(relaxed.code, 0, relaxed.stderr);
    assert.match(relaxed.stdout, /^UNVERIFIED — 0 passed, 1 unverified \(diff-x: no base to diff against\)$/m);
    const strict = await runCli(['verify', '--strict'], { cwd: dir.dir });
    assert.equal(strict.code, 2, strict.stderr);
  } finally {
    dir.cleanup();
  }
});

test('bad flag, missing criteria and invalid criteria all exit 1', async () => {
  const dir = await makeTempDir();
  try {
    const bad = await runCli(['verify', '--nope'], { cwd: dir.dir });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /error: .*nope/);

    const missing = await runCli(['verify'], { cwd: dir.dir });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /criteria file not found/);

    fs.writeFileSync(
      path.join(dir.dir, 'receipt.criteria.json'),
      JSON.stringify({
        version: 1,
        criteria: [
          { id: 'a', type: 'file' },
          { id: 'b', type: 'http', url: 'ftp://example.com' },
        ],
      }),
    );
    const invalid = await runCli(['verify'], { cwd: dir.dir });
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /criteria\[0\] \("a"\)\.path: is required/);
    assert.match(invalid.stderr, /criteria\[1\] \("b"\)\.url: must be an http or https URL/);
  } finally {
    dir.cleanup();
  }
});

test('--json prints only the receipt, matching the written file and verifying its seal', async () => {
  const repo = await passingRepo();
  try {
    const r = await verify(repo, ['--json']);
    assert.equal(r.code, 0, r.stderr);
    const text = r.stdout.trim();
    assert.ok(text.startsWith('{'), r.stdout.slice(0, 80));

    const receipt = JSON.parse(text) as Record<string, unknown>;
    assert.deepEqual(Object.keys(receipt).sort(), [
      'base',
      'claim',
      'createdAt',
      'criteria',
      'criteriaFile',
      'environment',
      'findings',
      'head',
      'schema',
      'sha256',
      'summary',
      'tool',
      'verdict',
      'version',
    ]);
    const criteria = receipt.criteria as Array<Record<string, unknown>>;
    assert.deepEqual(Object.keys(criteria[0]!).sort(), [
      'durationMs',
      'evidence',
      'id',
      'reason',
      'spec',
      'type',
      'verdict',
    ]);
    assert.equal(verifySeal(receipt).valid, true);
    assert.deepEqual(receipt.environment, { node: process.version, platform: process.platform });

    const files = receiptFiles(repo.dir);
    assert.equal(files.length, 1);
    const onDisk = JSON.parse(fs.readFileSync(files[0]!, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(receipt, onDisk);
    assert.equal(fs.readFileSync(files[0]!, 'utf8'), `${text}\n`);
  } finally {
    repo.cleanup();
  }
});

test('--out writes exactly there; the default goes under .git and leaves git status unchanged', async () => {
  const repo = await passingRepo();
  try {
    const custom = await verify(repo, ['--out', 'custom/r.json']);
    assert.equal(custom.code, 0, custom.stderr);
    assert.ok(fs.existsSync(path.join(repo.dir, 'custom/r.json')));
    assert.match(custom.stdout, /^receipt custom\/r\.json$/m);

    repo.rm('custom');
    const before = repo.git(['status', '--porcelain']);
    const plain = await verify(repo);
    assert.equal(plain.code, 0, plain.stderr);
    assert.match(plain.stdout, /^receipt \.git\/agent-receipt\/receipts\//m);
    assert.equal(repo.git(['status', '--porcelain']), before);
  } finally {
    repo.cleanup();
  }
});

test('a non-git directory writes to .agent-receipt/receipts and prints i NO-BASE', async () => {
  const dir = await makeTempDir();
  try {
    fs.writeFileSync(
      path.join(dir.dir, 'receipt.criteria.json'),
      JSON.stringify({ version: 1, criteria: [{ id: 'x', type: 'file', path: 'x.txt' }] }),
    );
    fs.writeFileSync(path.join(dir.dir, 'x.txt'), 'x');
    const r = await runCli(['verify'], { cwd: dir.dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^base {3}none \(working tree\)$/m);
    assert.match(r.stdout, /^i NO-BASE no locked base:/m);
    assert.match(r.stdout, /^receipt \.agent-receipt\/receipts\/\d{8}T\d{9}Z-VERIFIED\.json$/m);
    assert.ok(fs.existsSync(path.join(dir.dir, '.agent-receipt/receipts')));
  } finally {
    dir.cleanup();
  }
});

test('a test criterion in a non-git directory adds the unlocked-file warning', async () => {
  const dir = await makeTempDir();
  try {
    fs.writeFileSync(
      path.join(dir.dir, 'receipt.criteria.json'),
      JSON.stringify({
        version: 1,
        criteria: [{ id: 't', type: 'test', command: 'node -e ""' }],
      }),
    );
    const r = await runCli(['verify'], { cwd: dir.dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /commands came from an unlocked file — review it before trusting the result\./);
  } finally {
    dir.cleanup();
  }
});

test('RUNNER-CHANGED appears only when a test criterion exists', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('x.txt', 'x');
    repo.write('package.json', '{"scripts":{}}');
    repo.commitAll('base');
    writeCriteria(repo, {
      version: 1,
      criteria: [
        { id: 't', type: 'test', command: 'node -e ""' },
        { id: 'f', type: 'file', path: 'x.txt' },
      ],
    });
    await lock(repo);
    repo.write('package.json', '{"scripts":{"test":"node --test"}}');

    const withTest = await verify(repo);
    assert.equal(withTest.code, 0, withTest.stderr);
    assert.match(
      withTest.stdout,
      /^! RUNNER-CHANGED test-runner config changed since the base \(package\.json\): locked test commands may now run differently$/m,
    );

    writeCriteria(repo, {
      version: 1,
      criteria: [{ id: 'f', type: 'file', path: 'x.txt' }],
    });
    const relocked = await lock(repo);
    assert.equal(relocked.code, 0, relocked.stderr);
    const withoutTest = await verify(repo);
    assert.equal(withoutTest.code, 0, withoutTest.stderr);
    assert.ok(!withoutTest.stdout.includes('RUNNER-CHANGED'));
  } finally {
    repo.cleanup();
  }
});

test('GIT-HIDING appears for a skip-worktree edit and marks the head dirty', async () => {
  const repo = await passingRepo();
  try {
    repo.git(['update-index', '--skip-worktree', 'x.txt']);
    repo.write('x.txt', 'changed behind git');
    assert.equal(repo.git(['status', '--porcelain', '--', 'x.txt']).trim(), '');

    const r = await verify(repo, ['--json']);
    assert.equal(r.code, 0, r.stderr);
    const receipt = JSON.parse(r.stdout) as Record<string, unknown>;
    const findings = receipt.findings as Array<{ id: string; severity: string }>;
    assert.ok(findings.some((f) => f.id === 'GIT-HIDING' && f.severity === 'warn'));
    assert.deepEqual((receipt.head as { dirty: boolean }).dirty, true);
  } finally {
    repo.cleanup();
  }
});

test('no absolute temp path leaks into the receipt or stdout, even from failing TAP output', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('test/fail.test.mjs', "import test from 'node:test';\ntest('fails', () => { throw new Error('boom'); });\n");
    repo.commitAll('base');
    writeCriteria(repo, {
      version: 1,
      criteria: [
        {
          id: 'suite',
          type: 'test',
          command:
            'node --test --test-reporter=tap "test/*.test.mjs"; echo "at $PWD/test/fail.test.mjs"; exit 1',
          expect: { exit: 0 },
        },
      ],
    });
    await lock(repo);
    const r = await verify(repo);
    assert.equal(r.code, 2, r.stderr);
    assert.equal(r.stdout.includes(repo.dir), false, 'stdout leaked the temp root');
    assert.equal(r.stderr.includes(repo.dir), false, 'stderr leaked the temp root');

    const files = receiptFiles(repo.dir);
    assert.equal(files.length, 1);
    const text = fs.readFileSync(files[0]!, 'utf8');
    assert.equal(text.includes(repo.dir), false, 'receipt leaked the temp root');
    assert.equal(text.includes(fs.realpathSync(repo.dir)), false, 'receipt leaked the realpath');
    assert.ok(text.includes('<root>'), 'receipt should show <root> instead of the path');
  } finally {
    repo.cleanup();
  }
});
