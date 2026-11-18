import type { ShowOptions } from '../args.js';
import { loadReceipt, renderShow, showJson } from '../receipt/show.js';

export async function runShow(opts: ShowOptions): Promise<number> {
  const result = await loadReceipt(opts.file);

  if (result.kind === 'unreadable') {
    process.stderr.write(`error: could not read receipt: ${result.code}\n`);
    return 1;
  }
  if (result.kind === 'not-a-receipt') {
    process.stderr.write(`error: not a receipt: ${opts.file}\n`);
    return 1;
  }

  if (opts.json) {
    const body = showJson(result.receipt, result.expected, result.actual, result.valid);
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  } else if (result.valid) {
    process.stdout.write(renderShow(result.receipt));
  } else {
    process.stdout.write(
      `SEAL BROKEN — contents were modified after the receipt was written ` +
        `(stored ${result.expected}, computed ${result.actual})\n`,
    );
  }

  return result.valid ? 0 : 2;
}
