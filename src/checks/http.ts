import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import { redactUrl, stripAnsi } from '../redact.js';
import type {
  CheckContext,
  CheckResult,
  HttpCriterion,
  SecretRef,
  StrOrList,
} from '../types.js';
import { TOOL, VERSION } from '../version.js';
import { formatSeconds, makeResult } from './common.js';

const BODY_LIMIT = 1024 * 1024;

function asList(value: StrOrList): string[] {
  return Array.isArray(value) ? value : [value];
}

function mapError(err: unknown, timeoutMs: number): string {
  const e = err as NodeJS.ErrnoException;
  const code = typeof e.code === 'string' ? e.code : '';
  const message = e.message ?? String(err);
  if (message === 'deadline' || message === 'timeout' || code === 'ETIMEDOUT') {
    return `timed out after ${formatSeconds(timeoutMs)}s`;
  }
  switch (code) {
    case 'ECONNREFUSED':
      return 'connection refused';
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_FAIL':
      return 'DNS lookup failed';
    case 'ECONNRESET':
      return 'connection reset';
    case 'EPROTO':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'CERT_HAS_EXPIRED':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `TLS error: ${code}`;
    default:
      if (code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL')) return `TLS error: ${code}`;
      return `request failed: ${code || message}`;
  }
}

export async function runHttpCheck(c: HttpCriterion, ctx: CheckContext): Promise<CheckResult> {
  const started = Date.now();
  const timeoutMs = c.timeoutMs ?? 10_000;

  const headers: Record<string, string> = {};
  const headerSecrets: SecretRef[] = [];
  for (const [name, value] of Object.entries(c.headers ?? {})) {
    if (typeof value === 'string') {
      headers[name] = value;
    } else {
      const envValue = process.env[value.env];
      if (envValue === undefined) {
        return makeResult('UNVERIFIED', '', `env ${value.env} not set`, started, ctx);
      }
      headers[name] = envValue;
      headerSecrets.push({ name: value.env, value: envValue });
    }
  }
  if (!Object.keys(headers).some((name) => name.toLowerCase() === 'user-agent')) {
    headers['user-agent'] = `${TOOL}/${VERSION}`;
  }
  const secrets = [...ctx.secrets, ...headerSecrets];
  const opts = { secrets };

  let url: URL;
  try {
    url = new URL(c.url);
  } catch {
    return makeResult('UNVERIFIED', '', 'invalid URL', started, ctx, opts);
  }

  const expectedStatus = c.expect?.status ?? 200;
  const expectedText = Array.isArray(expectedStatus)
    ? expectedStatus.join(', ')
    : String(expectedStatus);

  return await new Promise<CheckResult>((resolve) => {
    let settled = false;
    let deadline: NodeJS.Timeout | null = null;
    const done = (verdict: CheckResult['verdict'], evidence: string, reason: string): void => {
      if (settled) return;
      settled = true;
      if (deadline !== null) clearTimeout(deadline);
      resolve(makeResult(verdict, evidence, reason, started, ctx, opts));
    };

    const lib = url.protocol === 'https:' ? https : http;
    let request: http.ClientRequest;
    try {
      request = lib.request(
        url,
        { method: 'GET', headers, timeout: timeoutMs, agent: false },
        (res) => {
          const status = res.statusCode ?? 0;
          let body = '';
          let bytes = 0;
          let truncated = false;
          let bodyDone = false;
          const decoder = new StringDecoder('utf8');

          const evaluate = (text: string): void => {
            if (!statusOk()) {
              done(
                'FAIL',
                `GET ${redactUrl(c.url)} → ${status} in ${Date.now() - started}ms; ${bytes} bytes`,
                `expected ${expectedText}, got ${status}`,
              );
              return;
            }
            const bodyText = stripAnsi(text);
            for (const needle of asList(c.expect?.bodyContains ?? [])) {
              if (!bodyText.includes(needle)) {
                done(
                  truncated ? 'UNVERIFIED' : 'FAIL',
                  `GET ${redactUrl(c.url)} → ${status} in ${Date.now() - started}ms; ${bytes} bytes`,
                  `body lacks "${needle}"`,
                );
                return;
              }
            }
            for (const needle of asList(c.expect?.bodyNotContains ?? [])) {
              if (bodyText.includes(needle)) {
                done(
                  'FAIL',
                  `GET ${redactUrl(c.url)} → ${status} in ${Date.now() - started}ms; ${bytes} bytes`,
                  `body contains "${needle}"`,
                );
                return;
              }
            }
            if (c.expect?.bodyMatches !== undefined) {
              const re = new RegExp(c.expect.bodyMatches, 'mu');
              if (!re.test(bodyText)) {
                done(
                  'FAIL',
                  `GET ${redactUrl(c.url)} → ${status} in ${Date.now() - started}ms; ${bytes} bytes`,
                  `body does not match /${c.expect.bodyMatches}/`,
                );
                return;
              }
            }
            done(
              'PASS',
              `GET ${redactUrl(c.url)} → ${status} in ${Date.now() - started}ms; ${bytes} bytes`,
              `GET ${redactUrl(c.url)} → ${status} (${Date.now() - started}ms)`,
            );
          };

          const statusOk = (): boolean =>
            Array.isArray(expectedStatus)
              ? expectedStatus.includes(status)
              : status === expectedStatus;

          const complete = (): void => {
            if (bodyDone) return;
            bodyDone = true;
            evaluate(body);
          };

          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (body.length < BODY_LIMIT) {
              const remaining = BODY_LIMIT - body.length;
              body += decoder.write(chunk.subarray(0, remaining));
              if (chunk.length > remaining) truncated = true;
            } else {
              truncated = true;
            }
            if (truncated && !bodyDone) {
              complete();
              res.destroy();
            }
          });
          res.on('end', complete);
          res.on('error', (err) => {
            if (!statusOk()) {
              done('UNVERIFIED', '', mapError(err, timeoutMs));
            }
          });
        },
      );
    } catch (err) {
      done('UNVERIFIED', '', mapError(err, timeoutMs));
      return;
    }

    deadline = setTimeout(() => {
      request.destroy(new Error('deadline'));
    }, timeoutMs);

    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (err) => done('UNVERIFIED', '', mapError(err, timeoutMs)));
    request.end();
  });
}
