import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runCli } from '../helpers/cli.js';
import { makeTempRepo } from '../helpers/repo.js';

test('lock and verify never dirty the working tree', async () => {
  const repo = await makeTempRepo();
  try {
    repo.write('x.txt', 'x');
    repo.commitAll('base');
    repo.write(
      'receipt.criteria.json',
      JSON.stringify({ version: 1, criteria: [{ id: 'x', type: 'file', path: 'x.txt' }] }),
    );

    const before = repo.git(['status', '--porcelain']);
    const locked = await runCli(['lock'], { cwd: repo.dir, env: repo.env });
    assert.equal(locked.code, 0, locked.stderr);
    assert.equal(repo.git(['status', '--porcelain']), before);

    const verified = await runCli(['verify'], { cwd: repo.dir, env: repo.env });
    assert.equal(verified.code, 0, verified.stderr);
    assert.equal(repo.git(['status', '--porcelain']), before);

    const receipts = fs.readdirSync(path.join(repo.dir, '.git/agent-receipt/receipts'));
    assert.equal(receipts.length, 1);
    assert.equal(repo.git(['status', '--porcelain']), before);
  } finally {
    repo.cleanup();
  }
});
