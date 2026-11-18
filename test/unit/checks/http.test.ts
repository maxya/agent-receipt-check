import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runHttpCheck } from '../../../src/checks/http.js';
import type { HttpCriterion } from '../../../src/types.js';
import { makeTempDir } from '../../helpers/repo.js';
import { startStub } from '../../helpers/stub-server.js';
import { makeCtx } from './helpers.js';

async function run(c: Omit<HttpCriterion, 'id' | 'type'>, root: string, secrets = []) {
  return runHttpCheck({ id: 'h', type: 'http', ...c }, makeCtx(root, null, null, secrets));
}

test('http: PASS on 200 with bodyContains', async () => {
  const dir = await makeTempDir();
  const stub = await startStub((_req, res) => {
    res.statusCode = 200;
    res.end('all healthy');
  });
  try {
    const r = await run({ url: `${stub.url}/health`, expect: { status: 200, bodyContains: 'healthy' } }, dir.dir);
    assert.equal(r.verdict, 'PASS');
    assert.match(r.reason, /→ 200/);
  } finally {
    await stub.close();
    dir.cleanup();
  }
});

test('http: FAIL on 503 when 200 was expected', async () => {
  const dir = await makeTempDir();
  const stub = await startStub((_req, res) => {
    res.statusCode = 503;
    res.end('down');
  });
  try {
    const r = await run({ url: `${stub.url}/x`, expect: { status: 200 } }, dir.dir);
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, 'expected 200, got 503');
  } finally {
    await stub.close();
    dir.cleanup();
  }
});

test('http: FAIL on a body mismatch', async () => {
  const dir = await makeTempDir();
  const stub = await startStub((_req, res) => {
    res.statusCode = 200;
    res.end('ok');
  });
  try {
    const r = await run({ url: stub.url, expect: { bodyContains: 'nope' } }, dir.dir);
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, 'body lacks "nope"');
  } finally {
    await stub.close();
    dir.cleanup();
  }
});

test('http: a redirect is not followed (3xx is the observed status)', async () => {
  const dir = await makeTempDir();
  const stub = await startStub((_req, res) => {
    res.statusCode = 302;
    res.setHeader('location', '/elsewhere');
    res.end();
  });
  try {
    const r = await run({ url: `${stub.url}/x`, expect: { status: 200 } }, dir.dir);
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, 'expected 200, got 302');
    assert.equal(stub.requests.length, 1);
  } finally {
    await stub.close();
    dir.cleanup();
  }
});

test('http: a closed port is UNVERIFIED (connection refused)', async () => {
  const dir = await makeTempDir();
  const stub = await startStub();
  const url = stub.url;
  await stub.close();
  try {
    const r = await run({ url }, dir.dir);
    assert.equal(r.verdict, 'UNVERIFIED');
    assert.equal(r.reason, 'connection refused');
  } finally {
    dir.cleanup();
  }
});

test('http: a trickling server still hits the total deadline', async () => {
  const dir = await makeTempDir();
  const stub = await startStub(() => {
    // never respond
  });
  try {
    const r = await run({ url: stub.url, timeoutMs: 200 }, dir.dir);
    assert.equal(r.verdict, 'UNVERIFIED');
    assert.equal(r.reason, 'timed out after 0.2s');
  } finally {
    await stub.close();
    dir.cleanup();
  }
});

test('http: an unset header env var is UNVERIFIED', async () => {
  const dir = await makeTempDir();
  const stub = await startStub();
  const name = 'ARC_TEST_DEFINITELY_UNSET_TOKEN';
  delete process.env[name];
  try {
    const r = await run(
      { url: stub.url, headers: { Authorization: { env: name } } },
      dir.dir,
    );
    assert.equal(r.verdict, 'UNVERIFIED');
    assert.equal(r.reason, `env ${name} not set`);
  } finally {
    await stub.close();
    dir.cleanup();
  }
});

test('http: sends {env} header values but never prints them', async () => {
  const dir = await makeTempDir();
  const token = ['s3cr3t', 'header', 'value'].join('-');
  process.env.ARC_HEADER_TOKEN = token;
  const stub = await startStub((_req, res) => {
    res.statusCode = 200;
    res.end('ok');
  });
  try {
    const r = await run(
      { url: stub.url, headers: { Authorization: { env: 'ARC_HEADER_TOKEN' } } },
      dir.dir,
    );
    assert.equal(r.verdict, 'PASS');
    assert.equal(stub.requests[0]?.headers.authorization, token);
    assert.ok(!r.evidence.includes(token));
    assert.ok(!r.reason.includes(token));
  } finally {
    delete process.env.ARC_HEADER_TOKEN;
    await stub.close();
    dir.cleanup();
  }
});

test('http: sets a user-agent by default', async () => {
  const dir = await makeTempDir();
  const stub = await startStub();
  try {
    const r = await run({ url: stub.url }, dir.dir);
    assert.equal(r.verdict, 'PASS');
    assert.match(String(stub.requests[0]?.headers['user-agent']), /^agent-receipt-check\//);
  } finally {
    await stub.close();
    dir.cleanup();
  }
});

test('http: evidence never includes the body', async () => {
  const dir = await makeTempDir();
  const stub = await startStub((_req, res) => {
    res.statusCode = 200;
    res.end('BODY-SECRET-VALUE');
  });
  try {
    const r = await run({ url: stub.url, expect: { bodyContains: 'BODY-SECRET-VALUE' } }, dir.dir);
    assert.equal(r.verdict, 'PASS');
    assert.ok(!r.evidence.includes('BODY-SECRET-VALUE'));
    assert.ok(!r.reason.includes('BODY-SECRET-VALUE'));
  } finally {
    await stub.close();
    dir.cleanup();
  }
});
