import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { validateGateConfig, resolveGateConfigPath, registerGate } from "../gate.js";

const VALID = {
  name: "suite",
  prompt: "Answer: {{input}}",
  scorers: ["contains"],
  cases: [{ input: "2+2?", expectedOutput: "4" }],
};

describe("validateGateConfig (cli-gate-missing-config-validation, cli-gate-strict-empty-bypass)", () => {
  it("accepts a well-formed config", () => {
    const r = validateGateConfig(VALID);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.cases).toHaveLength(1);
  });

  it("rejects an empty cases array (the strict-empty gate bypass)", () => {
    const r = validateGateConfig({ ...VALID, cases: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no test cases|zero coverage/i);
  });

  it("rejects a missing cases field", () => {
    const { cases, ...noCases } = VALID;
    void cases;
    const r = validateGateConfig(noCases);
    expect(r.ok).toBe(false);
  });

  it("rejects a missing/empty prompt before dereference (no opaque crash)", () => {
    expect(validateGateConfig({ ...VALID, prompt: "" }).ok).toBe(false);
    const { prompt, ...noPrompt } = VALID;
    void prompt;
    expect(validateGateConfig(noPrompt).ok).toBe(false);
  });

  it("rejects an empty scorers array", () => {
    expect(validateGateConfig({ ...VALID, scorers: [] }).ok).toBe(false);
  });

  it("rejects non-object / null configs instead of crashing", () => {
    expect(validateGateConfig(null).ok).toBe(false);
    expect(validateGateConfig("nope").ok).toBe(false);
    expect(validateGateConfig(42).ok).toBe(false);
  });
});

describe("resolveGateConfigPath (positional [config] alias for --config)", () => {
  it("uses the positional when only the positional is given", () => {
    expect(resolveGateConfigPath("cfg.json", undefined)).toBe("cfg.json");
  });

  it("uses the flag when only the flag is given", () => {
    expect(resolveGateConfigPath(undefined, "cfg.json")).toBe("cfg.json");
  });

  it("lets --config win when BOTH are given (flag is authoritative)", () => {
    expect(resolveGateConfigPath("positional.json", "flag.json")).toBe("flag.json");
  });

  it("returns undefined when neither is given (suite / auto-discovery fallback)", () => {
    expect(resolveGateConfigPath(undefined, undefined)).toBeUndefined();
  });
});

describe("gate command accepts a positional [config] (no 'too many arguments')", () => {
  // Regression (real-user smoke): the docs show `evalguard gate <config>` but the
  // command only declared `-c/--config`, so Commander rejected the positional
  // with "error: too many arguments for 'gate'". The real action does heavy I/O,
  // so we re-register a capturing `.action()` AFTER registerGate to assert the
  // ARGUMENT-PARSING layer in isolation: the positional + flag must both parse
  // (no excess-argument error) and surface the resolved config path.
  function buildGateProgram() {
    const program = new Command();
    program.exitOverride(); // throw (don't process.exit) on any parse error
    registerGate(program);
    const gate = program.commands.find((c) => c.name() === "gate")!;
    let captured: { configArg?: string; opts: Record<string, unknown> } | undefined;
    // Override the action with a capture. The signature mirrors the real one:
    // (positionalConfig, opts, command).
    gate.action((configArg: string | undefined, opts: Record<string, unknown>) => {
      captured = { configArg, opts };
    });
    return { program, getCaptured: () => captured };
  }

  it("parses `gate cfg.json --threshold 1.0` (positional) without error", async () => {
    const { program, getCaptured } = buildGateProgram();
    await program.parseAsync(["node", "evalguard", "gate", "cfg.json", "--threshold", "1.0"]);
    const cap = getCaptured();
    expect(cap?.configArg).toBe("cfg.json");
    expect(cap?.opts.threshold).toBe("1.0");
    // The resolved path (positional, no --config) must equal the positional.
    expect(resolveGateConfigPath(cap?.configArg, cap?.opts.config as string | undefined)).toBe("cfg.json");
  });

  it("parses `gate --config cfg.json` (flag form) without error", async () => {
    const { program, getCaptured } = buildGateProgram();
    await program.parseAsync(["node", "evalguard", "gate", "--config", "cfg.json", "--threshold", "0.9"]);
    const cap = getCaptured();
    expect(cap?.opts.config).toBe("cfg.json");
    expect(resolveGateConfigPath(cap?.configArg, cap?.opts.config as string | undefined)).toBe("cfg.json");
  });
});
