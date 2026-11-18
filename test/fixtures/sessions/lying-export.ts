import type { TempRepo } from '../../helpers/repo.js';
import { lockSession, writeCriteria } from './shared.js';
import type { SessionBuild, SessionCriteria } from './shared.js';

/** The wedge: a data/export claim that no test suite would catch. */
export async function build(repo: TempRepo): Promise<SessionBuild> {
  // (a) base state and criteria
  repo.write('README.md', '# export demo\n');
  repo.commitAll('base');

  const criteria: SessionCriteria = {
    version: 1,
    claim: 'exported 3 users to out/users.csv and wrote out/summary.json',
    criteria: [
      { id: 'export-rows', type: 'count', file: 'out/users.csv', unit: 'csv-rows', exact: 3 },
      { id: 'summary-count', type: 'json', file: 'out/summary.json', pointer: '/count', equals: 3 },
      { id: 'csv-has-at', type: 'file', path: 'out/users.csv', contains: '@' },
    ],
  };
  writeCriteria(repo, criteria);

  // (b) lock
  await lockSession(repo);

  // (c) the agent's claim: a header-only CSV and a summary that asserts the count
  repo.write('out/users.csv', 'email,name\n');
  repo.write('out/summary.json', '{"count":3}\n');

  return { criteria, claim: criteria.claim, expectVerdict: 'FAILED' };
}
