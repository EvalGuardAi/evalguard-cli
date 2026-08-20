import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { wilsonInterval } from "@evalguard/core";
import { evaluateGateDecision, gateZFor, registerGate } from "../gate.js";

/**
 * Audit #45 (plan D2) — the CI gate had no significance mode.
 *
 * `grep -n 'significan|pValue|bootstrap|confidence' apps/cli/src/commands/gate.ts`
 * returned zero hits: the gate exposed only `--threshold`, so a 20-case run at
 * 85% was indistinguishable from a real regression at 85% and every flake
 * blocked a deploy. The statistics engine already shipped in @evalguard/core;
 * this is the customer-facing half.
 */

const base = {
  threshold: 0.9,
  strict: false,
  significance: true,
  confidence: 0.95,
  allowInconclusive: false,
};

describe("evaluateGateDecision — default (no --significance) is unchanged", () => {
  it("passes on pass rate >= threshold", () => {
    const d = evaluateGateDecision({ ...base, significance: false, passed: 9, total: 10 });
    expect(d.verdict).toBe("pass");
    expect(d.pass).toBe(true);
  });

  it("fails on pass rate < threshold, regardless of sample size", () => {
    // The old behaviour, kept verbatim: 8/10 blocks even though 10 cases cannot
    // statistically distinguish 80% from 90%.
    const d = evaluateGateDecision({ ...base, significance: false, passed: 8, total: 10 });
    expect(d.verdict).toBe("fail");
    expect(d.pass).toBe(false);
    expect(d.interval).toBeUndefined();
  });

  it("--strict fails on a single failure even above threshold", () => {
    const d = evaluateGateDecision({
      ...base,
      significance: false,
      strict: true,
      threshold: 0.5,
      passed: 99,
      total: 100,
    });
    expect(d.pass).toBe(false);
  });
});

describe("evaluateGateDecision — --significance", () => {
  it("a small run below threshold is INCONCLUSIVE, not a regression", () => {
    // 8/10 = 80%. The 95% Wilson interval runs to ~97.5%, which still covers the
    // 90% threshold — this run genuinely cannot tell a regression from noise.
    const d = evaluateGateDecision({ ...base, passed: 8, total: 10 });
    expect(d.verdict).toBe("inconclusive");
    expect(d.interval![1]).toBeGreaterThanOrEqual(base.threshold);
    expect(d.reason).toMatch(/cannot distinguish that from noise/);
  });

  it("INCONCLUSIVE still blocks by default (a gate must not get more permissive)", () => {
    expect(evaluateGateDecision({ ...base, passed: 8, total: 10 }).pass).toBe(false);
  });

  it("--allow-inconclusive lets the inconclusive run through", () => {
    const d = evaluateGateDecision({ ...base, passed: 8, total: 10, allowInconclusive: true });
    expect(d.verdict).toBe("inconclusive");
    expect(d.pass).toBe(true);
  });

  it("a large run below threshold is a real FAIL (interval clears the threshold)", () => {
    // 800/1000 = 80%; the 95% interval tops out near 82.4%, well under 90%.
    const d = evaluateGateDecision({ ...base, passed: 800, total: 1000 });
    expect(d.verdict).toBe("fail");
    expect(d.pass).toBe(false);
    expect(d.interval![1]).toBeLessThan(base.threshold);
    expect(d.reason).toMatch(/95% confidence/);
  });

  it("--allow-inconclusive does NOT let a real regression through", () => {
    const d = evaluateGateDecision({ ...base, passed: 800, total: 1000, allowInconclusive: true });
    expect(d.verdict).toBe("fail");
    expect(d.pass).toBe(false);
  });

  it("a run at or above threshold passes without consulting the interval", () => {
    const d = evaluateGateDecision({ ...base, passed: 95, total: 100 });
    expect(d.verdict).toBe("pass");
    expect(d.pass).toBe(true);
  });

  it("--strict still wins: zero-failures is an absolute claim, not a statistical one", () => {
    const d = evaluateGateDecision({ ...base, strict: true, passed: 99, total: 100, threshold: 0.5 });
    expect(d.verdict).toBe("fail");
    expect(d.pass).toBe(false);
  });

  it("a lower confidence narrows the interval and can turn inconclusive into fail", () => {
    const at95 = evaluateGateDecision({ ...base, passed: 40, total: 50 });
    const at80 = evaluateGateDecision({ ...base, passed: 40, total: 50, confidence: 0.8 });
    expect(at80.interval![1]).toBeLessThan(at95.interval![1]);
  });

  it("a zero-case run cannot pass", () => {
    const d = evaluateGateDecision({ ...base, passed: 0, total: 0 });
    expect(d.pass).toBe(false);
  });
});

describe("the gate's Wilson interval matches @evalguard/core's", () => {
  // The formula is inlined in gate.ts to keep evaluateGateDecision pure and
  // synchronous (the CLI loads core with a dynamic import inside the action).
  // This locks the two implementations together so they cannot drift.
  it.each([
    [8, 10],
    [800, 1000],
    [0, 5],
    [5, 5],
  ])("successes=%i trials=%i", (successes, trials) => {
    const fromGate = evaluateGateDecision({
      ...base,
      passed: successes,
      total: trials,
      threshold: 1.01, // force the significance branch so the interval is computed
    }).interval!;
    const fromCore = wilsonInterval(successes, trials, gateZFor(0.95));
    expect(fromGate[0]).toBeCloseTo(fromCore[0], 12);
    expect(fromGate[1]).toBeCloseTo(fromCore[1], 12);
  });
});

describe("registerGate exposes the significance flags", () => {
  const program = new Command();
  registerGate(program);
  const gate = program.commands.find((c) => c.name() === "gate")!;
  const flags = gate.options.map((o) => o.long);

  it("declares --significance, --confidence and --allow-inconclusive", () => {
    expect(flags).toContain("--significance");
    expect(flags).toContain("--confidence");
    expect(flags).toContain("--allow-inconclusive");
  });

  it("keeps --threshold and --strict", () => {
    expect(flags).toContain("--threshold");
    expect(flags).toContain("--strict");
  });
});
