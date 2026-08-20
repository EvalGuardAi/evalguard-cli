/**
 * `--fail-on <prototype-key>` must never green a CI gate.
 *
 * `repo-scan.ts:49-64` found and fixed this, and documented it verbatim:
 *
 *   The obvious `if (v in SEVERITY_RANK)` guard is UNSOUND and was the shipped
 *   one: `in` walks the prototype chain, so `constructor`, `__proto__`,
 *   `toString`, `valueOf`, `hasOwnProperty`, … all pass. `SEVERITY_RANK[v]` is
 *   then a function or an object, every `rank >= threshold` comparison coerces
 *   to NaN and is false, `flagged` is 0, and the gate exits 0 on a repo full of
 *   criticals.
 *
 * The fix landed on ONE of the four gate commands. `iac-scan.ts:185`,
 * `secret-scan.ts:223,302` and `scan-local.ts:54,272` kept the `in` guard, and
 * two of them compound it: `RANK[poisoned] ?? RANK.high` does NOT fall back,
 * because `SEVERITY_RANK["constructor"]` is the Object constructor — truthy,
 * non-nullish — so the threshold itself becomes a function and every
 * `rank >= threshold` is NaN-false.
 *
 * Exit-code contract these gates claim (iac-scan.ts:19-20, secret-scan.ts:16-17):
 *   0 — no findings at/above the threshold
 *   1 — findings at/above the threshold (CI gate fail)
 * Distinct exit codes matter here: a gate that cannot distinguish "clean"
 * from "threshold was unparseable" reports both as success.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseSeverityGate, severityRank } from "../lib/gate-threshold";
import { parseSeverity } from "../commands/repo-scan";
import { resolveSecretScanGate } from "../commands/secret-scan";
import { resolveScanLocalGate } from "../commands/scan-local";
import { executeIacScan } from "../commands/iac-scan";

/**
 * Every key reachable through Object.prototype. Each one satisfies
 * `key in SEVERITY_RANK` while owning no severity meaning whatsoever.
 */
const PROTOTYPE_KEYS = [
  "constructor",
  "__proto__",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
] as const;

const REAL_SEVERITIES = ["low", "medium", "high", "critical"] as const;

// Import-phase warm-up. `await import()` inside a test body is billed against
// `testTimeout`, and this file reaches `@evalguard/core` lazily, so the first
// case to touch it paid for the whole 2,173-file graph — ~5 s idle, and past
// the budget under the pre-push sweep. Loading it here moves that cost into
// the file's import phase, which vitest bills against no per-test budget.
// Must be top-level `await import`, not a static import: vitest hoists
// `vi.mock` above static imports. Full rationale: src/__tests__/cli-smoke.test.ts
await import("@evalguard/core");

describe("shared severity-gate parser", () => {
  it.each(PROTOTYPE_KEYS)("rejects --fail-on %s", (key) => {
    expect(parseSeverityGate(key)).toBeNull();
    expect(parseSeverityGate(key, { allowNone: true })).toBeNull();
  });

  it.each(REAL_SEVERITIES)("accepts %s", (sev) => {
    expect(parseSeverityGate(sev)).toBe(sev);
    expect(parseSeverityGate(sev.toUpperCase())).toBe(sev);
    expect(parseSeverityGate(`  ${sev}  `)).toBe(sev);
  });

  it("accepts `none` only where the command opted in", () => {
    expect(parseSeverityGate("none")).toBeNull();
    expect(parseSeverityGate("none", { allowNone: true })).toBe("none");
  });

  it("rejects near-misses instead of silently defaulting", () => {
    for (const bad of ["severe", "", "  ", "criticalx", "hi", "0", "3"]) {
      expect(parseSeverityGate(bad, { allowNone: true })).toBeNull();
    }
  });

  it("severityRank returns null — never a function — for a prototype key", () => {
    for (const key of PROTOTYPE_KEYS) {
      expect(severityRank(key)).toBeNull();
    }
    expect(severityRank("critical")).toBe(3);
    expect(severityRank("low")).toBe(0);
  });

  it("repo-scan's parseSeverity is the shared parser, not a second copy", () => {
    for (const key of PROTOTYPE_KEYS) expect(parseSeverity(key)).toBeNull();
    for (const sev of REAL_SEVERITIES) expect(parseSeverity(sev)).toBe(sev);
  });
});

describe("secret-scan gate — a poisoned threshold cannot hide committed secrets", () => {
  const CRITICAL_FINDINGS = [
    { severity: "critical" as const },
    { severity: "critical" as const },
    { severity: "high" as const },
  ];

  it.each(PROTOTYPE_KEYS)("fails closed on --fail-on %s", (key) => {
    const gate = resolveSecretScanGate(CRITICAL_FINDINGS, "low", key, false);
    expect(
      gate.shouldFail,
      `3 committed secrets (2 critical) and the gate said pass under --fail-on ${key}`,
    ).toBe(true);
  });

  it("still honours a real threshold", () => {
    expect(resolveSecretScanGate(CRITICAL_FINDINGS, "low", "critical", false).gatedCount).toBe(2);
    expect(resolveSecretScanGate(CRITICAL_FINDINGS, "low", "high", false).gatedCount).toBe(3);
    expect(resolveSecretScanGate(CRITICAL_FINDINGS, "low", "none", false).shouldFail).toBe(false);
    expect(resolveSecretScanGate([], "low", "high", false).shouldFail).toBe(false);
  });
});

describe("iac-scan gate — end to end over a real critical manifest", () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evalguard-iac-gate-"));
    fs.writeFileSync(
      path.join(tmpRoot, "Dockerfile"),
      "FROM vllm/vllm-openai\nENV OPENAI_API_KEY=sk-abcdEFGH1234567890ijklMNOP\nEXPOSE 8000\n",
    );
  });
  afterEach(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

  it("gates the critical finding under a real threshold", async () => {
    const res = await executeIacScan({ targetAbs: tmpRoot, failOn: "critical", maxBytes: 1_000_000 });
    expect(res.bySeverity.critical).toBeGreaterThanOrEqual(1);
    expect(res.exitCode).toBe(1);
  });

  it.each(PROTOTYPE_KEYS)("refuses to run rather than exit 0 under --fail-on %s", async (key) => {
    // The flag parser rejects this before we get here (exit 2). If a future
    // caller skips the parser, the executor must NOT quietly report
    // `flagged: 0, exitCode: 0` over a baked credential.
    await expect(
      executeIacScan({
        targetAbs: tmpRoot,
        failOn: key as unknown as "critical",
        maxBytes: 1_000_000,
      }),
    ).rejects.toThrow(/refusing to run a gate/i);
  });
});

describe("scan:local gate — a poisoned threshold cannot hide jailbreaks", () => {
  const COUNTS = { criticalCount: 2, highCount: 12, mediumCount: 1, lowCount: 0 };

  it.each(PROTOTYPE_KEYS)("fails closed on --fail-on %s", (key) => {
    const gate = resolveScanLocalGate(COUNTS, key);
    expect(
      gate.shouldFail,
      `2 critical + 12 high findings and the gate said pass under --fail-on ${key}`,
    ).toBe(true);
  });

  it("still honours a real threshold", () => {
    expect(resolveScanLocalGate(COUNTS, "critical").gatedCount).toBe(2);
    expect(resolveScanLocalGate(COUNTS, "high").gatedCount).toBe(14);
    expect(resolveScanLocalGate(COUNTS, "medium").gatedCount).toBe(15);
    expect(resolveScanLocalGate(COUNTS, "none").shouldFail).toBe(false);
    expect(resolveScanLocalGate({}, "high").shouldFail).toBe(false);
  });
});
