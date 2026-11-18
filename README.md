# agent-receipt-check

**Done is a claim. Check it.**

Coding agents declare victory without checking. In UC Berkeley's MAST study of multi-agent LLM
system failures, 21.3% fell under task verification and termination — stopping early, or checking
incompletely or incorrectly ([arXiv:2503.13657](https://arxiv.org/abs/2503.13657)).

This CLI takes the acceptance criteria you wrote *before* the run, locks them so the agent cannot
silently weaken them, and re-checks each one against what actually happened: the tests ran, the
files changed, the data landed, the endpoint answers. It writes a sealed receipt with the evidence.
It runs entirely on your machine, needs no hook and no sandbox, and never prints a secret it can
recognise.

Requires Node.js 22 or newer. Zero runtime dependencies.

## 60-second quickstart

```sh
# 1. before the agent starts: write receipt.criteria.json, then
npx agent-receipt-check lock

# 2. let the agent work

# 3. when it says done
npx agent-receipt-check verify
```

`lock` stores the criteria bytes and the current `HEAD` under `.git/`, so they do not dirty your
working tree and the agent cannot edit the copy `verify` reads. `verify` prints one line per
criterion, writes a sealed JSON receipt under `.git/agent-receipt/receipts/`, and exits `0` for
`VERIFIED`, `2` for `FAILED`.

## The criteria file

`receipt.criteria.json` (default name, resolved relative to the current directory):

```json
{
  "version": 1,
  "claim": "Add a /health endpoint and make the suite green",
  "criteria": [
    { "id": "suite-green", "type": "test",
      "command": "node --test --test-reporter=tap \"test/*.test.mjs\"",
      "expect": { "exit": 0, "stdoutContains": "# skipped 0" } },
    { "id": "tests-untouched", "type": "diff", "path": "test/", "changed": false },
    { "id": "health-file", "type": "file", "path": "src/health.ts", "contains": "200" },
    { "id": "health-route", "type": "diff", "path": "src/routes.ts", "changed": true },
    { "id": "health-live", "type": "http", "url": "http://localhost:3000/health",
      "expect": { "status": 200 } },
    { "id": "export-rows", "type": "count", "file": "out/users.csv", "unit": "csv-rows", "min": 100 },
    { "id": "summary-count", "type": "json", "file": "out/summary.json", "pointer": "/count", "equals": 100 }
  ]
}
```

- `version` is required and must be `1`.
- `claim` is optional (≤ 2000 chars). `--claim` overrides it. It is what the agent said, not a verdict.
- `criteria` is required, non-empty, at most 200 items.
- Every criterion has an `id` matching `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` (unique), a `type`, and an
  optional `description` (≤ 500 chars). Any other key is a validation error — the schema is strict
  on purpose, so a typo cannot silently turn a check off.
- Paths inside criteria are relative to the project root. Absolute paths are rejected.
- Validation collects **all** errors and prints them; `lock` never stores invalid criteria.

## Criterion reference

`verify` runs criteria sequentially, in file order, so a test command may rely on an earlier
criterion's side effects.

### `test`

Run a shell command. `command` is required; `cwd` is a root-relative directory (default root);
`timeoutMs` defaults to 300000. `expect` is optional: `exit` defaults to `0`; `stdoutContains`,
`stdoutNotContains`, `stderrContains`, `stderrNotContains` accept a string or a non-empty array of
strings (plain substring match).

| Situation | Verdict | Reason |
|---|---|---|
| `cwd` missing | UNVERIFIED | `cwd <x> does not exist` |
| spawn error | UNVERIFIED | `could not start: <code>` |
| timed out | UNVERIFIED | `timed out after <n>s` |
| exit 127 (POSIX) / 9009 (Windows) | UNVERIFIED | `command not found (exit 127)` |
| killed by a signal | FAIL | `terminated by <signal>` |
| exit ≠ expected | FAIL | `exited <code>, expected <exp>` |
| a `*Contains` string missing | FAIL (UNVERIFIED if that stream was truncated) | `stdout lacks "<s>"` |
| a `*NotContains` string present | FAIL | `stdout contains "<s>"` |
| otherwise | PASS | `` `<command>` exited <code> (<t>s) `` |

Each stream is captured up to 10 MiB. ANSI escapes are stripped before matching. The child runs in
its own process group; a timeout (or Ctrl-C) terminates the whole group.

### `file`

`path` is required; `exists` defaults to `true`. With `exists: true` you may add `contains`,
`notContains` (string or string[]), `matches` (regex source, `mu`) and `sha256` (64 hex). With
`exists: false`, no other content field is allowed.

| Situation | Verdict |
|---|---|
| `exists:false` and missing | PASS (`absent as expected`) |
| `exists:false` and present | FAIL (`exists`) |
| missing | FAIL (`missing`) |
| is a directory | FAIL (`is a directory, expected a file`) |
| symlink whose realpath escapes root | UNVERIFIED (`symlink points outside root`) |
| EACCES / other IO error | UNVERIFIED (`unreadable: <code>`) |
| > 50 MiB with `contains`/`notContains`, or > 5 MiB with `matches` | UNVERIFIED (`too large to inspect`) |
| content check fails | FAIL, naming the first failing check |
| otherwise | PASS, evidence `<bytes> bytes, sha256 <first 12>…` |

`sha256` is streamed and has no size cap. File content never appears in evidence.

### `diff`

`path` is required: an exact file, a directory prefix ending in `/` (or a directory in the working
tree or the base tree), or a glob containing `*`, `?` or `{`. `changed` defaults to `true`.

The changed set is `git diff --no-renames <base>` ∪ untracked files not ignored by in-tree
`.gitignore` files ∪ paths the anti-hiding checks find. A directory prefix is matched with exactly
one trailing `/`, so `src` never matches `src2/x`. Deleting a directory still counts as a change
(the base tree decides it is a directory).

| Situation | Verdict |
|---|---|
| no base | UNVERIFIED (`no base to diff against`) |
| git error | UNVERIFIED (`git diff failed: <first line>`) |
| matches with `changed:true` | PASS (evidence lists up to 10 paths) |
| no match with `changed:true` | FAIL (`no change under <path> since <base7>`) |
| no match with `changed:false` | PASS (`unchanged since <base7>`) |
| matches with `changed:false` | FAIL (evidence lists the paths) |

### `http`

`url` is required and must be `http:` or `https:`. `timeoutMs` defaults to 10000 and is a **total**
deadline. `headers` maps a header name to a literal string or `{ "env": "VAR_NAME" }`. `expect` is
optional: `status` (integer or integer array, default `200`), `bodyContains`, `bodyNotContains`
(string or string[]), `bodyMatches` (regex source, `mu`). Redirects are **not** followed; a 3xx is
the observed status. At most 1 MiB of body is read.

| Situation | Verdict |
|---|---|
| an `env` header variable is unset | UNVERIFIED (`env VAR_NAME not set`) |
| DNS failure / refused / reset / TLS error | UNVERIFIED (`DNS lookup failed` / `connection refused` / `connection reset` / `TLS error: <code>`) |
| deadline exceeded | UNVERIFIED (`timed out after <n>s`) |
| status not expected | FAIL (`expected 200, got 503`) |
| body check fails | FAIL (UNVERIFIED if the body was truncated) |
| otherwise | PASS (`GET <redacted-url> → 200 (<t>ms)`) |

Evidence never includes header values or the body. Environment proxies are ignored.

### `count`

Exactly one mode. **Directory:** `dir` required, `glob` defaults to `**/*` and is matched against
paths relative to `dir` (`*` counts top-level files only). Regular files only; symlinks are not
followed; `.git` directories are skipped; 200 000 entries is the cap. **File:** `file` and `unit`
required, where `unit` is `lines` (non-empty lines), `csv-rows` (non-empty lines minus one header,
floor 0) or `jsonl` (non-empty lines, each must parse). Add exactly one of `min`, `max` or `exact`.

| Situation | Verdict |
|---|---|
| dir/file missing | count `0`, then evaluate the range (evidence says `does not exist`) |
| `dir` is a file / `file` is a dir | FAIL (`not a directory` / `is a directory`) |
| IO error | UNVERIFIED |
| `jsonl` line invalid | FAIL (`line <n> is not valid JSON`) |
| count in range | PASS |
| out of range | FAIL (`<n> rows, expected ≥ 100`) |

### `json`

`file` and `pointer` are required (`""` means the whole document; RFC 6901, `~0`/`~1` escapes).
Add exactly one assertion: `equals` (any JSON value; key order does not matter), `exists` (bool),
`is` (`string`, `number`, `integer`, `boolean`, `null`, `array`, `object`), or a numeric range
`min`/`max`/`exact` (applies to a number, or to the length of an array or string).

| Situation | Verdict |
|---|---|
| file missing | FAIL |
| file > 50 MiB | UNVERIFIED (`too large`) |
| invalid JSON | FAIL (`not valid JSON: <message>`) |
| pointer not found | FAIL (PASS when `exists:false`) |
| assertion fails | FAIL (`/count is 0, expected 100`) |
| otherwise | PASS |

## Protect what the criteria invoke

Criteria are only as strong as the code and config they call. Two habits matter:

1. **Pin the test directory.** Add `{ "id": "tests-untouched", "type": "diff", "path": "test/",
   "changed": false }` and do the same for `src` files the agent should not edit.
2. **Watch the runner config.** `verify` warns with `RUNNER-CHANGED` when a base exists, at least
   one `test` criterion exists, and a changed path looks like runner configuration (`package.json`,
   lockfiles, `tsconfig.json`, `jest.config.*`, `vitest.config.*`, `pytest.ini`, `Makefile`, …).
   The warning lists up to three paths. It is a warning, not a block — pair it with
   `diff changed:false` on those files.

A command that runs **zero** tests often exits `0`. Assert the runner's own summary too:
`stdoutContains: "# skipped 0"`, or `"# fail 0"`, or whatever your runner prints when it actually
ran a suite. The `honest` and `lying-skip` sessions in `test/fixtures/sessions/` demonstrate both
sides.

## Base and the lock

`lock` records `HEAD`, the criteria text, and its SHA-256 under
`git rev-parse --git-path agent-receipt/lock.json` (inside `.git`, so it never dirties the tree).
`verify` picks the base with the first matching rule:

| # | Condition | Criteria from | Base | Findings |
|---|---|---|---|---|
| 1 | `--base <ref>` given | that commit | that commit | `LOCK-IGNORED` if a lock exists |
| 2 | a lock exists for this criteria path | the lock | lock's SHA | `STALE-LOCK` if > 24 h; `BASE-NOT-ANCESTOR` if it is not an ancestor of `HEAD` |
| 3 | git repo, no usable lock, criteria tracked at `HEAD` | `HEAD` | `HEAD` | `BASE-IS-HEAD` |
| 4 | otherwise | working tree | none | `NO-BASE` |

`CRITERIA-CHANGED` (warn) means the working-tree criteria differ from the chosen bytes (or were
deleted); the base version is used. `GIT-HIDING` (warn) means skip-worktree / assume-unchanged
entries differ from the base, or a `.gitignore` file changed; those paths were checked directly.
A corrupt lock, an unknown `--base` ref, a criteria file absent from `--base`, or a lock base that
no longer exists is a hard error (exit `1`) — `verify` never silently falls back.

Without a lock, rule 3 still protects you from *future* edits, but if the agent committed during
the session its commits are inside the base. Run `lock` **before** the agent starts.

## Receipts

Human output is short enough to paste:

```
agent-receipt-check 0.1.0
claim  "Add a /health endpoint and make the suite green"
base   lock a1b2c3d · locked 2026-11-18 09:12 UTC
criteria sha256 9f3e8a1c0b2d4e5f60718293a4b5c6d7e8f9012345678901234567890abcdef12
FAIL        suite-green — stdout lacks "# skipped 0"
FAILED — 1 of 1 failed (suite-green: stdout lacks "# skipped 0")
receipt .git/agent-receipt/receipts/20261118T091500123Z-FAILED.json
receipt sha256 1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809
```

The receipt is JSON with the tool version, claim, base, `HEAD`, criteria digest, one entry per
criterion (spec, verdict, evidence, reason, duration), the run verdict and summary, findings, and a
`sha256` seal. `--json` prints exactly the receipt; `--out <file>` writes it elsewhere.
`receipt show <file>` re-verifies the seal and prints `SEAL OK` or `SEAL BROKEN` (exit `2`).

Re-check the seal without this tool:

```sh
python3 -c "import json,sys,hashlib;d=json.load(open(sys.argv[1],encoding='utf-8'));s=d.pop('sha256');c=hashlib.sha256(json.dumps(d,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest();print('OK' if c==s else 'BROKEN',c)" receipt.json
```

**The seal is not a signature.** It proves the receipt's contents were not changed after writing
(unless the changer re-sealed). It does not prove who wrote it. `verify` prints the receipt SHA-256
in full so you can quote it somewhere the agent cannot reach.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | `verify`: VERIFIED, or UNVERIFIED without `--strict`. `lock`: written. `receipt show`: seal valid. `--help` / `--version`. |
| `1` | Usage or config error: bad flag, criteria missing/unparseable/invalid, unknown `--base`, criteria absent from `--base`, corrupt lock, unreadable receipt, not a receipt, failed receipt write. |
| `2` | `verify`: FAILED, or UNVERIFIED with `--strict`. `receipt show`: seal broken. |

## Security & privacy

- **Network:** the tool makes HTTP requests only for `http` criteria, only with `node:http` /
  `node:https` (`GET`, no redirects, 1 MiB body cap, proxies ignored). No telemetry. No update
  check. The test suite blocks every non-loopback connection with a preloaded guard.
- **Redaction is best-effort.** It knows common key shapes (PEM, AWS, GitHub, LLM, Slack, npm,
  Google, Stripe, JWT, Bearer/Basic, `key=value`, URL userinfo) and the values of environment
  variables whose names look secret. It replaces the project root with `<root>` and your home
  directory with `~`. It cannot catch a secret in an unfamiliar format. Do not print secrets from
  your check commands.
- **Test commands run with your privileges.** Criteria are executable configuration; review them
  before running `verify`, especially if they came from someone else.
- **Ignored files are invisible to `diff`.** Files ignored by the base's own `.gitignore` remain
  invisible (documented limit). `GIT-HIDING` covers `.gitignore` changes, skip-worktree and
  assume-unchanged entries.
- **No sandbox.** `verify` re-checks state in place. It does not restore a clean copy or isolate
  the test runner.

## What it does not prove

It does not prove the code is correct. A receipt proves the claimed effect happened — not that the
solution is right. A criterion can be too weak, a regex can be too broad, and a determined agent
can still change a runner in a way the warning notices but does not block.

## How is this different from Countercheck?

[Agent Countercheck](https://github.com/datacrate360/agent-countercheck) is the mature tool in this
space, and if you want the strongest guarantees you should look at it. It is a Rust binary that
locks checks from the base commit, restores protected files into a clean copy, and re-runs the
checks in an OS sandbox. It has stop hooks for most coding agents and a GitHub Action.

agent-receipt-check is smaller on purpose: criteria are declarative JSON (a file exists and
contains X, a CSV has at least N rows, a JSON field equals Y, an endpoint returns 200, a directory
did *not* change), it runs with `npx` and needs no install, hook, or sandbox setup, and it
re-checks state in place. That is also its main limit: no sandbox and no clean copy, so a
determined agent that changes your test runner config can still mislead a `test` criterion. The
tool warns (`RUNNER-CHANGED`), and a `diff changed:false` criterion catches it.

## It caught your agent? Open an issue

Use the **Caught a false "done"** template:
<https://github.com/maxya/agent-receipt-check/issues/new/choose>. Say which agent, what it claimed,
and which criterion type caught it. Paste the FAIL line only — **no secrets, tokens, or private
paths**.

## License

MIT. See [LICENSE](LICENSE).
