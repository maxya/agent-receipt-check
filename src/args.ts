import { parseArgs } from 'node:util';
import { CliError } from './errors.js';
import { TOOL, VERSION } from './version.js';

export const USAGE = `Usage:
  ${TOOL} lock    [--criteria <file>] [--root <dir>]
  ${TOOL} verify  [--criteria <file>] [--base <ref>] [--claim <text>]
                  [--out <file>] [--json] [--strict] [--root <dir>]
  ${TOOL} receipt show <receipt-file> [--json]
  ${TOOL} --help | -h
  ${TOOL} --version | -v
  ${TOOL} <command> --help`;

export function generalHelp(): string {
  return `${TOOL} ${VERSION}

${USAGE}

Commands:
  lock     snapshot the criteria and the base commit before the agent starts
  verify   re-check the locked criteria against actual state, write a receipt
  receipt  receipt tools (show)

Run \`${TOOL} <command> --help\` for command options.`;
}

export function lockHelp(): string {
  return `${TOOL} lock [--criteria <file>] [--root <dir>]

Snapshot the criteria bytes, their SHA-256, and HEAD as the base for later
\`verify\` runs. Writes the lock under the repository's .git directory.
Exit 1 outside a git repository or when the criteria are invalid.`;
}

export function verifyHelp(): string {
  return `${TOOL} verify [--criteria <file>] [--base <ref>] [--claim <text>]
               [--out <file>] [--json] [--strict] [--root <dir>]

Re-check the criteria against the actual state of the machine and write a
sealed receipt.

  --criteria <file>  criteria file (default receipt.criteria.json, relative to cwd)
  --base <ref>       use the criteria committed at <ref> instead of the lock
  --claim <text>     what the agent claimed (overrides the file's claim)
  --out <file>       receipt path (default <git-dir>/agent-receipt/receipts/…)
  --json             print only the receipt JSON on stdout
  --strict           exit 2 when the run is UNVERIFIED
  --root <dir>       project root (default: git top level, else cwd)

Exit codes: 0 VERIFIED (or UNVERIFIED without --strict), 1 usage/config error,
2 FAILED (or UNVERIFIED with --strict).`;
}

export function receiptHelp(): string {
  return `${TOOL} receipt show <receipt-file> [--json]

Verify a receipt's seal and print its verdict and criteria.
Exit 0 seal valid, 2 seal broken, 1 unreadable or not a receipt.`;
}

export interface LockOptions {
  criteria: string;
  root: string | null;
}

export interface VerifyOptions {
  criteria: string;
  base: string | null;
  claim: string | null;
  out: string | null;
  json: boolean;
  strict: boolean;
  root: string | null;
}

export interface ShowOptions {
  file: string;
  json: boolean;
}

const DEFAULT_CRITERIA = 'receipt.criteria.json';

function parseOrThrow(
  args: string[],
  options: Record<string, { type: 'string' | 'boolean'; short?: string }>,
  allowPositionals: boolean,
): { values: Record<string, string | boolean | undefined>; positionals: string[] } {
  try {
    const parsed = parseArgs({ args, options, strict: true, allowPositionals });
    return {
      values: parsed.values as Record<string, string | boolean | undefined>,
      positionals: parsed.positionals,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError(`${message}\n${USAGE}`);
  }
}

function optionalString(v: string | boolean | undefined): string | null {
  return typeof v === 'string' ? v : null;
}

export function parseLockArgs(args: string[]): LockOptions {
  const { values, positionals } = parseOrThrow(
    args,
    { criteria: { type: 'string' }, root: { type: 'string' } },
    false,
  );
  if (positionals.length > 0) throw new CliError(`unexpected argument '${positionals[0]}'\n${USAGE}`);
  return { criteria: optionalString(values.criteria) ?? DEFAULT_CRITERIA, root: optionalString(values.root) };
}

export function parseVerifyArgs(args: string[]): VerifyOptions {
  const { values, positionals } = parseOrThrow(
    args,
    {
      criteria: { type: 'string' },
      base: { type: 'string' },
      claim: { type: 'string' },
      out: { type: 'string' },
      json: { type: 'boolean' },
      strict: { type: 'boolean' },
      root: { type: 'string' },
    },
    false,
  );
  if (positionals.length > 0) throw new CliError(`unexpected argument '${positionals[0]}'\n${USAGE}`);
  return {
    criteria: optionalString(values.criteria) ?? DEFAULT_CRITERIA,
    base: optionalString(values.base),
    claim: optionalString(values.claim),
    out: optionalString(values.out),
    json: values.json === true,
    strict: values.strict === true,
    root: optionalString(values.root),
  };
}

export function parseShowArgs(args: string[]): ShowOptions {
  const { values, positionals } = parseOrThrow(
    args,
    { json: { type: 'boolean' } },
    true,
  );
  if (positionals.length !== 1) {
    throw new CliError(`receipt show needs exactly one receipt file\n${receiptHelp()}`);
  }
  const file = positionals[0];
  if (file === undefined) throw new CliError(`receipt show needs a receipt file\n${receiptHelp()}`);
  return { file, json: values.json === true };
}
