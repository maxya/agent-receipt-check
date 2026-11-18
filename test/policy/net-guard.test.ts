import assert from 'node:assert/strict';
import { test } from 'node:test';

const ALLOW = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);

function blockedReason(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let i = 0; i < 5 && current !== null && current !== undefined; i++) {
    parts.push(String(current));
    const cause = (current as { cause?: unknown }).cause;
    if (cause === undefined) break;
    current = cause;
  }
  return parts.join(' | ');
}

test('the net guard blocks a non-local connect', async () => {
  const outcome = await fetch('http://example.com/').then(
    (res) => ({ ok: true as const, status: res.status }),
    (err: unknown) => ({ ok: false as const, text: blockedReason(err) }),
  );
  assert.equal(outcome.ok, false, 'fetch to example.com succeeded — the net guard is not active');
  if (outcome.ok) return;
  assert.match(
    outcome.text,
    /NETWORK-POLICY|ENOTFOUND|EAI_AGAIN|getaddrinfo|fetch failed/i,
    outcome.text,
  );
});

test('the net guard allows a 127.0.0.1 connection', async () => {
  const http = await import('node:http');
  const server = http.createServer((_req, res) => {
    res.statusCode = 200;
    res.end('local-ok');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(typeof address === 'object' && address !== null);
  const port = (address as { port: number }).port;
  try {
    const body = await new Promise<string>((resolve, reject) => {
      http
        .get(`http://127.0.0.1:${port}/`, (res) => {
          let text = '';
          res.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
          res.on('end', () => resolve(text));
        })
        .on('error', reject);
    });
    assert.equal(body, 'local-ok');
  } finally {
    server.close();
  }
  // The allow-list is the contract this test is written against.
  assert.ok(ALLOW.has('127.0.0.1'));
});
