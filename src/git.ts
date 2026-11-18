import fs from 'node:fs';
import path from 'node:path';
import { git } from './exec.js';

function splitZ(buf: Buffer): string[] {
  return buf.toString('utf8').split('\0').filter((s) => s.length > 0);
}

export async function isGitAvailable(): Promise<boolean> {
  const r = await git(['--version'], { cwd: process.cwd() });
  return !r.enoent && r.code === 0;
}

export async function findToplevel(cwd: string): Promise<string | null> {
  const r = await git(['rev-parse', '--show-toplevel'], { cwd });
  if (r.code !== 0) return null;
  const top = r.stdout.toString('utf8').trim();
  if (top === '') return null;
  try {
    return fs.realpathSync(top);
  } catch {
    return top;
  }
}

export async function isRepo(root: string): Promise<boolean> {
  const r = await git(['rev-parse', '--is-inside-work-tree'], { cwd: root });
  return r.code === 0 && r.stdout.toString('utf8').trim() === 'true';
}

export async function gitPath(root: string, rel: string): Promise<string> {
  const r = await git(['rev-parse', '--git-path', rel], { cwd: root });
  if (r.code !== 0) throw new Error(`git rev-parse --git-path failed: ${r.stderr.split('\n')[0] ?? ''}`);
  const p = r.stdout.toString('utf8').trim();
  return path.isAbsolute(p) ? p : path.resolve(root, p);
}

/** True when the lock file exists. Does not read or validate it. */
export async function lockFileExists(root: string): Promise<boolean> {
  try {
    return fs.existsSync(await gitPath(root, 'agent-receipt/lock.json'));
  } catch {
    return false;
  }
}

export async function revParseCommit(root: string, ref: string): Promise<string | null> {
  const r = await git(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root });
  if (r.code !== 0) return null;
  const sha = r.stdout.toString('utf8').trim();
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

export async function showFile(
  root: string,
  sha: string,
  posixPath: string,
): Promise<Buffer | null> {
  const r = await git(['show', `${sha}:${posixPath}`], { cwd: root });
  if (r.code !== 0) return null;
  return r.stdout;
}

export async function isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean | null> {
  const r = await git(['merge-base', '--is-ancestor', ancestor, descendant], { cwd: root });
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  return null;
}

export async function commitExists(root: string, sha: string): Promise<boolean> {
  const r = await git(['cat-file', '-e', `${sha}^{commit}`], { cwd: root });
  return r.code === 0;
}

export interface HeadInfo {
  sha: string | null;
  dirty: boolean;
}

export async function headInfo(root: string): Promise<HeadInfo | null> {
  if (!(await isRepo(root))) return null;
  const sha = await revParseCommit(root, 'HEAD');
  const status = await git(['status', '--porcelain', '-z'], { cwd: root });
  return { sha, dirty: status.code === 0 && status.stdout.length > 0 };
}

export interface RawChangedSet {
  paths: Set<string>;
  hiding: string[];
  error: string | null;
}

interface FlaggedEntry {
  tag: string;
  path: string;
}

function parseFlagged(buf: Buffer): FlaggedEntry[] {
  const out: FlaggedEntry[] = [];
  for (const record of splitZ(buf)) {
    if (record.length < 3) continue;
    const tag = record[0]!;
    const pathPart = record[1] === ' ' ? record.slice(2) : record.slice(1);
    if (pathPart.length > 0) out.push({ tag, path: pathPart });
  }
  return out;
}

function firstLine(text: string): string {
  return text.split('\n')[0] ?? '';
}

/**
 * Compute the changed set against `baseSha`, including the anti-hiding checks from §4.6.3.
 * Must run with cwd = root: `ls-files --others` is cwd-relative.
 */
export async function computeChangedSet(root: string, baseSha: string): Promise<RawChangedSet> {
  const paths = new Set<string>();
  const hiding: string[] = [];

  const diff = await git(['diff', '--name-only', '--no-renames', '-z', baseSha], { cwd: root });
  if (diff.code !== 0) return { paths, hiding, error: firstLine(diff.stderr) || 'git diff failed' };
  for (const p of splitZ(diff.stdout)) paths.add(p);

  const others = await git(
    ['ls-files', '--others', '--exclude-per-directory=.gitignore', '-z'],
    { cwd: root },
  );
  if (others.code !== 0) return { paths, hiding, error: firstLine(others.stderr) || 'git ls-files failed' };
  for (const p of splitZ(others.stdout)) paths.add(p);

  const flags = await git(['ls-files', '-v', '-z'], { cwd: root });
  if (flags.code !== 0) return { paths, hiding, error: firstLine(flags.stderr) || 'git ls-files -v failed' };

  for (const entry of parseFlagged(flags.stdout)) {
    const flagged = entry.tag === 'S' || /^[a-z]$/.test(entry.tag);
    if (!flagged) continue;
    const work = await git(['hash-object', '--', entry.path], { cwd: root });
    const workHash = work.code === 0 ? work.stdout.toString('utf8').trim() : 'missing';
    const base = await git(['rev-parse', `${baseSha}:${entry.path}`], { cwd: root });
    const baseHash = base.code === 0 ? base.stdout.toString('utf8').trim() : 'absent-in-base';
    if (workHash !== baseHash) {
      paths.add(entry.path);
      hiding.push(entry.path);
    }
  }

  return { paths, hiding, error: null };
}

/** Type of a path in a base tree (`tree`, `blob`, or null). */
export async function lsTreeType(
  root: string,
  sha: string,
  posixPath: string,
): Promise<'tree' | 'blob' | null> {
  const r = await git(['ls-tree', '-z', sha, '--', posixPath], { cwd: root });
  if (r.code !== 0) return null;
  const first = splitZ(r.stdout)[0];
  if (!first) return null;
  const match = /^\d+ (\w+) [0-9a-f]+\t/.exec(first);
  if (!match) return null;
  const type = match[1];
  return type === 'tree' || type === 'blob' ? type : null;
}
