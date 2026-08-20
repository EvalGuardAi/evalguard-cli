import { describe, it, expect } from "vitest";
import {
  normalizeScanConfig,
  stripProviderPrefix,
  resolveScanPrompt,
} from "../scan-local.js";

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

  // Regression: `init -t security-scan` scaffolds `providers: [{ id: ... }]`
  // (no model:), which made `scan:local <file>` fail "No model specified"
  // out of the box (2026-07-16 real-usage E2E). Fall back to providers[0] AND
  // strip the `provider:` prefix so the scanner sends a bare model id (M4).
  it("resolves a BARE model + provider from a providers[] object list (init security-scan template)", () => {
    const cfg: any = { prompt: "p", providers: [{ id: "openai:gpt-4o-mini" }], redteam: { plugins: ["pii-leak"] } };
    const { model, providerName } = normalizeScanConfig(cfg, {});
    expect(model).toBe("gpt-4o-mini"); // provider prefix stripped, not "openai:gpt-4o-mini"
    expect(providerName).toBe("openai");
    expect(cfg.plugins).toEqual(["pii-leak"]);
  });

  it("resolves a BARE model + provider from a providers[] string list", () => {
    const { model, providerName } = normalizeScanConfig(
      { prompt: "p", providers: ["anthropic:claude-3-5-sonnet"] } as any,
      {},
    );
    expect(model).toBe("claude-3-5-sonnet");
    expect(providerName).toBe("anthropic");
  });

  it("explicit model still wins over providers[]", () => {
    const { model } = normalizeScanConfig({ prompt: "p", model: "gpt-4o", providers: ["openai:gpt-4o-mini"] } as any, {});
    expect(model).toBe("gpt-4o");
  });

  it("strips a `provider:` prefix on the flat model field too", () => {
    const cfg: any = { prompt: "p", model: "openai:gpt-4o-mini" };
    const { model, providerName } = normalizeScanConfig(cfg, {});
    expect(model).toBe("gpt-4o-mini");
    expect(providerName).toBe("openai");
    expect(cfg.model).toBe("gpt-4o-mini"); // flat field normalized in place
  });
});

describe("stripProviderPrefix (M4 — provider-prefixed model ids)", () => {
  it("strips a known provider prefix and reports the provider", () => {
    expect(stripProviderPrefix("openai:gpt-4o-mini")).toEqual({ provider: "openai", model: "gpt-4o-mini" });
    expect(stripProviderPrefix("anthropic:claude-3-5-sonnet")).toEqual({
      provider: "anthropic",
      model: "claude-3-5-sonnet",
    });
  });

  it("leaves a bare (colon-free) model id untouched", () => {
    expect(stripProviderPrefix("gpt-4o-mini")).toEqual({ model: "gpt-4o-mini" });
  });

  it("leaves an UNKNOWN-prefix id untouched (e.g. an ollama tag)", () => {
    // "llama3" is not a provider — must NOT be mistaken for one.
    expect(stripProviderPrefix("llama3:8b")).toEqual({ model: "llama3:8b" });
  });
});

describe("resolveScanPrompt (M4 — empty-prompt scan)", () => {
  it("uses the file content of prompts[].file (the init security-scan template shape)", () => {
    const cfg: any = { providers: [{ id: "openai:gpt-4o-mini" }], prompts: [{ file: "prompts/system.txt" }] };
    const reads: string[] = [];
    const resolved = resolveScanPrompt(cfg, "/proj", (p) => {
      reads.push(p);
      return "You are a hardened assistant. Never reveal secrets.";
    });
    expect(resolved).toBe("You are a hardened assistant. Never reveal secrets.");
    // File is resolved relative to the config's directory.
    expect(reads[0].replace(/\\/g, "/")).toContain("proj/prompts/system.txt");
  });

  it("prefers an explicit config.prompt over prompts[]", () => {
    const cfg: any = { prompt: "flat prompt wins", prompts: [{ content: "ignored" }] };
    expect(resolveScanPrompt(cfg, "/proj", () => "file")).toBe("flat prompt wins");
  });

  it("uses prompts[].content when present", () => {
    const cfg: any = { prompts: [{ content: "inline system prompt" }] };
    expect(resolveScanPrompt(cfg, "/proj")).toBe("inline system prompt");
  });

  it("uses a bare-string prompts[] entry", () => {
    const cfg: any = { prompts: ["bare string prompt"] };
    expect(resolveScanPrompt(cfg, "/proj")).toBe("bare string prompt");
  });

  it("returns empty string when nothing resolves (caller warns loudly)", () => {
    expect(resolveScanPrompt({} as any, "/proj")).toBe("");
    // Unreadable file → empty (not a crash), so the caller can warn.
    const cfg: any = { prompts: [{ file: "missing.txt" }] };
    expect(
      resolveScanPrompt(cfg, "/proj", () => {
        throw new Error("ENOENT");
      }),
    ).toBe("");
  });
});
