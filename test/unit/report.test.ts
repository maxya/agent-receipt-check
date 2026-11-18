import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runnerMatches } from '../../src/commands/verify.js';
import {
  exitCodeFor,
  formatBaseLine,
  formatVerdictLine,
  renderHumanReport,
} from '../../src/report/human.js';
import type { Receipt, ReceiptCriterion, ReceiptBase } from '../../src/types.js';

function criterion(
  id: string,
  verdict: ReceiptCriterion['verdict'],
  reason: string,
): ReceiptCriterion {
  return { id, type: 'file', spec: { path: 'x' }, verdict, evidence: '', reason, durationMs: 1 };
}

function receipt(overrides: Partial<Receipt> = {}): Receipt {
  const criteria = overrides.criteria ?? [
    criterion('tests-untouched', 'PASS', 'unchanged since a1b2c3d'),
    criterion('suite-green', 'FAIL', 'stdout lacks "# skipped 0"'),
  ];
  const pass = criteria.filter((c) => c.verdict === 'PASS').length;
  const fail = criteria.filter((c) => c.verdict === 'FAIL').length;
  const unverified = criteria.filter((c) => c.verdict === 'UNVERIFIED').length;
  return {
    schema: 1,
    tool: 'agent-receipt-check',
    version: '0.1.0',
    createdAt: '2026-11-18T09:15:00.123Z',
    claim: null,
    base: { source: 'lock', ref: null, sha: 'a1b2c3d4e5', lockedAt: '2026-11-18T09:12:03.120Z' },
    head: { sha: 'c3d4e5f6', dirty: true },
    criteriaFile: { path: 'receipt.criteria.json', sha256: 'f'.repeat(64) },
    environment: { node: 'v26.13.1', platform: 'linux' },
    criteria,
    verdict: fail > 0 ? 'FAILED' : unverified > 0 ? 'UNVERIFIED' : 'VERIFIED',
    summary: { total: criteria.length, pass, fail, unverified },
    findings: [],
    sha256: '1a2b3c4d'.repeat(8),
    ...overrides,
  };
}

test('formatBaseLine covers lock, ref, head and none', () => {
  const lock: ReceiptBase = {
    source: 'lock',
    ref: null,
    sha: 'a1b2c3d4e5',
    lockedAt: '2026-11-18T09:12:03.120Z',
  };
  assert.equal(formatBaseLine(lock), 'base   lock a1b2c3d · locked 2026-11-18 09:12 UTC');
  assert.equal(
    formatBaseLine({ source: 'ref', ref: 'HEAD~1', sha: 'a1b2c3d4e5', lockedAt: null }),
    'base   ref HEAD~1 a1b2c3d',
  );
  assert.equal(
    formatBaseLine({ source: 'head', ref: null, sha: 'a1b2c3d4e5', lockedAt: null }),
    'base   head a1b2c3d',
  );
  assert.equal(
    formatBaseLine({ source: 'none', ref: null, sha: null, lockedAt: null }),
    'base   none (working tree)',
  );
});

test('formatVerdictLine has the three §4.12 variants', () => {
  const verified = receipt({ criteria: [criterion('a', 'PASS', 'ok'), criterion('b', 'PASS', 'ok')] });
  assert.equal(formatVerdictLine(verified), 'VERIFIED — 2/2 criteria passed');

  const failed = receipt();
  assert.equal(
    formatVerdictLine(failed),
    'FAILED — 1 of 2 failed (suite-green: stdout lacks "# skipped 0")',
  );

  const mixed = receipt({
    criteria: [
      criterion('a', 'PASS', 'ok'),
      criterion('b', 'PASS', 'ok'),
      criterion('c', 'PASS', 'ok'),
      criterion('health-live', 'UNVERIFIED', 'connection refused'),
    ],
  });
  assert.equal(
    formatVerdictLine(mixed),
    'UNVERIFIED — 3 passed, 1 unverified (health-live: connection refused)',
  );
});

test('the human report prints warns before criteria and infos after the verdict', () => {
  const r = receipt({
    findings: [
      { id: 'CRITERIA-CHANGED', severity: 'warn', message: 'criteria changed' },
      { id: 'STALE-LOCK', severity: 'warn', message: 'stale' },
      { id: 'NO-BASE', severity: 'info', message: 'no base' },
    ],
  });
  const out = renderHumanReport({
    receipt: r,
    criteriaSha256: 'f'.repeat(64),
    receiptPath: '/tmp/work/receipts/r.json',
    cwd: '/tmp/work',
  });
  const lines = out.trimEnd().split('\n');
  assert.equal(lines[0], 'agent-receipt-check 0.1.0');
  assert.equal(lines[1], 'base   lock a1b2c3d · locked 2026-11-18 09:12 UTC');
  assert.equal(lines[2], `criteria sha256 ${'f'.repeat(64)}`);
  assert.equal(lines[3], '! CRITERIA-CHANGED criteria changed');
  assert.equal(lines[4], '! STALE-LOCK stale');
  assert.match(lines[5]!, /^PASS {8}tests-untouched — /);
  const verdictIndex = lines.findIndex((l) => l.startsWith('FAILED — '));
  assert.ok(verdictIndex > 5);
  assert.equal(lines[verdictIndex + 1], 'i NO-BASE no base');
  assert.equal(lines[verdictIndex + 2], 'receipt receipts/r.json');
  assert.equal(lines[verdictIndex + 3], `receipt sha256 ${'1a2b3c4d'.repeat(8)}`);
  assert.equal(lines[verdictIndex + 4], undefined);
});

test('a claim is printed quoted and truncated to 120 chars', () => {
  const r = receipt({ claim: 'x'.repeat(200), criteria: [criterion('a', 'PASS', 'ok')] });
  const out = renderHumanReport({ receipt: r, criteriaSha256: 'f'.repeat(64), receiptPath: null, cwd: '/tmp' });
  const claimLine = out.split('\n').find((l) => l.startsWith('claim  '))!;
  assert.equal(claimLine, `claim  ${JSON.stringify(`${'x'.repeat(120)}…`)}`);
});

test('exitCodeFor follows §4.2', () => {
  assert.equal(exitCodeFor('VERIFIED', false), 0);
  assert.equal(exitCodeFor('UNVERIFIED', false), 0);
  assert.equal(exitCodeFor('UNVERIFIED', true), 2);
  assert.equal(exitCodeFor('FAILED', false), 2);
  assert.equal(exitCodeFor('FAILED', true), 2);
});

test('runnerMatches uses basenames and globs the §4.8 list', () => {
  assert.equal(runnerMatches('package.json'), true);
  assert.equal(runnerMatches('sub/deep/package.json'), true);
  assert.equal(runnerMatches('jest.config.ts'), true);
  assert.equal(runnerMatches('apps/web/vite.config.mjs'), true);
  assert.equal(runnerMatches('.mocharc.yml'), true);
  assert.equal(runnerMatches('Makefile'), true);
  assert.equal(runnerMatches('my-package.json'), false);
  assert.equal(runnerMatches('package.json.bak'), false);
  assert.equal(runnerMatches('src/package.jsonx'), false);
});
