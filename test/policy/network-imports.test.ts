import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SRC = fileURLToPath(new URL('../../../src/', import.meta.url));

const FORBIDDEN_MODULES = [
  'node:net',
  'node:tls',
  'node:dgram',
  'node:http2',
  'node:dns',
  'undici',
  'XMLHttpRequest',
  'WebSocket',
];

/** Scan one source text. `rel` is POSIX-relative to `src/`. Returns human-readable violations. */
export function scanSource(text: string, rel: string): string[] {
  const violations: string[] = [];

  for (const moduleName of FORBIDDEN_MODULES) {
    if (text.includes(moduleName)) violations.push(`${rel}: forbidden ${moduleName}`);
  }
  if (/\bfetch\s*\(/.test(text)) violations.push(`${rel}: forbidden fetch(`);

  for (const moduleName of ['node:http', 'node:https']) {
    if (text.includes(moduleName) && rel !== 'checks/http.ts') {
      violations.push(`${rel}: ${moduleName} outside checks/http.ts`);
    }
  }

  if (text.includes('node:child_process') && rel !== 'exec.ts') {
    violations.push(`${rel}: node:child_process outside exec.ts`);
  }

  const dynamic = /import\s*\(\s*['"`]((?:node:)?(?:net|tls|dgram|http2|dns|http|https)|undici)['"`]/;
  if (dynamic.test(text)) violations.push(`${rel}: dynamic import of a network module`);

  return violations;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(abs);
    }
  }
  return out.sort();
}

test('the scanner catches a forbidden import (positive control)', () => {
  const text = "import net from 'node:net';\n";
  assert.deepEqual(scanSource(text, 'example.ts'), ['example.ts: forbidden node:net']);
});

test('network code lives only in checks/http.ts and child_process only in exec.ts', () => {
  const files = walkTs(SRC);
  assert.ok(files.length >= 10, `scanner found only ${files.length} source files`);
  const violations: string[] = [];
  for (const abs of files) {
    const rel = path.relative(SRC, abs).split(path.sep).join('/');
    violations.push(...scanSource(fs.readFileSync(abs, 'utf8'), rel));
  }
  assert.deepEqual(violations, []);
});
