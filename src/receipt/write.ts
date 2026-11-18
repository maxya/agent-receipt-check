import fs from 'node:fs/promises';
import path from 'node:path';
import { gitPath, isRepo } from '../git.js';
import type { Receipt, RunVerdict } from '../types.js';

/** `2026-11-18T09:15:00.123Z` → `20261118T091500123Z` */
export function receiptStamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, '');
}

export async function receiptDirectory(root: string): Promise<string> {
  if (await isRepo(root)) {
    return gitPath(root, 'agent-receipt/receipts');
  }
  return path.join(root, '.agent-receipt', 'receipts');
}

export async function defaultReceiptPath(
  root: string,
  verdict: RunVerdict,
  now: Date,
): Promise<string> {
  const dir = await receiptDirectory(root);
  return path.join(dir, `${receiptStamp(now)}-${verdict}.json`);
}

/** Atomic write: `<name>.tmp` then rename. */
export async function writeReceipt(file: string, receipt: Receipt): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}
