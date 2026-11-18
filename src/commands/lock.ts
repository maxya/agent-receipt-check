import fs from 'node:fs';
import path from 'node:path';
import type { LockOptions } from '../args.js';
import { sha256Hex } from '../canonical.js';
import { readLock, writeLock } from '../criteria/lock.js';
import { validateCriteriaBytes } from '../criteria/schema.js';
import { CliError } from '../errors.js';
import { isRepo, revParseCommit } from '../git.js';
import { toPosixRel } from '../paths.js';
import { resolveRoot } from '../root.js';
import { VERSION } from '../version.js';

export async function runLock(opts: LockOptions, cwd: string): Promise<number> {
  const root = await resolveRoot(cwd, opts.root);
  if (!(await isRepo(root))) {
    throw new CliError(
      'lock needs a git repository (verify still works without git, but without anti-tamper protection)',
    );
  }

  const headSha = await revParseCommit(root, 'HEAD');
  if (headSha === null) throw new CliError('make an initial commit before locking');

  const absCriteria = path.resolve(cwd, opts.criteria);
  const criteriaPath = toPosixRel(root, absCriteria);
  if (
    criteriaPath === '' ||
    criteriaPath === '..' ||
    criteriaPath.startsWith('../') ||
    path.isAbsolute(criteriaPath)
  ) {
    throw new CliError('criteria file must be inside root');
  }

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(absCriteria);
  } catch {
    throw new CliError(`criteria file not found: ${criteriaPath}`);
  }

  const validation = validateCriteriaBytes(bytes, { root, label: criteriaPath });
  if (!validation.ok) throw new CliError(validation.errors.join('\n'));

  const existing = await readLock(root);
  if (existing.ok) {
    process.stdout.write(
      `replaced previous lock (base ${existing.lock.baseSha.slice(0, 7)}, criteria ${existing.lock.criteriaSha256.slice(0, 12)})\n`,
    );
  } else if (!existing.missing) {
    process.stdout.write('replaced previous lock\n');
  }

  await writeLock(root, {
    baseSha: headSha,
    criteriaPath,
    criteriaBytes: bytes,
    version: VERSION,
    now: new Date(),
  });

  process.stdout.write(`locked ${criteriaPath}\n`);
  process.stdout.write(`  base     ${headSha.slice(0, 7)} (HEAD)\n`);
  process.stdout.write(
    `  criteria sha256 ${sha256Hex(bytes)} (keep this — verify prints it too)\n`,
  );
  process.stdout.write(
    "now start the agent; run `agent-receipt-check verify` when it says done\n",
  );
  return 0;
}
