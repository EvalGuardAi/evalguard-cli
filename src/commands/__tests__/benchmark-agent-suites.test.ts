import { describe, expect, it, vi, afterEach } from "vitest";
import { Command } from "commander";
import { registerBenchmark } from "../benchmark.js";

/**
 * Reachability proof for packages/core/src/agent-benchmarks
 * (AgentBenchmarkRunner). Before 2026-08 the module was exported from
 * `@evalguard/core` and imported by nothing but its own unit tests — no route,
 * no CLI command, no worker job. `evalguard benchmark agent-suites` is now the
 * shipped caller; `registerBenchmark` is invoked at apps/cli/src/index.ts:682.
 */

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

describe("evalguard benchmark agent-suites — registration", () => {
  it("registers `agent-suites` alongside the existing subcommands", () => {
    const program = new Command();
    registerBenchmark(program);
    const bench = program.commands.find((c) => c.name() === "benchmark");
    expect(bench).toBeDefined();
    const names = bench!.commands.map((c) => c.name());
    expect(names).toContain("agent-suites");
    // Must not have displaced what was already there.
    expect(names).toContain("list");
    expect(names).toContain("run");
  });
});

describe("evalguard benchmark agent-suites — end to end", () => {
  it("prints every built-in agent suite id as JSON", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    const program = new Command();
    program.exitOverride();
    registerBenchmark(program);
    await program.parseAsync(["node", "evalguard", "benchmark", "agent-suites", "--json"]);

    const parsed = JSON.parse(lines.join("\n"));
    expect(Array.isArray(parsed)).toBe(true);
    const ids = parsed.map((s: { suiteId: string }) => s.suiteId);
    // Sample across the four generations of suite ids in BUILTIN_BENCHMARKS.
    expect(ids).toContain("swe-bench");
    expect(ids).toContain("screenspot-v2");
    expect(ids).toContain("needlebench");
    expect(ids).toContain("bfcl-v3");
    // "custom" is not a built-in and must never be listed as one.
    expect(ids).not.toContain("custom");
  });

  it("renders a human table without throwing", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });

    const program = new Command();
    program.exitOverride();
    registerBenchmark(program);
    await program.parseAsync(["node", "evalguard", "benchmark", "agent-suites"]);

    const out = lines.join("\n");
    expect(out).toContain("Agent Benchmark Suites");
    expect(out).toContain("swe-bench");
    // The BYO-dataset caveat is load-bearing: these suites ship zero tasks.
    expect(out).toContain("BYO-dataset");
  });
});
