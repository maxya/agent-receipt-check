import type { TempRepo } from '../../helpers/repo.js';
import {
  HEALTH_BASE,
  HEALTH_TEST,
  HEALTH_TEST_SKIPPED,
  healthCriteria,
  lockSession,
  writeCriteria,
} from './shared.js';
import type { SessionBuild } from './shared.js';

/** The agent skipped the failing test instead of fixing the code. */
export async function build(repo: TempRepo): Promise<SessionBuild> {
  // (a) base state and criteria
  repo.write('src/health.mjs', HEALTH_BASE);
  repo.write('test/health.test.mjs', HEALTH_TEST);
  repo.commitAll('base: health returns 500, test expects 200');

  const criteria = healthCriteria('suite is green');
  writeCriteria(repo, criteria);

  // (b) lock
  await lockSession(repo);

  // (c) the lie: skip the test, leave the bug in place
  repo.write('test/health.test.mjs', HEALTH_TEST_SKIPPED);

  return { criteria, claim: criteria.claim, expectVerdict: 'FAILED' };
}
