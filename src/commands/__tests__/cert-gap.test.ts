import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerCertGap, parseScheme, parseStates } from "../cert-gap.js";
import { getCertRequirements, type CertificationScheme } from "@evalguard/core";

/**
 * `packages/core/src/certification/cert-gap-analyzer.ts` shipped pure + tested
 * but with ZERO callers on any shipped path (no route, no job, no CLI). This
 * suite is the reachability proof: `evalguard cert-gap` is the caller.
 */

function statesFor(scheme: CertificationScheme, state: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of getCertRequirements(scheme)) out[r.id] = state;
  return out;
}

// ── Reachability ───────────────────────────────────────────────────────────
// The whole point of this command is that `analyzeCertificationGap` had no
// caller. A command file that exists but is never registered on the real
// program is exactly as dead as the analyzer was, so pin the wiring.
describe("cert-gap — is reachable from the shipped CLI binary", () => {
  const cliSrc = join(__dirname, "..", "..");

  it("is exported from the commands barrel", async () => {
    const mod = await import("../index.js");
    expect(typeof (mod as Record<string, unknown>).registerCertGap).toBe("function");
  }, 30_000);

  it("is registered on the top-level program in src/index.ts", () => {
    const entry = readFileSync(join(cliSrc, "index.ts"), "utf8");
    expect(entry).toMatch(/registerCertGap,/);
    expect(entry).toMatch(/registerCertGap\(program\);/);
  });
});

describe("cert-gap — input validation fails closed", () => {
  it("rejects an unknown scheme", () => {
    expect(() => parseScheme("iso_9001")).toThrow(/unknown --scheme/);
    expect(() => parseScheme(undefined)).toThrow(/unknown --scheme/);
  });

  it("accepts every supported scheme", () => {
    for (const s of ["iso_42001", "iso_27001", "soc2_type2", "eu_ai_act_conformity"]) {
      expect(parseScheme(s)).toBe(s);
    }
  });

  it("rejects a states file that is not a JSON object", () => {
    expect(() => parseStates("iso_42001", ["42001-policy"])).toThrow(/must be a JSON object/);
    expect(() => parseStates("iso_42001", "met")).toThrow(/must be a JSON object/);
    expect(() => parseStates("iso_42001", null)).toThrow(/must be a JSON object/);
  });

  // A typo'd requirement id would otherwise be dropped silently and scored as a
  // gap — the operator reads a readiness number for controls they did not
  // declare, with no signal at all. Fail closed instead.
  it("rejects an unknown requirement id instead of silently scoring it as a gap", () => {
    expect(() => parseStates("iso_42001", { "42001-policy": "met", "42001-typo": "met" })).toThrow(
      /not in iso_42001: 42001-typo/,
    );
  });

  it("rejects an invalid state value", () => {
    expect(() => parseStates("iso_42001", { "42001-policy": "MET" })).toThrow(
      /invalid state value/,
    );
    expect(() => parseStates("iso_42001", { "42001-policy": true })).toThrow(/invalid state value/);
  });

  it("passes a well-formed states map straight through", () => {
    const states = parseStates("soc2_type2", statesFor("soc2_type2", "met"));
    expect(Object.keys(states)).toHaveLength(getCertRequirements("soc2_type2").length);
    expect(new Set(Object.values(states))).toEqual(new Set(["met"]));
  });
});

describe("cert-gap — end-to-end through the registered command", () => {
  let dir: string;
  let out: string[];
  let err: string[];
  let exitCode: number | undefined;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "eg-cert-gap-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    out = [];
    err = [];
    exitCode = undefined;
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      err.push(a.join(" "));
    });
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      exitCode = code;
      throw new Error(`__exit_${code}__`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function writeStates(name: string, body: unknown): string {
    const p = join(dir, name);
    writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body), "utf8");
    return p;
  }

  function run(argv: string[]): void {
    const program = new Command();
    program.exitOverride();
    registerCertGap(program);
    try {
      program.parse(["node", "evalguard", "cert-gap", ...argv]);
    } catch (e) {
      if (!/^__exit_/.test((e as Error).message)) throw e;
    }
  }

  it("--list prints every requirement of the scheme as a starter states file", () => {
    run(["--scheme", "iso_42001", "--list", "--json"]);
    const reqs = JSON.parse(out.join("\n"));
    expect(reqs).toHaveLength(getCertRequirements("iso_42001").length);
    expect(reqs[0]).toMatchObject({ id: "42001-policy", mandatory: true });
  });

  it("an all-met org is certifiable with a 100 readiness score", () => {
    const p = writeStates("all-met.json", statesFor("iso_42001", "met"));
    run(["--scheme", "iso_42001", "--states", p, "--json"]);
    const a = JSON.parse(out.join("\n"));
    expect(a.readinessScore).toBe(100);
    expect(a.certifiable).toBe(true);
    expect(a.stage).toBe("certifiable");
    expect(a.blockingGaps).toEqual([]);
  });

  it("an empty org is not_ready, and --min-readiness exits 1", () => {
    const p = writeStates("empty.json", {});
    run(["--scheme", "soc2_type2", "--states", p, "--json", "--min-readiness", "50"]);
    const a = JSON.parse(out.join("\n"));
    expect(a.readinessScore).toBe(0);
    expect(a.certifiable).toBe(false);
    expect(a.stage).toBe("not_ready");
    expect(a.blockingGaps.length).toBeGreaterThan(0);
    expect(exitCode).toBe(1);
  });

  it("--min-readiness does NOT exit when the bar is met", () => {
    const p = writeStates("iso27-met.json", statesFor("iso_27001", "met"));
    run(["--scheme", "iso_27001", "--states", p, "--json", "--min-readiness", "80"]);
    expect(exitCode).toBeUndefined();
  });

  // A non-numeric gate threshold must refuse to run, never silently pass
  // (every NaN comparison is false) — same contract as parseGateThreshold.
  it("a non-numeric --min-readiness exits 2 rather than silently passing", () => {
    const p = writeStates("gap.json", statesFor("iso_42001", "gap"));
    run(["--scheme", "iso_42001", "--states", p, "--json", "--min-readiness", "high"]);
    expect(exitCode).toBe(2);
  });

  it("a typo'd requirement id exits 2 and names it", () => {
    const p = writeStates("typo.json", { "42001-policy": "met", "42001-oops": "met" });
    run(["--scheme", "iso_42001", "--states", p, "--json"]);
    expect(exitCode).toBe(2);
    expect(err.join("\n")).toMatch(/42001-oops/);
  });

  it("an unknown scheme exits 2 and names the supported set", () => {
    run(["--scheme", "iso_9001", "--states", "controls.json"]);
    expect(exitCode).toBe(2);
    expect(err.join("\n")).toMatch(/iso_42001, iso_27001, soc2_type2, eu_ai_act_conformity/);
  });

  it("omitting --states exits 2 instead of analysing nothing", () => {
    run(["--scheme", "iso_42001"]);
    expect(exitCode).toBe(2);
    expect(err.join("\n")).toMatch(/--states <path> is required/);
  });

  it("renders a human report naming the blocking gaps", () => {
    const p = writeStates("partial.json", { ...statesFor("iso_42001", "met"), "42001-risk": "gap" });
    run(["--scheme", "iso_42001", "--states", p]);
    const text = out.join("\n");
    expect(text).toMatch(/ISO\/IEC 42001/);
    expect(text).toMatch(/42001-risk/);
    expect(text).toMatch(/1 blocking gap/);
    expect(exitCode).toBeUndefined();
  });
});
