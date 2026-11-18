import { makeResult } from './common.js';
import { runCountDirCheck, runCountFileCheck } from './count.js';
import { runDiffCheck } from './diff.js';
import { runFileCheck } from './file.js';
import { runHttpCheck } from './http.js';
import { runJsonCheck } from './json.js';
import { runTestCheck } from './test.js';
import type { CheckContext, CheckResult, Criterion } from '../types.js';

/** Dispatch one criterion; a check never throws (§4.6). */
export async function runCheck(criterion: Criterion, ctx: CheckContext): Promise<CheckResult> {
  const started = Date.now();
  try {
    switch (criterion.type) {
      case 'test':
        return await runTestCheck(criterion, ctx);
      case 'file':
        return await runFileCheck(criterion, ctx);
      case 'diff':
        return await runDiffCheck(criterion, ctx);
      case 'http':
        return await runHttpCheck(criterion, ctx);
      case 'count':
        return 'dir' in criterion
          ? await runCountDirCheck(criterion, ctx)
          : await runCountFileCheck(criterion, ctx);
      case 'json':
        return await runJsonCheck(criterion, ctx);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return makeResult('UNVERIFIED', '', `internal error: ${message}`, started, ctx);
  }
}
