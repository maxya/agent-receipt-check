import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateCriteriaBytes } from '../../src/criteria/schema.js';

const root = process.cwd();

function validate(value: unknown): ReturnType<typeof validateCriteriaBytes> {
  return validateCriteriaBytes(Buffer.from(JSON.stringify(value)), { root, label: 'criteria.json' });
}

function base(criteria: unknown[]): Record<string, unknown> {
  return { version: 1, criteria };
}

function errorsOf(value: unknown): string {
  return validate(value).errors.join('\n');
}

const kitchenSink = {
  version: 1,
  claim: 'do the thing',
  criteria: [
    {
      id: 't',
      type: 'test',
      command: 'node -v',
      cwd: 'sub',
      timeoutMs: 1000,
      expect: {
        exit: 0,
        stdoutContains: ['a', 'b'],
        stdoutNotContains: 'c',
        stderrContains: 'd',
        stderrNotContains: ['e'],
      },
    },
    {
      id: 'f',
      type: 'file',
      path: 'a.txt',
      exists: true,
      contains: 'x',
      notContains: ['y'],
      matches: '^x$',
      sha256: 'A'.repeat(64),
    },
    { id: 'd', type: 'diff', path: 'test/', changed: false },
    {
      id: 'h',
      type: 'http',
      url: 'http://localhost:3000/x',
      timeoutMs: 100,
      headers: { Authorization: { env: 'TOKEN' }, 'X-Lit': 'v' },
      expect: {
        status: [200, 201],
        bodyContains: 'ok',
        bodyNotContains: ['bad'],
        bodyMatches: 'ok$',
      },
    },
    { id: 'c1', type: 'count', dir: 'out', glob: '**/*', min: 1, max: 10 },
    { id: 'c2', type: 'count', file: 'out/x.csv', unit: 'csv-rows', exact: 3 },
    { id: 'j', type: 'json', file: 'x.json', pointer: '/a~1b/~0c/0', min: 1, max: 2 },
  ],
};

test('kitchen-sink criteria validate and sha256 is normalised', () => {
  const result = validate(kitchenSink);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  const file = result.value?.criteria.find((c) => c.id === 'f');
  assert.equal((file as { sha256?: string }).sha256, 'a'.repeat(64));
});

test('a BOM-prefixed file parses', () => {
  const bytes = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(JSON.stringify(base([{ id: 'a', type: 'file', path: 'x' }]))),
  ]);
  const result = validateCriteriaBytes(bytes, { root });
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('missing version is an error', () => {
  assert.match(errorsOf({ criteria: [] }), /version is required/);
});

test('version must be 1', () => {
  assert.match(errorsOf({ version: 2, criteria: [] }), /version: must be 1/);
});

test('missing criteria is an error', () => {
  assert.match(errorsOf({ version: 1 }), /criteria is required/);
});

test('criteria must not be empty', () => {
  assert.match(errorsOf({ version: 1, criteria: [] }), /must not be empty/);
});

test('criteria must be an array', () => {
  assert.match(errorsOf({ version: 1, criteria: {} }), /must be an array/);
});

test('unknown top-level key is an error', () => {
  assert.match(errorsOf({ version: 1, criteria: [], stauts: 1 }), /unknown key "stauts"/);
});

test('criterion id is required', () => {
  assert.match(errorsOf(base([{ type: 'file', path: 'x' }])), /id: is required/);
});

test('criterion id charset is enforced', () => {
  assert.match(errorsOf(base([{ id: '-x', type: 'file', path: 'x' }])), /must match/);
});

test('duplicate ids are rejected', () => {
  const out = errorsOf(
    base([
      { id: 'same', type: 'file', path: 'x' },
      { id: 'same', type: 'file', path: 'y' },
    ]),
  );
  assert.match(out, /duplicate id/);
});

test('criterion type is required', () => {
  assert.match(errorsOf(base([{ id: 'a' }])), /type: is required/);
});

test('unknown criterion type is rejected', () => {
  assert.match(errorsOf(base([{ id: 'a', type: 'sqlite' }])), /must be one of/);
});

test('unknown criterion key is rejected', () => {
  assert.match(errorsOf(base([{ id: 'a', type: 'file', path: 'x', stauts: 1 }])), /unknown key "stauts"/);
});

test('test requires a command', () => {
  assert.match(errorsOf(base([{ id: 'a', type: 'test' }])), /command: is required/);
});

test('unknown key inside expect is rejected', () => {
  assert.match(
    errorsOf(base([{ id: 'a', type: 'test', command: 'x', expect: { stauts: 1 } }])),
    /expect: unknown key "stauts"/,
  );
});

test('timeoutMs range is enforced', () => {
  assert.match(
    errorsOf(base([{ id: 'a', type: 'test', command: 'x', timeoutMs: 5 }])),
    /at least 100/,
  );
});

test('file requires a path', () => {
  assert.match(errorsOf(base([{ id: 'a', type: 'file' }])), /path: is required/);
});

test('file exists:false forbids content fields', () => {
  assert.match(
    errorsOf(base([{ id: 'a', type: 'file', path: 'x', exists: false, contains: 'y' }])),
    /not allowed when exists is false/,
  );
});

test('file sha256 must be 64 hex characters', () => {
  assert.match(errorsOf(base([{ id: 'a', type: 'file', path: 'x', sha256: 'abc' }])), /64 hex/);
});

test('diff requires a path', () => {
  assert.match(errorsOf(base([{ id: 'a', type: 'diff' }])), /path: is required/);
});

test('http rejects non-http URLs', () => {
  assert.match(
    errorsOf(base([{ id: 'a', type: 'http', url: 'ftp://example.com/x' }])),
    /http or https/,
  );
});

test('http rejects malformed URLs', () => {
  assert.match(errorsOf(base([{ id: 'a', type: 'http', url: 'not a url' }])), /valid URL/);
});

test('http header objects only allow env', () => {
  assert.match(
    errorsOf(
      base([{ id: 'a', type: 'http', url: 'http://x/y', headers: { A: { value: 'x' } } }]),
    ),
    /unknown key "value"/,
  );
});

test('count requires exactly one of dir or file', () => {
  assert.match(
    errorsOf(base([{ id: 'a', type: 'count', dir: 'x', file: 'y', min: 1 }])),
    /exactly one of dir or file/,
  );
  assert.match(errorsOf(base([{ id: 'a', type: 'count', min: 1 }])), /exactly one of dir or file/);
});

test('count requires a range', () => {
  assert.match(
    errorsOf(base([{ id: 'a', type: 'count', dir: 'x' }])),
    /one of min\/max\/exact is required/,
  );
});

test('count unit is restricted', () => {
  assert.match(
    errorsOf(base([{ id: 'a', type: 'count', file: 'x', unit: 'bytes', exact: 1 }])),
    /must be one of lines, csv-rows, jsonl/,
  );
});

test('count glob must not be empty', () => {
  assert.match(
    errorsOf(base([{ id: 'a', type: 'count', dir: 'x', glob: '', min: 1 }])),
    /glob: must not be empty/,
  );
});

test('json rejects two assertions', () => {
  assert.match(
    errorsOf(base([{ id: 'a', type: 'json', file: 'x', pointer: '', exists: true, is: 'object' }])),
    /exactly one assertion/,
  );
});

test('json requires an assertion', () => {
  assert.match(
    errorsOf(base([{ id: 'a', type: 'json', file: 'x', pointer: '' }])),
    /exactly one assertion/,
  );
});

test('json pointer must start with a slash', () => {
  assert.match(
    errorsOf(base([{ id: 'a', type: 'json', file: 'x', pointer: 'a/b', exists: true }])),
    /must be empty or start with/,
  );
});

test('json pointer rejects bad escapes', () => {
  assert.match(
    errorsOf(base([{ id: 'a', type: 'json', file: 'x', pointer: '/a~2b', exists: true }])),
    /invalid RFC 6901 escape/,
  );
});

test('bad regexes are rejected', () => {
  assert.match(
    errorsOf(base([{ id: 'a', type: 'file', path: 'x', matches: '(' }])),
    /invalid regex/,
  );
});

test('absolute paths are rejected', () => {
  assert.match(
    errorsOf(base([{ id: 'a', type: 'file', path: '/etc/passwd' }])),
    /must be a relative path/,
  );
});

test('paths that escape root are rejected', () => {
  assert.match(
    errorsOf(base([{ id: 'a', type: 'file', path: '../x' }])),
    /path escapes root/,
  );
});

test('float numbers are rejected everywhere', () => {
  assert.match(
    errorsOf(base([{ id: 'a', type: 'json', file: 'x', pointer: '', equals: { n: 1.5 } }])),
    /non-integer numbers are not supported/,
  );
});

test('exact cannot be combined with min', () => {
  assert.match(
    errorsOf(base([{ id: 'a', type: 'count', dir: 'x', exact: 1, min: 1 }])),
    /cannot be combined/,
  );
});

test('min must not exceed max', () => {
  assert.match(
    errorsOf(base([{ id: 'a', type: 'count', dir: 'x', min: 5, max: 1 }])),
    /must not be greater than max/,
  );
});

test('claim length is capped', () => {
  assert.match(
    errorsOf({ version: 1, claim: 'x'.repeat(2001), criteria: [{ id: 'a', type: 'file', path: 'x' }] }),
    /at most 2000/,
  );
});

test('description length is capped', () => {
  assert.match(
    errorsOf(base([{ id: 'a', type: 'file', path: 'x', description: 'x'.repeat(501) }])),
    /at most 500/,
  );
});

test('more than 200 criteria are rejected', () => {
  const many = Array.from({ length: 201 }, (_, i) => ({
    id: `a${i}`,
    type: 'file',
    path: 'x',
  }));
  assert.match(errorsOf(base(many)), /at most 200 items/);
});

test('empty string arrays are rejected', () => {
  assert.match(
    errorsOf(base([{ id: 'a', type: 'file', path: 'x', contains: [] }])),
    /must not be an empty array/,
  );
});

test('all errors are collected, not just the first', () => {
  const errors = validate(base([{ id: '-a', type: 'nope' }, { id: 'b', type: 'file' }])).errors;
  assert.ok(errors.length >= 3, errors.join('\n'));
});
