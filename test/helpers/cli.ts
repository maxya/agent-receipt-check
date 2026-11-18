import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface CliRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliRunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onSpawn?: (child: ChildProcess) => void;
}

const cliPath = fileURLToPath(new URL('../../src/cli.js', import.meta.url));
const guardPath = fileURLToPath(new URL('./net-guard.js', import.meta.url));

export function cliAbsolutePath(): string {
  return cliPath;
}

/** Spawn the compiled CLI with the net guard preloaded (§6 Phase 6). */
export function runCli(args: string[], opts: CliRunOptions): Promise<CliRunResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
  delete env.NODE_TEST_CONTEXT;
  env.NODE_OPTIONS = `--import=${JSON.stringify(pathToFileURL(guardPath).href)}`;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: opts.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    opts.onSpawn?.(child);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b: Buffer) => (stdout += b.toString('utf8')));
    child.stderr?.on('data', (b: Buffer) => (stderr += b.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Path helper for tests that need to reference the built CLI from inside a fixture. */
export function cliPathFrom(cwd: string): string {
  return path.relative(cwd, cliPath);
}
