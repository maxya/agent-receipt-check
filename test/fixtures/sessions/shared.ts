import type { Criterion } from '../../../src/types.js';
import { runCli } from '../../helpers/cli.js';
import type { TempRepo } from '../../helpers/repo.js';

export interface SessionCriteria {
  version: 1;
  claim: string;
  criteria: Criterion[];
}

export interface SessionBuild {
  criteria: SessionCriteria;
  claim: string;
  expectVerdict: 'VERIFIED' | 'FAILED';
}

export function writeCriteria(repo: TempRepo, criteria: SessionCriteria): void {
  repo.write('receipt.criteria.json', `${JSON.stringify(criteria, null, 2)}\n`);
}

/** Step (b) of every session fixture. */
export async function lockSession(repo: TempRepo): Promise<void> {
  const result = await runCli(['lock'], { cwd: repo.dir, env: repo.env });
  if (result.code !== 0) {
    throw new Error(`session lock failed (${result.code}): ${result.stderr}`);
  }
}

export const HEALTH_BASE = 'export function status() {\n  return 500;\n}\n';
export const HEALTH_FIXED = 'export function status() {\n  return 200;\n}\n';

export const HEALTH_TEST = `import test from 'node:test';
import assert from 'node:assert/strict';
import { status } from '../src/health.mjs';

test('health returns 200', () => {
  assert.equal(status(), 200);
});
`;

export const HEALTH_TEST_SKIPPED = `import test from 'node:test';

test.skip('health returns 200', () => {});
`;

/** The shared criteria for the honest and lying-skip sessions. */
export function healthCriteria(claim: string): SessionCriteria {
  return {
    version: 1,
    claim,
    criteria: [
      {
        id: 'suite-green',
        type: 'test',
        command: 'node --test --test-reporter=tap "test/*.test.mjs"',
        expect: { exit: 0, stdoutContains: '# skipped 0' },
      },
      { id: 'tests-untouched', type: 'diff', path: 'test/', changed: false },
      { id: 'health-changed', type: 'diff', path: 'src/health.mjs', changed: true },
    ],
  };
}
