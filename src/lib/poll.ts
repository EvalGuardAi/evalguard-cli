/**
 * Helpers for the `eval --wait` / `scan --wait` polling loops in `index.ts`.
 *
 * Kept in this side-effect-free module (not inline in `index.ts`, which calls
 * `program.parseAsync()` at import) so they can be unit-tested directly.
 */

/**
 * Read the terminal status + score of an eval run from a `GET /evals/{id}`
 * poll body, tolerant of BOTH response shapes: the flat top-level
 * `{ status, score, max_score }` (newer backend) AND the nested
 * `{ run: { status, score, max_score } }` (older/legacy backend). Reading only
 * `data.status` — as the CLI used to — spun `eval --wait` to timeout against
 * the nested shape because the status lived under `data.run.status`.
 */
export function readEvalPollResult(pollData: Record<string, unknown>): {
  status: string | undefined;
  score: unknown;
  maxScore: unknown;
} {
  const run = (pollData.run ?? {}) as Record<string, unknown>;
  return {
    status: (pollData.status ?? run.status) as string | undefined,
    score: pollData.score ?? run.score,
    maxScore:
      pollData.max_score ?? run.max_score ?? pollData.maxScore ?? run.maxScore,
  };
}

/**
 * Read the terminal status + security score of a scan from a
 * `GET /security/{id}` poll body. Tolerant of the nested `{ run: {...} }` shape
 * (older backend) and of the score living under `score`/`pass_rate` (current
 * API) OR the legacy `security_score` field the CLI used to read exclusively —
 * so `scan --wait` reports a score regardless of which field the backend sends.
 *
 * `criticalCount` is read from the poll body (or its `run`/`summary` envelope)
 * when present so a CI `scan --wait` can fail closed on critical findings even
 * if the terminal status was reported as `passed`/`completed`
 * (audit C1: cli-scan-wait-fail-open).
 */
export function readScanPollResult(pollData: Record<string, unknown>): {
  status: string | undefined;
  score: unknown;
  passRate: unknown;
  criticalCount: number | undefined;
} {
  const run = (pollData.run ?? {}) as Record<string, unknown>;
  const summary = (pollData.summary ?? run.summary ?? {}) as Record<string, unknown>;
  const rawCritical =
    pollData.criticalCount ??
    pollData.critical_count ??
    pollData.critical ??
    run.criticalCount ??
    run.critical_count ??
    run.critical ??
    summary.criticalCount ??
    summary.critical_count ??
    summary.critical;
  return {
    status: (pollData.status ?? run.status) as string | undefined,
    score:
      pollData.security_score ??
      pollData.score ??
      run.security_score ??
      run.score,
    passRate: pollData.pass_rate ?? run.pass_rate,
    criticalCount: typeof rawCritical === "number" ? rawCritical : undefined,
  };
}

/**
 * The process exit code an `eval --wait` should resolve to for a given TERMINAL
 * status, so a failing eval fails the CI build instead of exiting 0 (fail-open).
 * `failed`/`error` → 1 (block); `passed`/`completed` (and any other) → 0.
 * Mirrors the fail-closed exit semantics the `gate` command already implements
 * (audit C1: cli-eval-wait-fail-open).
 */
export function evalWaitExitCode(status: string | undefined): 0 | 1 {
  return status === "failed" || status === "error" ? 1 : 0;
}

/**
 * The process exit code a `scan --wait` should resolve to. A security scan is a
 * CI gate (the README pipeline example), so it MUST fail the build when the run
 * ended in `failed`/`error` OR reported any critical findings — even if the
 * server labelled the status `passed`/`completed`. Everything else → 0.
 */
export function scanWaitExitCode(
  status: string | undefined,
  criticalCount?: number,
): 0 | 1 {
  if (status === "failed" || status === "error") return 1;
  if (typeof criticalCount === "number" && criticalCount > 0) return 1;
  return 0;
}

/**
 * Stop a spinner with a failure message and flag the process for a non-zero
 * exit WITHOUT calling `process.exit()`. Calling `process.exit()` while ora's
 * spinner interval / stdout stream is still tearing down triggers a libuv
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` abort (exit code
 * 127) on Windows Node. Setting `process.exitCode` and letting the caller
 * `return` lets the event loop drain the handles and exit cleanly with code 1.
 */
export function failSpinner(
  spinner: { fail: (text?: string) => unknown },
  message: string,
): void {
  spinner.fail(message);
  process.exitCode = 1;
}

/**
 * The spinner-less sibling of {@link failSpinner}: print an already-formatted
 * error line and flag a non-zero exit WITHOUT calling `process.exit()`.
 *
 * The list/read commands that catch an HTTP error print the message themselves
 * (no ora spinner) and used to call `process.exit(1)` right after. On Windows
 * Node that fires while the global `fetch` (undici) keep-alive sockets from the
 * just-failed request are still in teardown, tripping the libuv
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` abort — the process
 * dies with 0xC0000409 / 127 instead of the intended non-zero code, breaking CI
 * exit codes (same class as fix #1183). Setting `process.exitCode` and letting
 * the caller `return` drains the open handles and exits cleanly with `code`
 * (default 1) on every platform.
 *
 * @param line  the fully-formatted line to write to stderr (callers keep their
 *              own chalk styling so output is unchanged).
 * @param code  the non-zero exit code to flag (default 1).
 */
export function failExit(line: string, code = 1): void {
  console.error(line);
  process.exitCode = code;
}
