import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

interface PackageJson {
  bin?: Record<string, string>;
  files?: string[];
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as PackageJson;

test('package.json has no runtime dependencies at all', () => {
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.optionalDependencies, undefined);
  assert.equal(pkg.peerDependencies, undefined);
});

test('devDependencies are exactly typescript and @types/node', () => {
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}).sort(), ['@types/node', 'typescript']);
});

test('there are no install-lifecycle scripts', () => {
  const scripts = pkg.scripts ?? {};
  for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(scripts[name], undefined, `unexpected ${name} script`);
  }
});

test('bin points at dist/cli.js and files includes dist', () => {
  assert.equal(pkg.bin?.['agent-receipt-check'], 'dist/cli.js');
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes('dist'));
});

test('the Node floor is >=22', () => {
  assert.equal(pkg.engines?.node, '>=22');
});
