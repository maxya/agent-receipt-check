export type Verdict = 'PASS' | 'FAIL' | 'UNVERIFIED';
export type RunVerdict = 'VERIFIED' | 'FAILED' | 'UNVERIFIED';
export type StrOrList = string | string[];

export interface BaseCriterion {
  id: string;
  description?: string;
}

export interface TestExpect {
  exit?: number;
  stdoutContains?: StrOrList;
  stdoutNotContains?: StrOrList;
  stderrContains?: StrOrList;
  stderrNotContains?: StrOrList;
}

export interface TestCriterion extends BaseCriterion {
  type: 'test';
  command: string;
  cwd?: string;
  timeoutMs?: number;
  expect?: TestExpect;
}

export interface FileCriterion extends BaseCriterion {
  type: 'file';
  path: string;
  exists?: boolean;
  contains?: StrOrList;
  notContains?: StrOrList;
  matches?: string;
  sha256?: string;
}

export interface DiffCriterion extends BaseCriterion {
  type: 'diff';
  path: string;
  changed?: boolean;
}

export type HeaderValue = string | { env: string };

export interface HttpExpect {
  status?: number | number[];
  bodyContains?: StrOrList;
  bodyNotContains?: StrOrList;
  bodyMatches?: string;
}

export interface HttpCriterion extends BaseCriterion {
  type: 'http';
  url: string;
  timeoutMs?: number;
  headers?: Record<string, HeaderValue>;
  expect?: HttpExpect;
}

export interface Range {
  min?: number;
  max?: number;
  exact?: number;
}

export interface CountDirCriterion extends BaseCriterion, Range {
  type: 'count';
  dir: string;
  glob?: string;
}

export interface CountFileCriterion extends BaseCriterion, Range {
  type: 'count';
  file: string;
  unit: 'lines' | 'csv-rows' | 'jsonl';
}

export type JsonType = 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object';

export interface JsonCriterion extends BaseCriterion, Range {
  type: 'json';
  file: string;
  pointer: string;
  equals?: unknown;
  exists?: boolean;
  is?: JsonType;
}

export type Criterion =
  | TestCriterion
  | FileCriterion
  | DiffCriterion
  | HttpCriterion
  | CountDirCriterion
  | CountFileCriterion
  | JsonCriterion;

export interface CheckResult {
  verdict: Verdict;
  evidence: string;
  reason: string;
  durationMs: number;
}

export interface BaseInfo {
  source: 'lock' | 'ref' | 'head' | 'none';
  ref: string | null;
  sha: string | null;
  lockedAt: string | null;
}

export type FindingId =
  | 'CRITERIA-CHANGED'
  | 'NO-BASE'
  | 'BASE-IS-HEAD'
  | 'BASE-NOT-ANCESTOR'
  | 'STALE-LOCK'
  | 'LOCK-IGNORED'
  | 'RUNNER-CHANGED'
  | 'GIT-HIDING';

export interface Finding {
  id: FindingId;
  severity: 'warn' | 'info';
  message: string;
}

export interface SecretRef {
  name: string;
  value: string;
}

export interface ChangedSetResult {
  ok: true;
  paths: Set<string>;
  hiding: string[];
}

export interface ChangedSetError {
  ok: false;
  error: string;
}

export type ChangedSet = ChangedSetResult | ChangedSetError;

export interface CheckContext {
  root: string;
  base: BaseInfo;
  changedSet(): Promise<Set<string> | { error: string }>;
  secrets: SecretRef[];
  now: () => Date;
}

export interface VerdictSummary {
  total: number;
  pass: number;
  fail: number;
  unverified: number;
}

export interface ReceiptCriterion {
  id: string;
  type: Criterion['type'];
  spec: Record<string, unknown>;
  verdict: Verdict;
  evidence: string;
  reason: string;
  durationMs: number;
}

export interface ReceiptBase {
  source: BaseInfo['source'];
  ref: string | null;
  sha: string | null;
  lockedAt: string | null;
}

export interface ReceiptHead {
  sha: string | null;
  dirty: boolean;
}

export interface ReceiptEnvironment {
  node: string;
  platform: string;
}

export interface Receipt {
  schema: 1;
  tool: string;
  version: string;
  createdAt: string;
  claim: string | null;
  base: ReceiptBase;
  head: ReceiptHead | null;
  criteriaFile: { path: string; sha256: string };
  environment: ReceiptEnvironment;
  criteria: ReceiptCriterion[];
  verdict: RunVerdict;
  summary: VerdictSummary;
  findings: Finding[];
  sha256: string;
}
