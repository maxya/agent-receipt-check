import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runCli } from '../helpers/cli.js';
import { makeTempRepo } from '../helpers/repo.js';

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

test('SIGINT kills the running test command process group (no orphan)', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process groups only');
    return;
  }
  const repo = await makeTempRepo();
  try {
    repo.write('x.txt', 'x');
    repo.commitAll('base');
    repo.write(
      'receipt.criteria.json',
      JSON.stringify({
        version: 1,
        criteria: [
          {
            id: 'slow',
            type: 'test',
            command:
              'node -e "require(\'node:fs\').writeFileSync(\'pid.txt\', String(process.pid)); setTimeout(()=>{}, 60000)"',
            timeoutMs: 120_000,
          },
        ],
      }),
    );
    const locked = await runCli(['lock'], { cwd: repo.dir, env: repo.env });
    assert.equal(locked.code, 0, locked.stderr);

    let cli: ChildProcess | null = null;
    const pending = runCli(['verify'], {
      cwd: repo.dir,
      env: repo.env,
      onSpawn: (child) => {
        cli = child;
      },
    });

    const pidFile = path.join(repo.dir, 'pid.txt');
    const appeared = await waitFor(() => fs.existsSync(pidFile), 20_000);
    assert.ok(appeared, 'the nested test command never started');
    const nestedPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isInteger(nestedPid) && nestedPid > 0);

    assert.notEqual(cli, null);
    (cli as unknown as ChildProcess).kill('SIGINT');
    const result = await pending;
    assert.equal(result.code, 130, result.stderr);

    const gone = await waitFor(() => {
      try {
        process.kill(nestedPid, 0);
        return false;
      } catch {
        return true;
      }
    }, 10_000);
    assert.equal(gone, true, `nested process ${nestedPid} survived the SIGINT`);
  } finally {
    repo.cleanup();
  }
});
