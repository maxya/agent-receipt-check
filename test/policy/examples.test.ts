import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateCriteriaBytes } from '../../src/criteria/schema.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

test('examples/receipt.criteria.json validates', () => {
  const file = path.join(ROOT, 'examples/receipt.criteria.json');
  const bytes = fs.readFileSync(file);
  const result = validateCriteriaBytes(bytes, { root: ROOT, label: 'examples/receipt.criteria.json' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.ok(result.value);
  assert.equal(result.value.criteria.length, 7);
  assert.equal(result.value.claim, 'Add a /health endpoint and make the suite green');
});
