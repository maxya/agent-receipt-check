import type { CheckContext } from '../../../src/types.js';

export function makeCtx(
  root: string,
  changed: Set<string> | { error: string } | null = null,
  baseSha: string | null = null,
  secrets: CheckContext['secrets'] = [],
): CheckContext {
  return {
    root,
    base: {
      source: baseSha === null ? 'none' : 'lock',
      ref: null,
      sha: baseSha,
      lockedAt: null,
    },
    changedSet: async () => changed ?? new Set<string>(),
    secrets,
    now: () => new Date(),
  };
}
