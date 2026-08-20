import { describe, expect, it } from "vitest";
import { resolveSecretScanGate } from "../secret-scan.js";

const f = (severity: "low" | "medium" | "high" | "critical") => ({ severity });

describe("resolveSecretScanGate — secret-scan exit gate", () => {
  it("DEFAULT (--fail-on high) gates on high/critical, not on low/medium (regression: was never-gate)", () => {
    expect(resolveSecretScanGate([f("critical")], "low", "high", false).shouldFail).toBe(true);
    expect(resolveSecretScanGate([f("high")], "low", "high", false).shouldFail).toBe(true);
    expect(resolveSecretScanGate([f("medium"), f("low")], "low", "high", false).shouldFail).toBe(false);
    expect(resolveSecretScanGate([], "low", "high", false).shouldFail).toBe(false);
  });

  it("--fail-on critical gates only on critical", () => {
    expect(resolveSecretScanGate([f("high")], "low", "critical", false).shouldFail).toBe(false);
    expect(resolveSecretScanGate([f("critical")], "low", "critical", false).shouldFail).toBe(true);
  });

  it("--fail-on none disables gating (report-only escape hatch)", () => {
    expect(resolveSecretScanGate([f("critical")], "low", "none", false).shouldFail).toBe(false);
  });

  it("--fail-on-secret (back-compat) gates on ANY reported secret", () => {
    expect(resolveSecretScanGate([f("low")], "low", "high", true).shouldFail).toBe(true);
    expect(resolveSecretScanGate([], "low", "high", true).shouldFail).toBe(false);
  });

  it("reports gatedCount and the gate label", () => {
    const g = resolveSecretScanGate([f("critical"), f("high"), f("low")], "low", "high", false);
    expect(g.gatedCount).toBe(2); // critical + high, not the low
    expect(g.gateLabel).toBe("high");
    // fail-on-secret labels the gate by the reporting floor (minSeverity)
    expect(resolveSecretScanGate([f("low")], "low", "high", true).gateLabel).toBe("low");
  });

  /**
   * CHANGED 2026-08-03. This previously asserted "an unrecognized --fail-on
   * value falls back to high", i.e. `--fail-on garbage` + one MEDIUM committed
   * secret → `shouldFail: false`. The intent behind that assertion was "never
   * crashes", but what it pinned was a PASS on a gate the helper could not
   * evaluate — and it is the same shape that made `--fail-on constructor`
   * (a prototype key, which `in SEVERITY_RANK` waved through) exit 0 over
   * committed credentials.
   *
   * An unreadable threshold now gates EVERYTHING reported. Note what that does
   * NOT do: a clean scan still exits 0, so this cannot turn every run red — only
   * a run that found something the operator asked to be gated on with a
   * threshold nobody could read. The CLI itself never reaches here with garbage
   * (the flag parser exits 2 with a usage error); this is the second line, for
   * direct callers of the exported helper.
   */
  it("an unrecognized --fail-on value gates everything reported (fail closed, never crashes)", () => {
    expect(resolveSecretScanGate([f("high")], "low", "garbage", false).shouldFail).toBe(true);
    expect(resolveSecretScanGate([f("medium")], "low", "garbage", false).shouldFail).toBe(true);
    expect(resolveSecretScanGate([f("low")], "low", "constructor", false).shouldFail).toBe(true);
    // …but an unreadable threshold cannot invent findings.
    expect(resolveSecretScanGate([], "low", "garbage", false).shouldFail).toBe(false);
  });
});
