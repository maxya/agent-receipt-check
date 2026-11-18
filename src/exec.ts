import { execFile, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface GitExecResult {
  code: number;
  stdout: Buffer;
  stderr: string;
  enoent: boolean;
}

/** Run git without a shell, with the flags §4.4 requires. */
export function git(args: string[], opts: { cwd: string }): Promise<GitExecResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', ...args],
      {
        cwd: opts.cwd,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
        },
        maxBuffer: 64 * 1024 * 1024,
        encoding: null,
      },
      (error, stdout, stderr) => {
        const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
        const err = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '');
        if (error) {
          const e = error as NodeJS.ErrnoException;
          const rawCode = (error as unknown as { code?: number | string }).code;
          const enoent = rawCode === 'ENOENT';
          resolve({
            code: typeof rawCode === 'number' ? rawCode : enoent ? -1 : 1,
            stdout: out,
            stderr: err || e.message,
            enoent,
          });
          return;
        }
        resolve({ code: 0, stdout: out, stderr: err, enoent: false });
      },
    );
  });
}

const CAPTURE_LIMIT = 10 * 1024 * 1024;

export interface RunCommandOptions {
  cwd: string;
  timeoutMs: number;
}

export interface RunCommandResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  spawnError: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
}

let activePid: number | null = null;

function killTree(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // The process may already be gone.
  }
}

/**
 * Install SIGINT/SIGTERM handlers that kill the active child's process group before
 * exiting, so Ctrl-C never orphans a detached test command (§4.6.1).
 */
export function installChildSignalHandlers(): () => void {
  const handler = (signal: NodeJS.Signals): void => {
    if (activePid !== null) killTree(activePid, 'SIGTERM');
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return () => {
    process.off('SIGINT', handler);
    process.off('SIGTERM', handler);
  };
}

/**
 * Run a user-declared `test` command. `NODE_TEST_CONTEXT` is stripped so a nested
 * `node --test` really runs (§4.6.1).
 */
export function runCommand(command: string, opts: RunCommandOptions): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let spawnError: string | null = null;
    let settled = false;
    let escalation: NodeJS.Timeout | null = null;
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    const child = spawn(command, {
      shell: true,
      cwd: opts.cwd,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });

    activePid = typeof child.pid === 'number' ? child.pid : null;

    const append = (chunk: string, stream: 'stdout' | 'stderr'): void => {
      const current = stream === 'stdout' ? stdout : stderr;
      const remaining = CAPTURE_LIMIT - current.length;
      if (remaining <= 0) {
        if (stream === 'stdout') stdoutTruncated = true;
        else stderrTruncated = true;
        return;
      }
      const piece = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
      if (chunk.length > remaining) {
        if (stream === 'stdout') stdoutTruncated = true;
        else stderrTruncated = true;
      }
      if (stream === 'stdout') stdout += piece;
      else stderr += piece;
    };

    child.stdout?.on('data', (buf: Buffer) => append(stdoutDecoder.write(buf), 'stdout'));
    child.stderr?.on('data', (buf: Buffer) => append(stderrDecoder.write(buf), 'stderr'));

    const timer = setTimeout(() => {
      timedOut = true;
      if (typeof child.pid === 'number') {
        killTree(child.pid, 'SIGTERM');
        escalation = setTimeout(() => {
          if (typeof child.pid === 'number') killTree(child.pid, 'SIGKILL');
        }, 5000);
        escalation.unref();
      }
    }, opts.timeoutMs);

    const finish = (code: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      append(stdoutDecoder.end(), 'stdout');
      append(stderrDecoder.end(), 'stderr');
      if (activePid === (typeof child.pid === 'number' ? child.pid : null)) activePid = null;
      resolve({
        code,
        signal,
        timedOut,
        spawnError,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
        durationMs: Date.now() - started,
      });
    };

    child.on('error', (err) => {
      spawnError = (err as NodeJS.ErrnoException).code ?? err.message;
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}
