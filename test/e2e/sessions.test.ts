import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runCli } from '../helpers/cli.js';
import { makeTempRepo } from '../helpers/repo.js';
import type { TempRepo } from '../helpers/repo.js';
import * as honest from '../fixtures/sessions/honest.js';
import * as lyingExport from '../fixtures/sessions/lying-export.js';
import * as lyingSkip from '../fixtures/sessions/lying-skip.js';
import * as tampered from '../fixtures/sessions/tampered-criteria.js';
import type { SessionBuild } from '../fixtures/sessions/shared.js';

interface SessionFixture {
  build(repo: TempRepo): Promise<SessionBuild>;
}

interface ReceiptCriterionShape {
  id: string;
  verdict: string;
  evidence: string;
  reason: string;
}

interface ReceiptShape {
  verdict: string;
  criteria: ReceiptCriterionShape[];
  findings: Array<{ id: string; severity: string }>;
}

function latestReceipt(dir: string): string {
  const folder = path.join(dir, '.git/agent-receipt/receipts');
  const files = fs
    .readdirSync(folder)
    .filter((name) => name.endsWith('.json'))
    .sort();
  const latest = files.at(-1);
  assert.ok(latest, 'no receipt was written');
  return path.join(folder, latest);
}

async function run(fixture: SessionFixture): Promise<{
  repo: TempRepo;
  result: { code: number; stdout: string; stderr: string };
  receipt: ReceiptShape;
}> {
  const repo = await makeTempRepo();
  try {
    const built = await fixture.build(repo);
    const result = await runCli(['verify'], { cwd: repo.dir, env: repo.env });
    const receipt = JSON.parse(fs.readFileSync(latestReceipt(repo.dir), 'utf8')) as ReceiptShape;
    return { repo, result, receipt };
  } catch (err) {
    repo.cleanup();
    throw err;
  }
}

function byId(receipt: ReceiptShape, id: string): ReceiptCriterionShape {
  const found = receipt.criteria.find((criterion) => criterion.id === id);
  assert.ok(found, `criterion ${id} missing from the receipt`);
  return found;
}

test('honest session: VERIFIED, exit 0', async (t) => {
  const { repo, result, receipt } = await run(honest);
  try {
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^VERIFIED — 3\/3 criteria passed$/m);
    assert.equal(receipt.verdict, 'VERIFIED');
    for (const id of ['suite-green', 'tests-untouched', 'health-changed']) {
      assert.equal(byId(receipt, id).verdict, 'PASS');
    }
    t.diagnostic(`honest → ${receipt.verdict} (exit ${result.code})`);
  } finally {
    repo.cleanup();
  }
});

test('lying-skip session: FAILED — the skipped test is caught', async (t) => {
  const { repo, result, receipt } = await run(lyingSkip);
  try {
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stdout, /^FAILED — /m);
    assert.equal(receipt.verdict, 'FAILED');

    const suite = byId(receipt, 'suite-green');
    assert.equal(suite.verdict, 'FAIL');
    assert.match(suite.reason, /# skipped 0/);

    const untouched = byId(receipt, 'tests-untouched');
    assert.equal(untouched.verdict, 'FAIL');
    assert.match(untouched.evidence, /test\/health\.test\.mjs/);

    assert.equal(byId(receipt, 'health-changed').verdict, 'FAIL');
    t.diagnostic(`lying-skip → ${receipt.verdict} (exit ${result.code})`);
  } finally {
    repo.cleanup();
  }
});

test('lying-export session: FAILED — the data, not the test suite, shows the lie', async (t) => {
  const { repo, result, receipt } = await run(lyingExport);
  try {
    assert.equal(result.code, 2, result.stderr);
    assert.equal(receipt.verdict, 'FAILED');

    const rows = byId(receipt, 'export-rows');
    assert.equal(rows.verdict, 'FAIL');
    assert.match(rows.reason, /0 csv rows, expected exactly 3/);

    const hasAt = byId(receipt, 'csv-has-at');
    assert.equal(hasAt.verdict, 'FAIL');
    assert.match(hasAt.reason, /missing "@"/);

    assert.equal(byId(receipt, 'summary-count').verdict, 'PASS');
    t.diagnostic(`lying-export → ${receipt.verdict} (exit ${result.code})`);
  } finally {
    repo.cleanup();
  }
});

test('tampered-criteria session: lock keeps the failing criterion; without it, HEAD is trusted', async (t) => {
  const repo = await makeTempRepo();
  try {
    await tampered.build(repo);

    const locked = await runCli(['verify'], { cwd: repo.dir, env: repo.env });
    assert.equal(locked.code, 2, locked.stderr);
    assert.match(locked.stdout, /^! CRITERIA-CHANGED /m);
    const lockedReceipt = JSON.parse(fs.readFileSync(latestReceipt(repo.dir), 'utf8')) as ReceiptShape;
    assert.equal(lockedReceipt.verdict, 'FAILED');
    assert.equal(byId(lockedReceipt, 'must-export').verdict, 'FAIL');

    repo.rm('.git/agent-receipt/lock.json');
    const unlocked = await runCli(['verify'], { cwd: repo.dir, env: repo.env });
    assert.equal(unlocked.code, 0, unlocked.stderr);
    assert.match(unlocked.stdout, /^! BASE-IS-HEAD /m);
    assert.match(unlocked.stdout, /^VERIFIED — 1\/1 criteria passed$/m);

    t.diagnostic(`tampered → ${lockedReceipt.verdict} with lock, VERIFIED without (exit 0)`);
  } finally {
    repo.cleanup();
  }
});
