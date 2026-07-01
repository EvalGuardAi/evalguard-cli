import { describe, it, expect } from "vitest";
import { normalizeScanConfig } from "../scan-local.js";

/* Regression for the `evalguard scan:local` crash (live-E2E 2026-06-21):
 * a config that `evalguard validate` accepts but puts model under `target`
 * (instead of a top-level `model`) left config.model undefined, and
 * detectProvider(undefined).startsWith(...) threw
 * "Cannot read properties of undefined (reading 'startsWith')" during config
 * load. normalizeScanConfig now reconciles the nested target / redteam shapes
 * into the flat fields and fails closed with a clear message when no model
 * resolves. We test the pure normalizer directly (the .action() wrapper calls
 * process.exit, which would hijack the test runner). */
describe("normalizeScanConfig — nested/flat schema reconciliation", () => {
  it("resolves model + provider from nested target.* (the crash repro)", () => {
    const cfg: any = {
      prompt: "p",
      target: { provider: "openai", model: "gpt-4o-mini" },
      redteam: { plugins: ["prompt-injection"], strategies: ["base64"] },
    };
    const { model, providerName } = normalizeScanConfig(cfg, {});
    expect(model).toBe("gpt-4o-mini");
    expect(providerName).toBe("openai");
    // nested redteam.* lifted to flat fields the scanner reads
    expect(cfg.plugins).toEqual(["prompt-injection"]);
    expect(cfg.strategies).toEqual(["base64"]);
  });

  it("still supports the flat shape", () => {
    const cfg: any = { prompt: "p", model: "claude-3-5-sonnet", plugins: ["jailbreak"] };
    const { model, providerName } = normalizeScanConfig(cfg, {});
    expect(model).toBe("claude-3-5-sonnet");
    expect(providerName).toBe("anthropic"); // detected from model prefix
  });

  it("--model / --provider opts win over config", () => {
    const cfg: any = { prompt: "p", target: { model: "gpt-4o-mini", provider: "openai" } };
    const { model, providerName } = normalizeScanConfig(cfg, { model: "gemini-1.5-pro", provider: "gemini" });
    expect(model).toBe("gemini-1.5-pro");
    expect(providerName).toBe("gemini");
  });

  it("infers provider from model when none specified", () => {
    expect(normalizeScanConfig({ prompt: "p", model: "deepseek-chat" } as any).providerName).toBe("deepseek");
    expect(normalizeScanConfig({ prompt: "p", model: "llama-3.1-70b" } as any).providerName).toBe("groq");
  });

  it("fails closed with a clear message when NO model resolves (no crash)", () => {
    const cfg: any = { prompt: "p", redteam: { plugins: ["prompt-injection"] } }; // no model anywhere
    expect(() => normalizeScanConfig(cfg, {})).toThrowError(/No model specified.*--model/);
  });

  it("maps redteam.numTests → maxConcurrency fallback", () => {
    const cfg: any = { prompt: "p", model: "gpt-4o-mini", redteam: { numTests: 5 } };
    normalizeScanConfig(cfg, {});
    expect(cfg.maxConcurrency).toBe(5);
  });
});
