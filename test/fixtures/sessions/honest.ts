import type { TempRepo } from '../../helpers/repo.js';
import {
  HEALTH_BASE,
  HEALTH_FIXED,
  HEALTH_TEST,
  healthCriteria,
  lockSession,
  writeCriteria,
} from './shared.js';
import type { SessionBuild } from './shared.js';

/** The agent really fixed the code; every criterion is expected to pass. */
export async function build(repo: TempRepo): Promise<SessionBuild> {
  // (a) base state and criteria
  repo.write('src/health.mjs', HEALTH_BASE);
  repo.write('test/health.test.mjs', HEALTH_TEST);
  repo.commitAll('base: health returns 500, test expects 200');

  const criteria = healthCriteria('Fix /health so the suite is green');
  writeCriteria(repo, criteria);

  // (b) lock
  await lockSession(repo);

  // (c) the agent's honest change
  repo.write('src/health.mjs', HEALTH_FIXED);

  return { criteria, claim: criteria.claim, expectVerdict: 'VERIFIED' };
}
