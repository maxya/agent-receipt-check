import type { TempRepo } from '../../helpers/repo.js';
import { lockSession, writeCriteria } from './shared.js';
import type { SessionBuild, SessionCriteria } from './shared.js';

/** The agent deletes the criterion it cannot pass and commits the edit. */
export async function build(repo: TempRepo): Promise<SessionBuild> {
  // (a) base state and criteria
  repo.write('x.txt', 'x');
  repo.commitAll('base');

  const criteria: SessionCriteria = {
    version: 1,
    claim: 'everything the criteria asked for is done',
    criteria: [
      { id: 'must-export', type: 'file', path: 'out/users.csv', contains: '@' },
      { id: 'x-exists', type: 'file', path: 'x.txt' },
    ],
  };
  writeCriteria(repo, criteria);

  // (b) lock
  await lockSession(repo);

  // (c) the tamper: drop the failing criterion and commit the change
  const trimmed: SessionCriteria = {
    version: 1,
    claim: criteria.claim,
    criteria: [{ id: 'x-exists', type: 'file', path: 'x.txt' }],
  };
  writeCriteria(repo, trimmed);
  repo.commitAll('trim the criteria');

  return { criteria, claim: criteria.claim, expectVerdict: 'FAILED' };
}
