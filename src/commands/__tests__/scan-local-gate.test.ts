import { describe, it, expect } from "vitest";
import { resolveScanLocalGate } from "../scan-local.js";

// Regression (audit 2026-07-25): `scan:local` exited with
// `process.exit(result.criticalCount > 0 ? 1 : 0)`. A scan that found 12
// successful HIGH-severity jailbreaks and zero CRITICALs printed
// "HIGH 12 high severity issues" and then exited 0 — CI went green and the
// vulnerabilities shipped. secret-scan / iac-scan / code-scan all gate on high+
// by default; scan:local now matches.

describe("resolveScanLocalGate", () => {
  it("**fails on HIGH by default** (the shipped fail-open)", () => {
    const g = resolveScanLocalGate({ criticalCount: 0, highCount: 12 }, "high");
    expect(g.shouldFail).toBe(true);
    expect(g.gatedCount).toBe(12);
    expect(g.gateLabel).toBe("high");
  });

  it("defaults to high when --fail-on is omitted", () => {
    expect(resolveScanLocalGate({ highCount: 1 }, undefined as unknown as string).shouldFail).toBe(true);
  });

  it("passes a clean scan", () => {
    const g = resolveScanLocalGate({ criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 }, "high");
    expect(g.shouldFail).toBe(false);
    expect(g.gatedCount).toBe(0);
  });

  it("high gate ignores medium/low findings", () => {
    expect(resolveScanLocalGate({ mediumCount: 9, lowCount: 40 }, "high").shouldFail).toBe(false);
  });

  it("--fail-on medium widens the gate to medium+", () => {
    const g = resolveScanLocalGate({ criticalCount: 0, highCount: 0, mediumCount: 3, lowCount: 7 }, "medium");
    expect(g.shouldFail).toBe(true);
    expect(g.gatedCount).toBe(3);
  });

  it("--fail-on low counts everything", () => {
    const g = resolveScanLocalGate({ criticalCount: 1, highCount: 2, mediumCount: 3, lowCount: 4 }, "low");
    expect(g.gatedCount).toBe(10);
  });

  it("--fail-on critical preserves the old (report-only-on-high) behavior", () => {
    expect(resolveScanLocalGate({ criticalCount: 0, highCount: 12 }, "critical").shouldFail).toBe(false);
    expect(resolveScanLocalGate({ criticalCount: 1, highCount: 0 }, "critical").shouldFail).toBe(true);
  });

  it("--fail-on none disables gating entirely", () => {
    const g = resolveScanLocalGate({ criticalCount: 5, highCount: 9 }, "none");
    expect(g.shouldFail).toBe(false);
    expect(g.gateLabel).toBe("none");
  });

  it("is case-insensitive", () => {
    expect(resolveScanLocalGate({ highCount: 1 }, "HIGH").shouldFail).toBe(true);
    expect(resolveScanLocalGate({ criticalCount: 1 }, "NONE").shouldFail).toBe(false);
  });

  it("missing counts are treated as zero, never NaN", () => {
    const g = resolveScanLocalGate({}, "low");
    expect(g.shouldFail).toBe(false);
    expect(g.gatedCount).toBe(0);
  });
});
