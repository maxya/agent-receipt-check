import fs from 'node:fs';
import path from 'node:path';
import { CliError } from './errors.js';
import { findToplevel } from './git.js';

/**
 * Resolve the project root. Default: the git top level of cwd, else cwd.
 * Inside a git work tree, `--root` must be the top level (§4.1).
 */
export async function resolveRoot(cwd: string, rootArg: string | null): Promise<string> {
  const absCwd = path.resolve(cwd);
  let realCwd = absCwd;
  try {
    realCwd = fs.realpathSync(absCwd);
  } catch {
    realCwd = absCwd;
  }
  const top = await findToplevel(realCwd);

  if (rootArg === null) return top ?? realCwd;

  const abs = path.resolve(cwd, rootArg);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new CliError(`--root does not exist: ${rootArg}`);
  }
  if (!stat.isDirectory()) throw new CliError(`--root is not a directory: ${rootArg}`);
  const real = fs.realpathSync(abs);
  if (top !== null) {
    const realTop = fs.realpathSync(top);
    if (real !== realTop) {
      throw new CliError(`--root must be the repository top level (${top})`);
    }
  }
  return real;
}
