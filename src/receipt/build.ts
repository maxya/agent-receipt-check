import { seal, sha256Hex } from '../canonical.js';
import { redact, redactUrl, scrubPaths } from '../redact.js';
import type {
  BaseInfo,
  CheckResult,
  Criterion,
  Finding,
  Receipt,
  ReceiptCriterion,
  RunVerdict,
  SecretRef,
  VerdictSummary,
} from '../types.js';
import { TOOL, VERSION } from '../version.js';

export interface BuildReceiptInput {
  createdAt: Date;
  claim: string | null;
  base: BaseInfo;
  head: { sha: string | null; dirty: boolean } | null;
  criteriaPath: string;
  criteriaSha256: string;
  criteria: Criterion[];
  results: CheckResult[];
  findings: Finding[];
  root: string;
  secrets: SecretRef[];
}

export function runVerdict(results: CheckResult[]): RunVerdict {
  if (results.some((r) => r.verdict === 'FAIL')) return 'FAILED';
  if (results.some((r) => r.verdict === 'UNVERIFIED')) return 'UNVERIFIED';
  return 'VERIFIED';
}

export function summarize(results: CheckResult[]): VerdictSummary {
  return {
    total: results.length,
    pass: results.filter((r) => r.verdict === 'PASS').length,
    fail: results.filter((r) => r.verdict === 'FAIL').length,
    unverified: results.filter((r) => r.verdict === 'UNVERIFIED').length,
  };
}

/** CRITERIA-CHANGED first, then other warnings, then info findings (§4.8). */
export function orderFindings(findings: Finding[]): Finding[] {
  const changed = findings.filter((f) => f.id === 'CRITERIA-CHANGED');
  const warns = findings.filter((f) => f.id !== 'CRITERIA-CHANGED' && f.severity === 'warn');
  const infos = findings.filter((f) => f.id !== 'CRITERIA-CHANGED' && f.severity === 'info');
  return [...changed, ...warns, ...infos];
}

function cleanText(text: string, secrets: SecretRef[], root: string): string {
  return scrubPaths(redact(text, secrets), root);
}

function redactSpecValue(
  value: unknown,
  parentKey: string | null,
  secrets: SecretRef[],
  root: string,
): unknown {
  if (typeof value === 'string') {
    const cleaned = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
      ? redactUrl(value)
      : redact(value, secrets);
    return scrubPaths(cleaned, root);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSpecValue(entry, parentKey, secrets, root));
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (parentKey === 'headers') {
        if (typeof entry === 'string') {
          out[key] = '[REDACTED]';
          continue;
        }
        if (
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as { env?: unknown }).env === 'string'
        ) {
          out[key] = { env: (entry as { env: string }).env };
          continue;
        }
      }
      out[key] = redactSpecValue(entry, key, secrets, root);
    }
    return out;
  }
  return value;
}

export function redactSpec(
  criterion: Criterion,
  secrets: SecretRef[],
  root: string,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(criterion)) {
    if (key === 'id' || key === 'type' || key === 'description') continue;
    if (value === undefined) continue;
    fields[key] = redactSpecValue(value, key, secrets, root);
  }
  return fields;
}

export function buildReceipt(input: BuildReceiptInput): Receipt {
  const verdict = runVerdict(input.results);

  const criteria: ReceiptCriterion[] = input.criteria.map((criterion, index) => {
    const result = input.results[index] ?? {
      verdict: 'UNVERIFIED' as const,
      evidence: '',
      reason: 'internal error: missing result',
      durationMs: 0,
    };
    return {
      id: criterion.id,
      type: criterion.type,
      spec: redactSpec(criterion, input.secrets, input.root),
      verdict: result.verdict,
      evidence: cleanText(result.evidence, input.secrets, input.root),
      reason: cleanText(result.reason, input.secrets, input.root),
      durationMs: result.durationMs,
    };
  });

  const claim =
    input.claim === null ? null : cleanText(input.claim, input.secrets, input.root);

  const findings = orderFindings(input.findings).map((finding) => ({
    id: finding.id,
    severity: finding.severity,
    message: cleanText(finding.message, input.secrets, input.root),
  }));

  const raw = {
    schema: 1 as const,
    tool: TOOL,
    version: VERSION,
    createdAt: input.createdAt.toISOString(),
    claim,
    base: {
      source: input.base.source,
      ref: input.base.ref,
      sha: input.base.sha,
      lockedAt: input.base.lockedAt,
    },
    head: input.head,
    criteriaFile: {
      path: input.criteriaPath,
      sha256: input.criteriaSha256,
    },
    environment: {
      node: process.version,
      platform: process.platform,
    },
    criteria,
    verdict,
    summary: summarize(input.results),
    findings,
  };

  return seal(raw as unknown as Record<string, unknown>) as unknown as Receipt;
}

export function criteriaDigest(bytes: Buffer): string {
  return sha256Hex(bytes);
}
