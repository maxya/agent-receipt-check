import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import readline from 'node:readline';
import { globToRegExp } from '../glob.js';
import { resolveInRoot, toPosixRel } from '../paths.js';
import type {
  CheckContext,
  CheckResult,
  CountDirCriterion,
  CountFileCriterion,
  Range,
} from '../types.js';
import { makeResult } from './common.js';

const ENTRY_LIMIT = 200_000;

function ioCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === 'string' ? code : 'UNKNOWN';
}

function rangeFailure(count: number, c: Range, noun: string): string | null {
  if (c.exact !== undefined) {
    return count === c.exact ? null : `${count} ${noun}, expected exactly ${c.exact}`;
  }
  const expectations: string[] = [];
  let bad = false;
  if (c.min !== undefined) {
    expectations.push(`≥ ${c.min}`);
    if (count < c.min) bad = true;
  }
  if (c.max !== undefined) {
    expectations.push(`≤ ${c.max}`);
    if (count > c.max) bad = true;
  }
  return bad ? `${count} ${noun}, expected ${expectations.join(' and ')}` : null;
}

export async function runCountDirCheck(
  c: CountDirCriterion,
  ctx: CheckContext,
): Promise<CheckResult> {
  const started = Date.now();
  const abs = resolveInRoot(ctx.root, c.dir);
  const glob = c.glob ?? '**/*';
  const noun = 'files';

  let exists = true;
  try {
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) {
      return makeResult('FAIL', '', 'not a directory', started, ctx);
    }
  } catch (err) {
    const code = ioCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') exists = false;
    else return makeResult('UNVERIFIED', '', `unreadable: ${code}`, started, ctx);
  }

  let files: string[] = [];
  if (exists) {
    const stack: string[] = [abs];
    let entries = 0;
    try {
      while (stack.length > 0) {
        const dir = stack.pop()!;
        const dirents = await fs.readdir(dir, { withFileTypes: true });
        for (const dirent of dirents) {
          entries++;
          if (entries > ENTRY_LIMIT) {
            return makeResult('UNVERIFIED', 'too many entries', 'too many entries', started, ctx);
          }
          if (dirent.isSymbolicLink()) continue;
          const child = `${dir}/${dirent.name}`;
          if (dirent.isDirectory()) {
            if (dirent.name === '.git') continue;
            stack.push(child);
          } else if (dirent.isFile()) {
            files.push(toPosixRel(abs, child));
          }
        }
      }
    } catch (err) {
      return makeResult('UNVERIFIED', '', `unreadable: ${ioCode(err)}`, started, ctx);
    }
  }

  const re = globToRegExp(glob);
  const count = files.filter((p) => re.test(p)).length;
  const evidence = `${count} ${noun}${exists ? '' : ' (does not exist)'}`;
  const failure = rangeFailure(count, c, noun);
  if (failure !== null) return makeResult('FAIL', evidence, failure, started, ctx);
  return makeResult('PASS', evidence, `${count} ${noun} match ${glob}`, started, ctx);
}

export async function runCountFileCheck(
  c: CountFileCriterion,
  ctx: CheckContext,
): Promise<CheckResult> {
  const started = Date.now();
  const abs = resolveInRoot(ctx.root, c.file);
  const noun = c.unit === 'csv-rows' ? 'csv rows' : c.unit === 'jsonl' ? 'jsonl records' : 'lines';

  let exists = true;
  try {
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) return makeResult('FAIL', '', 'is a directory', started, ctx);
  } catch (err) {
    const code = ioCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') exists = false;
    else return makeResult('UNVERIFIED', '', `unreadable: ${code}`, started, ctx);
  }

  let nonEmpty = 0;
  if (exists) {
    let physical = 0;
    let failure: string | null = null;
    try {
      const input = createReadStream(abs, { encoding: 'utf8' });
      const rl = readline.createInterface({ input, crlfDelay: Infinity });
      for await (const raw of rl) {
        physical++;
        const line = raw.replace(/\r$/, '');
        if (line.trim() === '') continue;
        nonEmpty++;
        if (c.unit === 'jsonl') {
          try {
            JSON.parse(line);
          } catch {
            failure = `line ${physical} is not valid JSON`;
            rl.close();
            input.destroy();
            break;
          }
        }
      }
    } catch (err) {
      return makeResult('UNVERIFIED', '', `unreadable: ${ioCode(err)}`, started, ctx);
    }
    if (failure !== null) return makeResult('FAIL', `${physical} lines read`, failure, started, ctx);
  }

  const count = c.unit === 'csv-rows' ? Math.max(0, nonEmpty - 1) : nonEmpty;
  const evidence = `${count} ${noun}${exists ? '' : ' (does not exist)'}`;
  const failure = rangeFailure(count, c, noun);
  if (failure !== null) return makeResult('FAIL', evidence, failure, started, ctx);
  return makeResult('PASS', evidence, `${count} ${noun}`, started, ctx);
}
