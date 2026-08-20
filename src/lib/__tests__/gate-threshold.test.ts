import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseGateThreshold } from "../gate-threshold.js";

// Audit L11 / L14 / L15: `--min-agreement`, `--fail-above` and `--fail-below`
// were compared against a bare `Number(flag)`. Every comparison with NaN is
// false, so a typo'd threshold ("7.5%", "high", "0,8") turned the CI gate into
// a no-op that reported success. A gate that silently stopped gating is worse
// than one that refuses to run — these pin the fail-CLOSED behaviour.

let exitSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`EXIT:${code}`);
  }) as never);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  exitSpy.mockRestore();
  errSpy.mockRestore();
});

describe("parseGateThreshold", () => {
  it("returns the parsed number for a valid threshold", () => {
    expect(parseGateThreshold("0.66", "--min-agreement", { min: 0, max: 1 })).toBe(0.66);
    expect(parseGateThreshold(70, "--fail-above", { min: 0, max: 100 })).toBe(70);
    expect(parseGateThreshold(" 5 ", "--fail-below", { min: 0, max: 10 })).toBe(5);
  });

  it.each(["7.5%", "high", "0,8", "", "NaN", "--json"])(
    "EXITS rather than silently disabling the gate for %j",
    (bad) => {
      expect(() => parseGateThreshold(bad, "--fail-below")).toThrow("EXIT:2");
      expect(errSpy).toHaveBeenCalled();
    },
  );

  it("exits on Infinity — it is a number but never a valid threshold", () => {
    expect(() => parseGateThreshold("Infinity", "--fail-above")).toThrow("EXIT:2");
  });

  it("exits when the value is outside the declared range", () => {
    expect(() => parseGateThreshold("1.5", "--min-agreement", { min: 0, max: 1 })).toThrow("EXIT:2");
    expect(() => parseGateThreshold("-1", "--fail-below", { min: 0, max: 10 })).toThrow("EXIT:2");
  });

  it("does NOT treat a NaN comparison as a pass (the original defect, stated directly)", () => {
    // The old code did: `if (agreement < Number("high")) process.exit(1)`.
    expect(0.1 < Number("high")).toBe(false); // ← the silent pass
    expect(() => parseGateThreshold("high", "--min-agreement", { min: 0, max: 1 })).toThrow("EXIT:2");
  });
});
