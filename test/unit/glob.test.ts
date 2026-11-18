import assert from 'node:assert/strict';
import { test } from 'node:test';
import { globToRegExp } from '../../src/glob.js';

test('* does not cross a slash', () => {
  assert.equal(globToRegExp('*.json').test('a.json'), true);
  assert.equal(globToRegExp('*.json').test('a/b.json'), false);
});

test('**/ matches zero or more leading directories', () => {
  const re = globToRegExp('**/*.ts');
  assert.equal(re.test('x.ts'), true);
  assert.equal(re.test('a/b/x.ts'), true);
  assert.equal(re.test('a/b/x.js'), false);
});

test('/** at the end matches everything below', () => {
  const re = globToRegExp('src/**');
  assert.equal(re.test('src/a/b'), true);
  assert.equal(re.test('src/a'), true);
  assert.equal(re.test('srcx/a'), false);
});

test('** in the middle', () => {
  const re = globToRegExp('a/**/b');
  assert.equal(re.test('a/b'), true);
  assert.equal(re.test('a/x/y/b'), true);
});

test('brace alternatives', () => {
  const re = globToRegExp('{a,b}.csv');
  assert.equal(re.test('a.csv'), true);
  assert.equal(re.test('b.csv'), true);
  assert.equal(re.test('c.csv'), false);
  assert.equal(re.test('a.csvx'), false);
});

test('? matches exactly one non-slash character', () => {
  const re = globToRegExp('a?c');
  assert.equal(re.test('abc'), true);
  assert.equal(re.test('a/c'), false);
  assert.equal(re.test('ac'), false);
});

test('regex metacharacters are escaped', () => {
  assert.equal(globToRegExp('a.b+c(d)').test('a.b+c(d)'), true);
  assert.equal(globToRegExp('a.b').test('axb'), false);
  assert.equal(globToRegExp('a+b').test('aaab'), false);
});

test('dotfiles are matched by *', () => {
  assert.equal(globToRegExp('*').test('.env'), true);
});
