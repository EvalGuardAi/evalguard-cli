import { describe, expect, it, vi, afterEach } from "vitest";
import { Command } from "commander";
import { registerBenchmark } from "../benchmark.js";

/**
 * `evalguard benchmark list` (shipped, fully-sampled suites) and `evalguard
 * benchmark agent-suites` (BYO-dataset agent suite definitions) print under the
 * SAME command namespace. Core renamed the three colliding ids to `<id>-agent`
 * and now declares each one's `shippedBenchmarkId`; this asserts the CLI
 * actually SHOWS that distinction rather than printing two similar ids and
 * leaving the reader to guess.
 *
 * Core is mocked here on purpose: this file tests the CLI's rendering, and
 * `@evalguard/core` resolves to a BUILT dist that lags the workspace source.
 * The real catalog invariant (no id in both catalogs) is proved against real
 * data in packages/core/src/agent-benchmarks/__tests__/suite-id-namespace.test.ts.
 */

const SUITES = [
  {
    suiteId: "swe-bench",
    name: "SWE-bench",
    description: "Real GitHub issues",
    version: "1.0.0",
    scoringWeights: {
      taskCompletion: 0.5,
      stepEfficiency: 0.2,
      costEfficiency: 0.2,
      safetyScore: 0.1,
    },
    defaultTimeout: 600_000,
    sourceDataset: "https://example.invalid/swe-bench",
  },
  {
    suiteId: "mmbench-agent",
    name: "MMBench (agent)",
    description: "Multi-modal multi-choice",
    version: "1.0.0",
    scoringWeights: {
      taskCompletion: 0.8,
      stepEfficiency: 0.05,
      costEfficiency: 0.1,
      safetyScore: 0.05,
    },
    defaultTimeout: 60_000,
    sourceDataset: "https://example.invalid/mmbench",
    shippedBenchmarkId: "mmbench",
  },
];

vi.mock("@evalguard/core", () => ({
  AgentBenchmarkRunner: class {
    getAvailableSuites() {
      return SUITES;
    }
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

async function runAgentSuites(...extra: string[]): Promise<string> {
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  const program = new Command();
  program.exitOverride();
  registerBenchmark(program);
  await program.parseAsync([
    "node",
    "evalguard",
    "benchmark",
    "agent-suites",
    ...extra,
  ]);
  return lines.join("\n");
}

describe("benchmark agent-suites — shipped-benchmark disambiguation", () => {
  it("names the shipped benchmark a suffixed suite must not be confused with", async () => {
    const out = await runAgentSuites();
    // The distinct id is printed…
    expect(out).toContain("mmbench-agent");
    // …and so is the difference, with the command that runs the OTHER one.
    expect(out).toMatch(/evalguard benchmark run mmbench\b/);
  });

  it("does not invent a counterpart for suites that have none", async () => {
    const out = await runAgentSuites();
    expect(out).not.toMatch(/evalguard benchmark run swe-bench\b/);
  });

  it("carries shippedBenchmarkId through --json", async () => {
    const out = await runAgentSuites("--json");
    const parsed = JSON.parse(out) as Array<{
      suiteId: string;
      shippedBenchmarkId?: string;
    }>;
    const agent = parsed.find((s) => s.suiteId === "mmbench-agent");
    expect(agent?.shippedBenchmarkId).toBe("mmbench");
  });
});
