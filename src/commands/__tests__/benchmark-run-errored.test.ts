import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

/**
 * `evalguard benchmark run` — a provider outage must never read as a score.
 *
 * `runBenchmarks` (packages/core/src/benchmarks/runner.ts) was hardened on
 * 2026-07-26 so a sample whose `callLLM` throws is NEVER graded: it is counted
 * in `errored` / `errorRate` and excluded from `correct`, `accuracy`,
 * `avgScore` and `categoryBreakdown`. The CLI is the shipped human surface for
 * that runner, and it printed only `accuracy`, `avgScore` and `duration` —
 * dropping `errored` entirely. So the hardening was invisible where a human
 * actually reads the result:
 *
 *   49 of 50 calls 503 → "Accuracy: 100.0% (1/50)" in GREEN, exit 0.
 *
 * The printed pair is also self-contradictory: the percentage is over GRADED
 * samples, the parenthetical denominator is over ATTEMPTED samples, so
 * `correct/totalSamples` does not equal the percentage next to it.
 *
 * Competitor reference: promptfoo prints errors as a first-class third line of
 * its CLI summary (`src/util/eval/summary.ts` → `getResultsLines`: passed /
 * failed / errors), never folded into the pass rate.
 */

/** Swapped per test; the mocked `makeCallLLM` returns a thunk that reads it. */
const callState: { impl: (prompt: string) => Promise<string> } = {
  impl: async () => "",
};

vi.mock("../../lib/call-llm.js", () => ({
  makeCallLLM: vi.fn(async () => (prompt: string) => callState.impl(prompt)),
  detectProviderFromModel: () => "openai",
  providerEnvVar: () => "OPENAI_API_KEY",
  resolveProviderKey: () => "sk-test",
}));

const ANSI = /\[[0-9;]*m/g;

interface Captured {
  out: string;
  exitCodes: number[];
}

async function runBenchmarkCli(argv: string[]): Promise<Captured> {
  const { registerBenchmark } = await import("../benchmark.js");
  const lines: string[] = [];
  const exitCodes: number[] = [];

  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCodes.push(code ?? 0);
    return undefined as never;
  }) as typeof process.exit);

  const program = new Command();
  program.exitOverride();
  registerBenchmark(program);
  await program.parseAsync(["node", "evalguard", ...argv]);

  return { out: lines.join("\n").replace(ANSI, ""), exitCodes };
}

/** MMLU ships a 26-sample static bank; the runner grades them sequentially. */
const MMLU_SAMPLES = 26;

beforeEach(() => {
  callState.impl = async () => "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Import-phase warm-up. `await import()` inside a test body is billed against
// `testTimeout`, and this file reaches `@evalguard/core` lazily, so the first
// case to touch it paid for the whole 2,173-file graph — ~5 s idle, and past
// the budget under the pre-push sweep. Loading it here moves that cost into
// the file's import phase, which vitest bills against no per-test budget.
// Must be top-level `await import`, not a static import: vitest hoists
// `vi.mock` above static imports. Full rationale: src/__tests__/cli-smoke.test.ts
await import("@evalguard/core");

describe("evalguard benchmark run — errored samples must be disclosed", () => {
  it("does not report a 100% score when 25 of 26 samples never ran", async () => {
    const { mmlu } = (await import("@evalguard/core")) as unknown as {
      mmlu: {
        generateSamples: (n?: number) => { input: string; expectedOutput: string }[];
      };
    };
    const answerByInput = new Map(
      mmlu.generateSamples(MMLU_SAMPLES).map((s) => [s.input, s.expectedOutput]),
    );

    // One real answer (graded CORRECT), then a total provider outage.
    let served = 0;
    callState.impl = async (prompt: string) => {
      if (served++ === 0) return answerByInput.get(prompt) ?? "B";
      throw new Error("503 upstream provider unavailable");
    };

    const { out } = await runBenchmarkCli([
      "benchmark",
      "run",
      "mmlu",
      "--model",
      "gpt-4o-mini",
      "--sample",
      "50",
    ]);

    // 1. The accuracy percentage and the fraction printed beside it must
    //    describe the SAME denominator. `100.0% (1/26)` is not a rounding
    //    quibble — it is two different units glued together.
    const acc = out.match(/Accuracy:\s+([\d.]+)%\s+\((\d+)\s*\/\s*(\d+)/);
    expect(acc, `no Accuracy line in:\n${out}`).not.toBeNull();
    const pct = Number(acc![1]);
    const shownCorrect = Number(acc![2]);
    const shownTotal = Number(acc![3]);
    expect(shownTotal).toBeGreaterThan(0);
    expect(Math.round((shownCorrect / shownTotal) * 100)).toBe(Math.round(pct));

    // 2. The 25 samples that never ran must be reported, with their count.
    const errored = out.match(/Errored:\s+(\d+)\s*\/\s*(\d+)/);
    expect(errored, `no Errored line in:\n${out}`).not.toBeNull();
    expect(Number(errored![1])).toBe(MMLU_SAMPLES - 1);
    expect(Number(errored![2])).toBe(MMLU_SAMPLES);
  });

  it("refuses to report an accuracy at all when every sample errored", async () => {
    callState.impl = async () => {
      throw new Error("503 upstream provider unavailable");
    };

    const { out, exitCodes } = await runBenchmarkCli([
      "benchmark",
      "run",
      "mmlu",
      "--model",
      "gpt-4o-mini",
      "--sample",
      "50",
    ]);

    // A total outage graded NOTHING. Printing "Accuracy: 0.0%" blames the
    // model for the outage — a verdict on absent data, the same fiction
    // regression-delta's `not-comparable` status exists to prevent.
    expect(out).not.toMatch(/Accuracy:\s+0\.0%/);
    const errored = out.match(/Errored:\s+(\d+)\s*\/\s*(\d+)/);
    expect(errored, `no Errored line in:\n${out}`).not.toBeNull();
    expect(Number(errored![1])).toBe(MMLU_SAMPLES);
    expect(Number(errored![2])).toBe(MMLU_SAMPLES);

    // Fail closed: a run that measured nothing must not exit 0.
    expect(exitCodes).toContain(1);
  });

  it("still prints a clean, error-free run without an Errored line", async () => {
    callState.impl = async () => "Answer: B";

    const { out, exitCodes } = await runBenchmarkCli([
      "benchmark",
      "run",
      "mmlu",
      "--model",
      "gpt-4o-mini",
      "--sample",
      "50",
    ]);

    expect(out).not.toMatch(/Errored:/);
    expect(out).toMatch(/Accuracy:/);
    expect(exitCodes).not.toContain(1);
  });
});
