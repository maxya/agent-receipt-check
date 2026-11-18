import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TempRepo {
  dir: string;
  env: NodeJS.ProcessEnv;
  write(rel: string, content: string): void;
  read(rel: string): string;
  exists(rel: string): boolean;
  rm(rel: string): void;
  git(args: string[]): string;
  commitAll(message: string): void;
  cleanup(): void;
}

export function isolatedGitEnv(globalConfigFile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfigFile,
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
    GIT_TERMINAL_PROMPT: '0',
  };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/** A realpath'd temp git repo (`git init -b main`) with isolated git settings. */
export async function makeTempRepo(): Promise<TempRepo> {
  const dir = await fs.promises.realpath(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), 'arc-repo-')),
  );
  const globalConfigFile = `${dir}.gitconfig`;
  fs.writeFileSync(globalConfigFile, '');
  const env = isolatedGitEnv(globalConfigFile);

  const repo: TempRepo = {
    dir,
    env,
    write(rel, content) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    },
    read(rel) {
      return fs.readFileSync(path.join(dir, rel), 'utf8');
    },
    exists(rel) {
      return fs.existsSync(path.join(dir, rel));
    },
    rm(rel) {
      fs.rmSync(path.join(dir, rel), { recursive: true, force: true });
    },
    git(args) {
      return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
        cwd: dir,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    },
    commitAll(message) {
      repo.git(['add', '-A']);
      repo.git(['commit', '-q', '-m', message, '--allow-empty']);
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(globalConfigFile, { force: true });
    },
  };

  repo.git(['init', '-q', '-b', 'main']);
  return repo;
}

/** A realpath'd temp directory that is not a git repository. */
export async function makeTempDir(): Promise<{ dir: string; cleanup(): void }> {
  const dir = await fs.promises.realpath(
    await fs.promises.mkdtemp(path.join(os.tmpdir(), 'arc-dir-')),
  );
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
