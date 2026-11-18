import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collectEnvSecrets,
  excerpt,
  isSecretEnvName,
  redact,
  redactUrl,
  stripAnsi,
} from '../../src/redact.js';

test('secret env names match whole underscore-separated segments', () => {
  for (const name of [
    'GITHUB_TOKEN',
    'NPM_TOKEN',
    'AWS_SECRET_ACCESS_KEY',
    'OPENAI_API_KEY',
    'DB_PASSWORD',
    'FAKE_API_TOKEN',
  ]) {
    assert.equal(isSecretEnvName(name), true, name);
  }
  for (const name of [
    'PWD',
    'OLDPWD',
    'SSH_AUTH_SOCK',
    'XAUTHORITY',
    'GIT_AUTHOR_NAME',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_SESSION_TYPE',
    'TOKENIZERS_PARALLELISM',
    'PGPASS',
  ]) {
    assert.equal(isSecretEnvName(name), false, name);
  }
});

test('collectEnvSecrets skips short values and sorts longest first', () => {
  const secrets = collectEnvSecrets({
    A_TOKEN: '12345',
    B_TOKEN: '123456789',
    C_TOKEN: '1234567',
    ORDINARY_VALUE: 'abcdefgh',
  });
  assert.deepEqual(secrets, [
    { name: 'B_TOKEN', value: '123456789' },
    { name: 'C_TOKEN', value: '1234567' },
  ]);
});

test('known secret values are replaced with a named marker', () => {
  const secrets = [{ name: 'FAKE_API_TOKEN', value: 's3cr3t-value-123456' }];
  assert.equal(
    redact('token is s3cr3t-value-123456 ok', secrets),
    'token is [REDACTED:env:FAKE_API_TOKEN] ok',
  );
});

test('AWS key id', () => {
  const token = `AKIA${'B'.repeat(16)}`;
  assert.equal(redact(token), '[REDACTED]');
});

test('GitHub tokens (classic and fine-grained)', () => {
  assert.equal(redact(`gh${'p_'}${'A'.repeat(36)}`), '[REDACTED]');
  assert.equal(redact(`github_pat_${'A'.repeat(22)}`), '[REDACTED]');
});

test('LLM, Slack, npm, Google, Stripe, JWT patterns', () => {
  assert.equal(redact(`sk-proj-${'a'.repeat(20)}`), '[REDACTED]');
  assert.equal(redact(`xoxb-${'1'.repeat(12)}`), '[REDACTED]');
  assert.equal(redact(`npm_${'a'.repeat(36)}`), '[REDACTED]');
  assert.equal(redact(`AIza${'a'.repeat(35)}`), '[REDACTED]');
  assert.equal(redact(`sk_live_${'a'.repeat(16)}`), '[REDACTED]');
  const jwt = `eyJ${'a'.repeat(8)}.${'b'.repeat(8)}.${'c'.repeat(8)}`;
  assert.equal(redact(jwt), '[REDACTED]');
});

test('Bearer and Basic credentials', () => {
  assert.equal(redact('Bearer abcdefghijklmnop'), 'Bearer [REDACTED]');
  assert.equal(redact('Basic dXNlcjpwYXNzd29yZA=='), 'Basic [REDACTED]');
  assert.equal(redact('Basic configuration settings'), 'Basic configuration settings');
});

test('private key blocks', () => {
  const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----`;
  assert.equal(redact(`x ${pem} y`), 'x [REDACTED] y');
});

test('key=value redaction covers the required cases', () => {
  const cases: Array<[string, string]> = [
    ['"password":"hunter22"', '"password":"[REDACTED]"'],
    ['{"api_key": "abcd1234"}', '{"api_key": "[REDACTED]"}'],
    ['password="hunter 22"', 'password="[REDACTED]"'],
    ['password=hunter22', 'password=[REDACTED]'],
    ['GITHUB_TOKEN=abcd1234x', 'GITHUB_TOKEN=[REDACTED]'],
    ['Authorization: abcdefgh123', 'Authorization: [REDACTED]'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(redact(input), expected, input);
  }
});

test('URL userinfo is removed, including a user-only token', () => {
  const out = redact('http://user:p@ss1234@host/x');
  assert.equal(out, 'http://[REDACTED]@host/x');
  assert.ok(!out.includes('ss1234'));
  assert.equal(redact('https://TOKEN@host/x'), 'https://[REDACTED]@host/x');
});

test('ordinary words and non-secrets are untouched', () => {
  for (const text of [
    'author: Maxim',
    'authority: example.com',
    'oauth_callback=https://x',
    'tokens: 5',
    'the secret is out',
    'see http://example.com/a@b',
    'git@github.com:x/y',
    'sha256 4be1c09d77aa',
  ]) {
    assert.equal(redact(text), text, text);
  }
});

test('redact before truncating keeps a token whole', () => {
  const token = `gh${'p_'}${'A'.repeat(36)}`;
  const text = `${'x'.repeat(390)} ${token}`;
  const out = excerpt(redact(text), 30, 'tail');
  assert.ok(!out.includes('ghp_'), out);
  assert.ok(out.includes('[REDACTED]'), out);
});

test('excerpt keeps the head or the tail, by code point', () => {
  assert.equal(excerpt('abcdef', 3, 'head'), 'abc…');
  assert.equal(excerpt('abcdef', 3, 'tail'), '…def');
  assert.equal(excerpt('  a\n\t b  ', 20), 'a b');
  assert.equal(excerpt('😀😀😀😀', 2, 'head'), '😀😀…');
  assert.equal(Array.from(excerpt('😀😀😀😀', 2, 'head')).length, 3);
});

test('redactUrl drops userinfo and sensitive query values', () => {
  assert.equal(
    redactUrl('http://user:pass1234@127.0.0.1:8080/x?token=abc12345&x=1'),
    'http://127.0.0.1:8080/x?token=[REDACTED]&x=1',
  );
});

test('stripAnsi removes colour codes', () => {
  assert.equal(stripAnsi('\u001b[31mFAIL\u001b[0m ok'), 'FAIL ok');
});
