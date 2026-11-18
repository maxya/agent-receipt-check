import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { runCommand } from '../../../src/exec.js';
import { runTestCheck } from '../../../src/checks/test.js';
import type { TestCriterion } from '../../../src/types.js';
import { makeTempDir } from '../../helpers/repo.js';
import { makeCtx } from './helpers.js';

async function check(
  criterion: Omit<TestCriterion, 'id' | 'type'>,
  root: string,
): Promise<ReturnType<typeof runTestCheck>> {
  return runTestCheck({ id: 't', type: 'test', ...criterion }, makeCtx(root));
}

test('test: PASS on exit 0', async () => {
  const dir = await makeTempDir();
  try {
    const r = await check({ command: 'node -e "process.exit(0)"' }, dir.dir);
    assert.equal(r.verdict, 'PASS');
    assert.match(r.reason, /exited 0/);
  } finally {
    dir.cleanup();
  }
});

test('test: PASS when stdoutContains is present', async () => {
  const dir = await makeTempDir();
  try {
    const r = await check(
      { command: 'node -e "console.log(\'hello world\')"', expect: { stdoutContains: 'hello world' } },
      dir.dir,
    );
    assert.equal(r.verdict, 'PASS');
  } finally {
    dir.cleanup();
  }
});

test('test: FAIL on a non-zero exit', async () => {
  const dir = await makeTempDir();
  try {
    const r = await check({ command: 'node -e "process.exit(1)"' }, dir.dir);
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, 'exited 1, expected 0');
  } finally {
    dir.cleanup();
  }
});

test('test: FAIL when stdoutContains is missing', async () => {
  const dir = await makeTempDir();
  try {
    const r = await check(
      { command: 'node -e "console.log(\'nope\')"', expect: { stdoutContains: '# skipped 0' } },
      dir.dir,
    );
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, 'stdout lacks "# skipped 0"');
  } finally {
    dir.cleanup();
  }
});

test('test: FAIL when stdoutNotContains is present', async () => {
  const dir = await makeTempDir();
  try {
    const r = await check(
      { command: 'node -e "console.log(\'forbidden\')"', expect: { stdoutNotContains: 'forbidden' } },
      dir.dir,
    );
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, 'stdout contains "forbidden"');
  } finally {
    dir.cleanup();
  }
});

test('test: FAIL when stderrContains is missing', async () => {
  const dir = await makeTempDir();
  try {
    const r = await check(
      { command: 'node -e ""', expect: { stderrContains: 'warning' } },
      dir.dir,
    );
    assert.equal(r.verdict, 'FAIL');
    assert.equal(r.reason, 'stderr lacks "warning"');
  } finally {
    dir.cleanup();
  }
});

test('test: a missing command is UNVERIFIED (exit 127)', async () => {
  const dir = await makeTempDir();
  try {
    const r = await check({ command: 'definitely-not-a-cmd-xyz' }, dir.dir);
    assert.equal(r.verdict, 'UNVERIFIED');
    assert.equal(r.reason, 'command not found (exit 127)');
  } finally {
    dir.cleanup();
  }
});

test('test: a timeout is UNVERIFIED', async () => {
  const dir = await makeTempDir();
  try {
    const r = await check(
      { command: 'node -e "setTimeout(()=>{}, 10000)"', timeoutMs: 300 },
      dir.dir,
    );
    assert.equal(r.verdict, 'UNVERIFIED');
    assert.equal(r.reason, 'timed out after 0.3s');
  } finally {
    dir.cleanup();
  }
});

test('test: a missing cwd is UNVERIFIED', async () => {
  const dir = await makeTempDir();
  try {
    const r = await check({ command: 'node -v', cwd: 'no-such-dir' }, dir.dir);
    assert.equal(r.verdict, 'UNVERIFIED');
    assert.equal(r.reason, 'cwd no-such-dir does not exist');
  } finally {
    dir.cleanup();
  }
});

test('test: a truncated stream plus a contains miss is UNVERIFIED', async () => {
  const dir = await makeTempDir();
  try {
    const r = await check(
      {
        command: 'node -e "process.stdout.write(\'x\'.repeat(11 * 1024 * 1024))"',
        timeoutMs: 60_000,
        expect: { stdoutContains: 'nope' },
      },
      dir.dir,
    );
    assert.equal(r.verdict, 'UNVERIFIED');
    assert.equal(r.reason, 'stdout lacks "nope"');
  } finally {
    dir.cleanup();
  }
});

test('test: a failing nested node --test suite really FAILs (NODE_TEST_CONTEXT stripped)', async () => {
  const dir = await makeTempDir();
  try {
    fs.mkdirSync(`${dir.dir}/test`, { recursive: true });
    fs.writeFileSync(
      `${dir.dir}/test/failing.test.mjs`,
      "import test from 'node:test';\ntest('fails', () => { throw new Error('boom'); });\n",
    );
    const r = await check(
      {
        command: 'node --test --test-reporter=tap "test/*.test.mjs"',
        expect: { exit: 0 },
        timeoutMs: 60_000,
      },
      dir.dir,
    );
    assert.equal(r.verdict, 'FAIL', JSON.stringify(r));
    assert.match(r.reason, /exited 1, expected 0/);
    assert.match(r.evidence, /# fail 1/);
  } finally {
    dir.cleanup();
  }
});

test('test: a timeout kills the child process group', async () => {
  const dir = await makeTempDir();
  try {
    const r = await runCommand(
      'node -e "console.log(process.pid); setTimeout(()=>{}, 60000)"',
      { cwd: dir.dir, timeoutMs: 500 },
    );
    assert.equal(r.timedOut, true);
    const pid = Number(r.stdout.trim().split('\n')[0]);
    assert.ok(Number.isInteger(pid) && pid > 0, r.stdout);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.throws(() => process.kill(pid, 0));
  } finally {
    dir.cleanup();
  }
});
