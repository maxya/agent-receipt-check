#!/usr/bin/env node
import { CliError } from './errors.js';
import { runLock } from './commands/lock.js';
import { runShow } from './commands/show.js';
import { runVerify } from './commands/verify.js';
import {
  generalHelp,
  lockHelp,
  parseLockArgs,
  parseShowArgs,
  parseVerifyArgs,
  receiptHelp,
  verifyHelp,
} from './args.js';
import { TOOL, VERSION } from './version.js';

function print(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function printErr(text: string): void {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

async function dispatch(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    printErr(generalHelp());
    return 1;
  }
  const first = argv[0]!;
  if (first === '--help' || first === '-h') {
    print(generalHelp());
    return 0;
  }
  if (first === '--version' || first === '-v') {
    print(VERSION);
    return 0;
  }

  if (first === 'lock') {
    if (argv.includes('--help') || argv.includes('-h')) {
      print(lockHelp());
      return 0;
    }
    const options = parseLockArgs(argv.slice(1));
    return await runLock(options, process.cwd());
  }

  if (first === 'verify') {
    if (argv.includes('--help') || argv.includes('-h')) {
      print(verifyHelp());
      return 0;
    }
    const options = parseVerifyArgs(argv.slice(1));
    return await runVerify(options, process.cwd());
  }

  if (first === 'receipt') {
    const rest = argv.slice(1);
    if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
      print(receiptHelp());
      return rest.length === 0 ? 1 : 0;
    }
    if (rest[0] !== 'show') {
      printErr(`error: unknown receipt command '${rest[0]}'\n${receiptHelp()}`);
      return 1;
    }
    if (rest.includes('--help') || rest.includes('-h')) {
      print(receiptHelp());
      return 0;
    }
    const options = parseShowArgs(rest.slice(1));
    return await runShow(options);
  }

  printErr(`error: unknown command '${first}'\n${USAGE_HINT}`);
  return 1;
}

const USAGE_HINT = `Run '${TOOL} --help' for usage.`;

async function main(): Promise<number> {
  try {
    return await dispatch(process.argv.slice(2));
  } catch (err) {
    if (err instanceof CliError) {
      printErr(`error: ${err.message}`);
      return err.exitCode;
    }
    const message = err instanceof Error ? err.message : String(err);
    printErr(`error: ${message}`);
    if (process.env.AGENT_RECEIPT_DEBUG === '1' && err instanceof Error && err.stack) {
      printErr(err.stack);
    }
    return 1;
  }
}

const code = await main();
process.exitCode = code;
