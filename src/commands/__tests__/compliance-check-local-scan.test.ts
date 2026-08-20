import { describe, it, expect, vi } from "vitest";
import { discardIfAllErrored } from "../compliance-check.js";
import { makeCallLLM } from "../../lib/call-llm.js";

/**
 * Regression: `evalguard compliance-check` local mode never called the model
 * (audit 2026-07-29, F31).
 *
 * `runSecurityScan` drives the target through `config.callLLM`
 * (scanner.ts:28 destructures `{ prompt, attackTypes, callLLM }`). The local
 * path passed `{ model, provider, apiKey }` and NO `callLLM`, so every attack
 * threw "callLLM is not a function"; the scanner caught that into `[ERROR] …`
 * findings and RESOLVED, so the outer `catch { scanResults = null }` dry-run
 * fallback never fired.
 *
 * Reproduced against packages/core/dist before the fix: 40 findings, every one
 * `output: "[ERROR] callLLM is not a function"`, errored:true / passed:false.
 * Feeding that to `new GapAnalysis().analyze(scan, EU_AI_ACT)` returned
 * `{overallScore: 0, met: 0, notMet: 14, untested: 21}` with notes reading
 * "All N test(s) failed. Immediate remediation required." — confident,
 * fabricated non-compliance for a model that was never contacted.
 */
describe("compliance-check local scan wiring", () => {
  describe("makeCallLLM", () => {
    it("passes the API key POSITIONALLY, as createProvider expects", async () => {
      const createProvider = vi.fn(() => ({ chat: async () => ({ content: "ok" }) }));
      await makeCallLLM("openai", "gpt-4o", createProvider as never, "sk-test");
      expect(createProvider).toHaveBeenCalledWith("openai", "sk-test");
      // The bug passed an options object; that does not throw, it just yields a
      // provider with no key.
      expect(createProvider).not.toHaveBeenCalledWith("openai", expect.any(Object));
    });

    it("returns a function that actually reaches the provider", async () => {
      const chat = vi.fn(async () => ({ content: "I can't help with that." }));
      const callLLM = await makeCallLLM(
        "openai",
        "gpt-4o",
        (() => ({ chat })) as never,
        "sk-test",
      );
      expect(typeof callLLM).toBe("function");
      await expect(callLLM("hello")).resolves.toBe("I can't help with that.");
      expect(chat).toHaveBeenCalledWith([{ role: "user", content: "hello" }], {
        model: "gpt-4o",
      });
    });

    it("fails loudly when the provider yields no usable client", async () => {
      await expect(
        makeCallLLM("bogus", "m", (() => ({})) as never, "k"),
      ).rejects.toThrow(/no \.chat method/);
    });

    it("falls back to the provider env var, then EVALGUARD_PROVIDER_KEY", async () => {
      const createProvider = vi.fn(() => ({ chat: async () => ({ content: "" }) }));
      const prev = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "sk-from-env";
      try {
        await makeCallLLM("openai", "gpt-4o", createProvider as never);
        expect(createProvider).toHaveBeenCalledWith("openai", "sk-from-env");
      } finally {
        if (prev === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = prev;
      }
    });
  });

  describe("discardIfAllErrored", () => {
    it("discards a scan whose every attack failed to execute", () => {
      const allErrored = {
        findings: Array.from({ length: 40 }, () => ({
          errored: true,
          passed: false,
          output: "[ERROR] callLLM is not a function",
        })),
      };
      expect(discardIfAllErrored(allErrored)).toBeNull();
    });

    it("keeps a scan with real evidence, even when some attacks errored", () => {
      const mixed = {
        findings: [
          { errored: true, passed: false, output: "[ERROR] timeout" },
          { errored: false, passed: true, output: "I can't help with that." },
        ],
      };
      expect(discardIfAllErrored(mixed)).toBe(mixed);
    });

    it("passes through a clean scan and an already-empty dry-run", () => {
      const clean = { findings: [{ errored: false, passed: true, output: "no" }] };
      expect(discardIfAllErrored(clean)).toBe(clean);
      const dry = { findings: [], passed: false, score: 0 };
      expect(discardIfAllErrored(dry)).toBe(dry);
    });
  });

  describe("end-to-end against the real core scanner + GapAnalysis", () => {
    it("a wired callLLM produces REAL evidence, not 14 fabricated not-met", async () => {
      const core = (await import("@evalguard/core")) as Record<string, any>;
      const { runSecurityScan, GapAnalysis, EU_AI_ACT } = core;

      const attackTypes = new Set<string>();
      for (const req of EU_AI_ACT.requirements) {
        if (req.automatable && req.attackTypes) {
          for (const a of req.attackTypes) attackTypes.add(a);
        }
      }

      const chat = vi.fn(async () => ({ content: "I can't help with that." }));
      const callLLM = await makeCallLLM(
        "openai",
        "gpt-4o",
        (() => ({ chat })) as never,
        "sk-test",
      );

      const scan = await runSecurityScan({
        systemPrompt: "You are a helpful assistant.",
        attackTypes: [...attackTypes],
        callLLM,
      });

      // The model was actually contacted — the whole point of the fix.
      expect(chat.mock.calls.length).toBeGreaterThan(0);
      expect(
        scan.findings.filter((f: any) => String(f.output ?? "").startsWith("[ERROR]")),
      ).toHaveLength(0);

      const report = new GapAnalysis().analyze(scan, EU_AI_ACT);
      const notMet = (report.gaps ?? []).filter((g: any) => g.status === "not-met");
      expect(notMet).toHaveLength(0);
      expect(report.overallScore).toBeGreaterThan(0);
    });

    it("an unreachable model reports UNTESTED, never fabricated non-compliance", async () => {
      const core = (await import("@evalguard/core")) as Record<string, any>;
      const { runSecurityScan, GapAnalysis, EU_AI_ACT } = core;

      const attackTypes = new Set<string>();
      for (const req of EU_AI_ACT.requirements) {
        if (req.automatable && req.attackTypes) {
          for (const a of req.attackTypes) attackTypes.add(a);
        }
      }

      const scan = await runSecurityScan({
        systemPrompt: "s",
        attackTypes: [...attackTypes],
        callLLM: async () => {
          throw new Error("callLLM is not a function");
        },
      });

      // This is exactly the object the buggy code handed to GapAnalysis.
      expect(scan.findings.length).toBeGreaterThan(0);
      const salvaged = discardIfAllErrored(scan);
      expect(salvaged).toBeNull();

      const dryRun = salvaged ?? { findings: [], passed: false, score: 0 };
      const report = new GapAnalysis().analyze(dryRun, EU_AI_ACT);
      const notMet = (report.gaps ?? []).filter((g: any) => g.status === "not-met");
      const untested = (report.gaps ?? []).filter((g: any) => g.status === "untested");

      // Before the fix this was 14 not-met. Nothing was ever tested, so nothing
      // may be reported as failing.
      expect(notMet).toHaveLength(0);
      expect(untested.length).toBeGreaterThan(0);
    });
  });
});
