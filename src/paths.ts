import fs from 'node:fs';
import path from 'node:path';

export function isAbsoluteAny(p: string): boolean {
  return path.posix.isAbsolute(p) || path.win32.isAbsolute(p);
}

/** Resolve a root-relative path, rejecting absolute paths, NUL bytes and escapes. */
export function resolveInRoot(root: string, rel: string): string {
  if (rel.includes('\0')) throw new Error('path contains NUL');
  if (isAbsoluteAny(rel)) throw new Error('path must be relative to root');
  const abs = path.resolve(root, rel);
  const r = path.relative(root, abs);
  if (r === '') return abs;
  if (r === '..' || r.startsWith(`..${path.sep}`) || path.isAbsolute(r)) {
    throw new Error('path escapes root');
  }
  return abs;
}

/** POSIX-separated path relative to root. */
export function toPosixRel(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

export type RealpathResult =
  | { ok: true; real: string }
  | { ok: false; escape: boolean; error?: string };

/** realpath a target and check that it stays inside root (symlink escape guard). */
export function safeRealpath(root: string, abs: string): RealpathResult {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    realRoot = root;
  }
  try {
    const real = fs.realpathSync(abs);
    const rel = path.relative(realRoot, real);
    if (rel !== '' && (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))) {
      return { ok: false, escape: true };
    }
    return { ok: true, real };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return { ok: false, escape: false, error: code };
  }
}

/** True when `abs` is inside `root` (realpaths compared). */
export function isInside(root: string, abs: string): boolean {
  const result = safeRealpath(root, abs);
  return result.ok;
}
