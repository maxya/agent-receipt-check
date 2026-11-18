import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalize, seal, sha256Hex, verifySeal } from '../canonical.js';
import { gitPath } from '../git.js';
import { TOOL } from '../version.js';

export interface LockData {
  schema: 1;
  tool: string;
  version: string;
  createdAt: string;
  baseSha: string;
  criteriaPath: string;
  criteriaSha256: string;
  criteria: string;
  sha256: string;
}

export interface WriteLockInput {
  baseSha: string;
  criteriaPath: string;
  criteriaBytes: Buffer;
  version: string;
  now: Date;
}

export async function lockFilePath(root: string): Promise<string> {
  return gitPath(root, 'agent-receipt/lock.json');
}

export async function writeLock(root: string, input: WriteLockInput): Promise<string> {
  const file = await lockFilePath(root);
  const raw = {
    schema: 1 as const,
    tool: TOOL,
    version: input.version,
    createdAt: input.now.toISOString(),
    baseSha: input.baseSha,
    criteriaPath: input.criteriaPath,
    criteriaSha256: sha256Hex(input.criteriaBytes),
    criteria: input.criteriaBytes.toString('utf8'),
  };
  const locked = seal(raw as unknown as Record<string, unknown>) as unknown as LockData;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(locked, null, 2)}\n`, 'utf8');
  return file;
}

export type ReadLockResult =
  | { ok: true; lock: LockData; path: string }
  | { ok: false; missing: true; path: string }
  | { ok: false; missing: false; path: string };

export async function readLock(root: string): Promise<ReadLockResult> {
  const file = await lockFilePath(root);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, missing: true, path: file };
    }
    return { ok: false, missing: false, path: file };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, missing: false, path: file };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, missing: false, path: file };
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schema !== 1 || obj.tool !== TOOL) return { ok: false, missing: false, path: file };
  for (const key of [
    'version',
    'createdAt',
    'baseSha',
    'criteriaPath',
    'criteriaSha256',
    'criteria',
    'sha256',
  ]) {
    if (typeof obj[key] !== 'string') return { ok: false, missing: false, path: file };
  }
  if (!/^[0-9a-f]{40,64}$/.test(obj.baseSha as string)) {
    return { ok: false, missing: false, path: file };
  }
  if (!/^[0-9a-f]{64}$/.test(obj.criteriaSha256 as string)) {
    return { ok: false, missing: false, path: file };
  }
  if (!verifySeal(obj).valid) return { ok: false, missing: false, path: file };
  if (sha256Hex(Buffer.from(obj.criteria as string, 'utf8')) !== obj.criteriaSha256) {
    return { ok: false, missing: false, path: file };
  }
  return { ok: true, lock: obj as unknown as LockData, path: file };
}

/** Exposed for tests: canonical seal of a lock object (no round-trip surprises). */
export function lockCanonical(lock: Record<string, unknown>): string {
  const clean = { ...lock };
  delete clean.sha256;
  return canonicalize(clean);
}
