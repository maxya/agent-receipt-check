import type { SecretRef } from './types.js';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const SECRET_NAME_RE =
  /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|PASS|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|AUTH|COOKIE|DSN)(_|$)/i;

const EXCLUDED_ENV_NAMES = new Set(['PWD', 'OLDPWD', 'SSH_AUTH_SOCK']);

/** Env vars that look like secrets by name (segment-anchored, §4.10 step 1). */
export function isSecretEnvName(name: string): boolean {
  if (EXCLUDED_ENV_NAMES.has(name)) return false;
  return SECRET_NAME_RE.test(name);
}

export function collectEnvSecrets(env: NodeJS.ProcessEnv): SecretRef[] {
  const out: SecretRef[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (value.length < 6) continue;
    if (!isSecretEnvName(name)) continue;
    out.push({ name, value });
  }
  out.sort((a, b) => b.value.length - a.value.length);
  return out;
}

const PEM_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
const AWS_RE = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g;
const GITHUB_1_RE = /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g;
const GITHUB_2_RE = /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/g;
const LLM_RE = /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{20,}/g;
const SLACK_RE = /\bxox[abposr]-[A-Za-z0-9-]{10,}/g;
const NPM_RE = /\bnpm_[A-Za-z0-9]{36}\b/g;
const GOOGLE_RE = /\bAIza[0-9A-Za-z_-]{35}\b/g;
const STRIPE_RE = /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+\/-]{12,}=*/g;
const BASIC_RE = /\b(Basic)\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{12,}={0,2}/g;
const KEY_VALUE_RE =
  /(["']?)\b([A-Za-z0-9_.-]*?(?:token|secret|passw(?:or)?d|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|auth[_-]?token|credentials?))\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s"'&,;]{4,})/gi;
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s?#]*@/gi;

function replaceKeyValue(input: string): string {
  return input.replace(
    KEY_VALUE_RE,
    (_m, q1: string, name: string, sep: string, value: string) => {
      const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
      if (quote) return `${q1}${name}${q1}${sep}${quote}[REDACTED]${quote}`;
      return `${q1}${name}${q1}${sep}[REDACTED]`;
    },
  );
}

/**
 * Remove recognised secrets from text. Order per §4.10: known env values first, then
 * patterns, then (separately) path scrubbing by the caller, then truncation by `excerpt`.
 */
export function redact(text: string, secrets: SecretRef[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.value.length === 0) continue;
    out = out.split(secret.value).join(`[REDACTED:env:${secret.name}]`);
  }
  out = out.replace(PEM_RE, '[REDACTED]');
  out = out.replace(AWS_RE, '[REDACTED]');
  out = out.replace(GITHUB_1_RE, '[REDACTED]');
  out = out.replace(GITHUB_2_RE, '[REDACTED]');
  out = out.replace(LLM_RE, '[REDACTED]');
  out = out.replace(SLACK_RE, '[REDACTED]');
  out = out.replace(NPM_RE, '[REDACTED]');
  out = out.replace(GOOGLE_RE, '[REDACTED]');
  out = out.replace(STRIPE_RE, '[REDACTED]');
  out = out.replace(JWT_RE, '[REDACTED]');
  out = out.replace(BEARER_RE, '$1 [REDACTED]');
  out = out.replace(BASIC_RE, '$1 [REDACTED]');
  out = replaceKeyValue(out);
  out = out.replace(URL_USERINFO_RE, '$1[REDACTED]@');
  return out;
}

const SENSITIVE_QUERY_PARAM = /(token|key|secret|sig|signature|password|auth|code|session)/i;

/** Drop URL userinfo and redact sensitive query values, then apply the pattern redactor. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_PARAM.test(key)) url.searchParams.set(key, 'REDACTED');
    }
    return redact(url.toString(), []);
  } catch {
    return redact(raw, []);
  }
}

/** Collapse whitespace, then keep the first (default) or last `max` code points. */
export function excerpt(text: string, max: number, mode: 'head' | 'tail' = 'head'): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(collapsed);
  if (chars.length <= max) return collapsed;
  const slice = mode === 'tail' ? chars.slice(chars.length - max) : chars.slice(0, max);
  return mode === 'tail' ? `…${slice.join('')}` : `${slice.join('')}…`;
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace the project root (logical, real and file-URL forms) with `<root>`, and the home
 * directory with `~`. Longest strings first so a nested path wins (§4.10 step 4).
 */
export function scrubPaths(text: string, root: string): string {
  const rootForms = new Set<string>();
  if (root.length > 1) rootForms.add(root);
  try {
    const real = fs.realpathSync(root);
    if (real.length > 1) rootForms.add(real);
  } catch {
    // root may not exist in a unit test
  }
  for (const form of [...rootForms]) {
    const url = pathToFileURL(form).href;
    rootForms.add(url);
  }

  const homeForms = new Set<string>();
  try {
    const home = os.homedir();
    if (home.length > 1) homeForms.add(home);
    const realHome = fs.realpathSync(home);
    if (realHome.length > 1) homeForms.add(realHome);
  } catch {
    // ignore
  }

  const pairs: Array<[string, string]> = [];
  for (const form of rootForms) pairs.push([form, '<root>']);
  for (const form of homeForms) pairs.push([form, '~']);
  pairs.sort((a, b) => b[0].length - a[0].length);

  let out = text;
  for (const [needle, replacement] of pairs) {
    if (out.includes(needle) === false && process.platform !== 'win32') continue;
    if (process.platform === 'win32') {
      out = out.replace(new RegExp(escapeRegExp(needle), 'gi'), replacement);
    } else {
      out = out.split(needle).join(replacement);
    }
  }
  return out;
}
