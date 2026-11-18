import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runCli } from '../helpers/cli.js';
import { makeTempRepo } from '../helpers/repo.js';
import { startStub } from '../helpers/stub-server.js';

/** Built at runtime so no secret-shaped literal is committed (§0 rules). */
const TOKEN = ['gh', 'p_', 'Z'.repeat(36)].join('');
const ENV_SECRET = 's3cr3t-value-123456';
const URL_PASSWORD = 'pass1234';
const URL_QUERY = 'abc12345';

function assertClean(label: string, text: string): void {
  for (const value of [TOKEN, ENV_SECRET, URL_PASSWORD, URL_QUERY]) {
    assert.equal(text.includes(value), false, `${label} leaked ${value}`);
  }
}

test('secrets never reach stdout, stderr, the receipt, or receipt show', async () => {
  const repo = await makeTempRepo();
  const stub = await startStub((req, res) => {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ headers: req.headers }));
  });
  try {
    repo.write('x.txt', 'x');
    repo.commitAll('base');

    const criteria = {
      version: 1,
      claim: `token ${TOKEN} was used`,
      criteria: [
        {
          id: 'leaky-test',
          type: 'test',
          command: `node -e "console.log(process.argv[1]); console.log(process.env.FAKE_API_TOKEN)" ${TOKEN}`,
          expect: { stdoutContains: 'nope' },
        },
        {
          id: 'header-auth',
          type: 'http',
          url: `${stub.url}/auth`,
          headers: { Authorization: { env: 'FAKE_API_TOKEN' } },
          expect: { status: 200 },
        },
        {
          id: 'url-auth',
          type: 'http',
          url: `http://user:${URL_PASSWORD}@127.0.0.1:${stub.port}/x?token=${URL_QUERY}`,
          expect: { status: 200 },
        },
      ],
    };
    repo.write('receipt.criteria.json', JSON.stringify(criteria));
    const locked = await runCli(['lock'], { cwd: repo.dir, env: repo.env });
    assert.equal(locked.code, 0, locked.stderr);

    const env = { ...repo.env, FAKE_API_TOKEN: ENV_SECRET };

    const human = await runCli(['verify', '--out', 'r1.json'], { cwd: repo.dir, env });
    assert.equal(human.code, 2, human.stderr);
    assertClean('human stdout', human.stdout);
    assertClean('human stderr', human.stderr);
    assert.match(human.stdout, /\[REDACTED/);

    const json = await runCli(['verify', '--json', '--out', 'r2.json'], { cwd: repo.dir, env });
    assert.equal(json.code, 2, json.stderr);
    assertClean('--json stdout', json.stdout);
    assertClean('--json stderr', json.stderr);

    const receipt1 = fs.readFileSync(path.join(repo.dir, 'r1.json'), 'utf8');
    const receipt2 = fs.readFileSync(path.join(repo.dir, 'r2.json'), 'utf8');
    assertClean('receipt r1', receipt1);
    assertClean('receipt r2', receipt2);
    assert.match(receipt1, /\[REDACTED:env:FAKE_API_TOKEN\]/);
    assert.match(receipt1, /\[REDACTED\]/);
    assert.equal(receipt1.includes(URL_QUERY), false);
    assert.equal(receipt1.includes(URL_PASSWORD), false);

    const shown = await runCli(['receipt', 'show', path.join(repo.dir, 'r1.json')], {
      cwd: repo.dir,
      env,
    });
    assert.equal(shown.code, 0, shown.stderr);
    assertClean('receipt show stdout', shown.stdout);
    assertClean('receipt show stderr', shown.stderr);
  } finally {
    await stub.close();
    repo.cleanup();
  }
});
