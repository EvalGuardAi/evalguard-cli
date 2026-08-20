import { describe, it, expect, afterEach, vi } from "vitest";
import {
  readEvalPollResult,
  readScanPollResult,
  failSpinner,
  failExit,
  evalWaitExitCode,
  scanWaitExitCode,
} from "../poll.js";

/*
 * Regressions for the `eval --wait` / `scan --wait` polling defects (live E2E
 * audit 2026-07-15):
 *   - `eval --wait` read `data.status` but the API nests it under
 *     `data.run.status` → the poll never saw a terminal status and spun to
 *     timeout (README headline CI workflow broken).
 *   - `scan --wait` read `pollData.security_score` but the field is
 *     `score` / `pass_rate`.
 *   - both `.action()` catch paths did `spinner.fail() + process.exit(1)` while
 *     the spinner handle was still closing → libuv UV_HANDLE_CLOSING abort
 *     (exit 127) on Windows Node.
 */
describe("readEvalPollResult — tolerant of flat + nested `run` shapes", () => {
  it("reads flat top-level status/score/max_score (newer backend)", () => {
    expect(readEvalPollResult({ status: "passed", score: 8, max_score: 10 })).toEqual({
      status: "passed",
      score: 8,
      maxScore: 10,
    });
  });

  it("reads status/score from the nested `run` envelope (the --wait timeout bug)", () => {
    const r = readEvalPollResult({ run: { status: "failed", score: 3, max_score: 10 } });
    expect(r.status).toBe("failed");
    expect(r.score).toBe(3);
    expect(r.maxScore).toBe(10);
  });

  it("prefers the flat field over the nested one when both are present", () => {
    expect(readEvalPollResult({ status: "passed", run: { status: "running" } }).status).toBe(
      "passed",
    );
  });

  it("surfaces a non-terminal status while running (no false completion)", () => {
    expect(readEvalPollResult({ run: { status: "running" } }).status).toBe("running");
    expect(readEvalPollResult({}).status).toBeUndefined();
  });
});

describe("readScanPollResult — score under security_score / score / run.*", () => {
  it("reads the legacy `security_score` field", () => {
    const r = readScanPollResult({ status: "passed", security_score: 92 });
    expect(r.status).toBe("passed");
    expect(r.score).toBe(92);
  });

  it("reads the current `score` field", () => {
    expect(readScanPollResult({ status: "failed", score: 40 }).score).toBe(40);
  });

  it("reads status/score/pass_rate from a nested `run` envelope", () => {
    const r = readScanPollResult({ run: { status: "passed", score: 77, pass_rate: 0.8 } });
    expect(r.status).toBe("passed");
    expect(r.score).toBe(77);
    expect(r.passRate).toBe(0.8);
  });

  it("reads criticalCount from the body, run, or summary envelope", () => {
    expect(readScanPollResult({ status: "passed", criticalCount: 2 }).criticalCount).toBe(2);
    expect(readScanPollResult({ status: "passed", critical_count: 3 }).criticalCount).toBe(3);
    expect(readScanPollResult({ run: { critical: 1 } }).criticalCount).toBe(1);
    expect(readScanPollResult({ summary: { critical: 4 } }).criticalCount).toBe(4);
    expect(readScanPollResult({ status: "passed" }).criticalCount).toBeUndefined();
  });
});

// ── C1: fail-closed CI exit codes for `eval --wait` / `scan --wait` ──────────
// A FAILED/ERROR terminal status (or a scan with critical findings) MUST exit
// non-zero so the run gates the build. The `--wait` loops used to print `● FAILED`
// and return exit 0 — a failing security scan did NOT fail CI (audit C1).
describe("evalWaitExitCode — fail-closed on FAILED/ERROR terminal status", () => {
  it("exits 1 on a FAILED terminal status", () => {
    expect(evalWaitExitCode("failed")).toBe(1);
  });

  it("exits 1 on an ERROR terminal status", () => {
    expect(evalWaitExitCode("error")).toBe(1);
  });

  it("exits 0 on a passed / completed run", () => {
    expect(evalWaitExitCode("passed")).toBe(0);
    expect(evalWaitExitCode("completed")).toBe(0);
  });

  it("exits 0 for a non-terminal / unknown status (caller only calls this at terminal)", () => {
    expect(evalWaitExitCode("running")).toBe(0);
    expect(evalWaitExitCode(undefined)).toBe(0);
  });
});

describe("scanWaitExitCode — fail-closed on FAILED/ERROR or critical findings", () => {
  it("exits 1 on FAILED / ERROR", () => {
    expect(scanWaitExitCode("failed")).toBe(1);
    expect(scanWaitExitCode("error")).toBe(1);
  });

  it("exits 1 when the run passed but reported critical findings", () => {
    expect(scanWaitExitCode("passed", 1)).toBe(1);
    expect(scanWaitExitCode("completed", 5)).toBe(1);
  });

  it("exits 0 on a clean passed scan (zero / absent criticals)", () => {
    expect(scanWaitExitCode("passed", 0)).toBe(0);
    expect(scanWaitExitCode("passed")).toBe(0);
    expect(scanWaitExitCode("completed", 0)).toBe(0);
  });
});

describe("failSpinner — clean exit without process.exit() (libuv abort guard)", () => {
  const original = process.exitCode;
  afterEach(() => {
    process.exitCode = original;
  });

  it("stops the spinner with the message and sets exitCode=1 (never calls process.exit)", () => {
    let failedWith: string | undefined;
    const spinner = {
      fail: (m?: string) => {
        failedWith = m;
        return spinner;
      },
    };
    failSpinner(spinner, "API error 500: boom");
    expect(failedWith).toBe("API error 500: boom");
    expect(process.exitCode).toBe(1);
  });
});

describe("failExit — spinner-less clean exit without process.exit() (undici libuv abort guard)", () => {
  const original = process.exitCode;
  afterEach(() => {
    process.exitCode = original;
    vi.restoreAllMocks();
  });

  it("writes the pre-formatted line to stderr and sets exitCode=1, never calling process.exit", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // If failExit ever regressed to process.exit(), this stub would throw and
    // fail the test instead of silently killing the vitest worker.
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {
        throw new Error("process.exit must not be called on the HTTP error path");
      }) as never);

    failExit("agent-tools list failed: API error 403: forbidden");

    expect(err).toHaveBeenCalledWith("agent-tools list failed: API error 403: forbidden");
    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("honors a custom non-zero exit code", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit must not be called");
    }) as never);

    failExit("boom", 2);

    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });
});
