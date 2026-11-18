import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { VERSION } from '../../src/version.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, '../../..', 'package.json'), 'utf8')) as {
  version: string;
};

test('VERSION matches package.json', () => {
  assert.equal(VERSION, pkg.version);
});
