import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { seal } from '../../src/canonical.js';
import { TOOL, VERSION } from '../../src/version.js';
import { runCli } from '../helpers/cli.js';
import { makeTempDir } from '../helpers/repo.js';

function makeReceipt(): Record<string, unknown> {
  return seal({
    schema: 1,
    tool: TOOL,
    version: VERSION,
    createdAt: '2026-11-18T09:15:00.123Z',
    claim: 'Add a /health endpoint and make the suite green',
    base: {
      source: 'lock',
      ref: null,
      sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      lockedAt: '2026-11-18T09:12:03.120Z',
    },
    head: { sha: 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f809123456', dirty: true },
    criteriaFile: { path: 'receipt.criteria.json', sha256: 'f'.repeat(64) },
    environment: { node: 'v26.13.0', platform: 'linux' },
    criteria: [
      {
        id: 'tests-untouched',
        type: 'diff',
        spec: { path: 'test/', changed: false },
        verdict: 'PASS',
        evidence: 'no changed paths',
        reason: 'unchanged since a1b2c3d',
        durationMs: 1,
      },
      {
        id: 'suite-green',
        type: 'test',
        spec: { command: 'node --test' },
        verdict: 'FAIL',
        evidence: 'exit 0 in 0.4s',
        reason: 'stdout lacks "# skipped 0"',
        durationMs: 412,
      },
    ],
    verdict: 'FAILED',
    summary: { total: 2, pass: 1, fail: 1, unverified: 0 },
    findings: [],
  });
}

async function writeReceipt(dir: string, receipt: unknown, indent = 2): Promise<string> {
  const file = path.join(dir, 'r.json');
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, indent)}\n`);
  return file;
}

test('a valid receipt prints SEAL OK and exits 0', async () => {
  const dir = await makeTempDir();
  try {
    const file = await writeReceipt(dir.dir, makeReceipt());
    const r = await runCli(['receipt', 'show', file], { cwd: dir.dir });
    assert.equal(r.code, 0, r.stderr);
    const receipt = makeReceipt();
    assert.match(r.stdout, new RegExp(`^SEAL OK — receipt sha256 ${receipt.sha256} matches its contents$`, 'm'));
    assert.match(
      r.stdout,
      /^FAILED — 1 of 2 failed · created 2026-11-18 09:15 UTC · base lock a1b2c3d$/m,
    );
    assert.match(r.stdout, /^claim {2}"Add a \/health endpoint and make the suite green"$/m);
    assert.match(r.stdout, /^PASS {2}tests-untouched — unchanged since a1b2c3d$/m);
    assert.match(r.stdout, /^FAIL {2}suite-green — stdout lacks "# skipped 0"$/m);
  } finally {
    dir.cleanup();
  }
});

test('changing one character of evidence breaks the seal and exits 2', async () => {
  const dir = await makeTempDir();
  try {
    const receipt = makeReceipt();
    const criteria = receipt.criteria as Array<Record<string, unknown>>;
    criteria[1]!.evidence = 'exit 0 in 0.5s';
    const file = await writeReceipt(dir.dir, receipt);
    const r = await runCli(['receipt', 'show', file], { cwd: dir.dir });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stdout, /^SEAL BROKEN — contents were modified after the receipt was written/m);
    assert.match(r.stdout, /stored [0-9a-f]{64}, computed [0-9a-f]{64}/);
  } finally {
    dir.cleanup();
  }
});

test('changing the verdict from FAILED to VERIFIED breaks the seal and exits 2', async () => {
  const dir = await makeTempDir();
  try {
    const receipt = makeReceipt();
    receipt.verdict = 'VERIFIED';
    const file = await writeReceipt(dir.dir, receipt);
    const r = await runCli(['receipt', 'show', file], { cwd: dir.dir });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stdout, /^SEAL BROKEN/);
  } finally {
    dir.cleanup();
  }
});

test('re-indenting the file keeps the seal valid', async () => {
  const dir = await makeTempDir();
  try {
    const file = await writeReceipt(dir.dir, makeReceipt(), 4);
    const r = await runCli(['receipt', 'show', file], { cwd: dir.dir });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^SEAL OK — /m);
  } finally {
    dir.cleanup();
  }
});

test('a non-JSON file exits 1', async () => {
  const dir = await makeTempDir();
  try {
    const file = path.join(dir.dir, 'r.json');
    fs.writeFileSync(file, 'not json');
    const r = await runCli(['receipt', 'show', file], { cwd: dir.dir });
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /^error: not a receipt: /);
  } finally {
    dir.cleanup();
  }
});

test('JSON that is not a receipt exits 1', async () => {
  const dir = await makeTempDir();
  try {
    const cases: unknown[] = [
      { schema: 2, tool: TOOL, sha256: 'a'.repeat(64) },
      { schema: 1, tool: 'something-else', sha256: 'a'.repeat(64) },
      { schema: 1, tool: TOOL },
      [1, 2, 3],
    ];
    for (const value of cases) {
      const file = await writeReceipt(dir.dir, value);
      const r = await runCli(['receipt', 'show', file], { cwd: dir.dir });
      assert.equal(r.code, 1, JSON.stringify(value));
      assert.match(r.stderr, /^error: not a receipt: /);
    }
  } finally {
    dir.cleanup();
  }
});

test('a missing file exits 1', async () => {
  const dir = await makeTempDir();
  try {
    const r = await runCli(['receipt', 'show', 'nope.json'], { cwd: dir.dir });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^error: could not read receipt: ENOENT$/m);
  } finally {
    dir.cleanup();
  }
});

test('--json has exactly sealValid, expected, actual, receipt', async () => {
  const dir = await makeTempDir();
  try {
    const receipt = makeReceipt();
    const file = await writeReceipt(dir.dir, receipt);
    const r = await runCli(['receipt', 'show', file, '--json'], { cwd: dir.dir });
    assert.equal(r.code, 0, r.stderr);
    const body = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ['actual', 'expected', 'receipt', 'sealValid']);
    assert.equal(body.sealValid, true);
    assert.equal(body.expected, receipt.sha256);
    assert.equal(body.actual, receipt.sha256);
    assert.deepEqual(body.receipt, JSON.parse(JSON.stringify(receipt)));
  } finally {
    dir.cleanup();
  }
});

test('--json on a broken seal reports both hashes and exits 2', async () => {
  const dir = await makeTempDir();
  try {
    const receipt = makeReceipt();
    receipt.claim = 'tampered';
    const file = await writeReceipt(dir.dir, receipt);
    const r = await runCli(['receipt', 'show', file, '--json'], { cwd: dir.dir });
    assert.equal(r.code, 2, r.stderr);
    const body = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.equal(body.sealValid, false);
    assert.match(String(body.expected), /^[0-9a-f]{64}$/);
    assert.match(String(body.actual), /^[0-9a-f]{64}$/);
    assert.notEqual(body.expected, body.actual);
  } finally {
    dir.cleanup();
  }
});
