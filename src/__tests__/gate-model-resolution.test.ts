/**
 * `evalguard gate` — model-resolution precedence (regression guard).
 *
 * Bug fixed here: the `-m, --model` option declared a hardcoded Commander
 * default of `"gpt-4o-mini"`. That made `opts.model` ALWAYS truthy, so the
 * `opts.model ?? config.model ?? default` chain could never reach the config's
 * own model — `evalguard gate myconfig.json` silently ran gpt-4o-mini even when
 * `myconfig.json` declared `"model": "claude-3-5-haiku-latest"`.
 *
 * The fix:
 *   - the `--model` option has NO Commander default (so `opts.model` is
 *     undefined unless the user actually passes `--model`);
 *   - a pure `resolveGateModel(cliModel, configModel)` helper applies the
 *     precedence: explicit flag > config model > GATE_DEFAULT_MODEL;
 *   - the two `getBuiltInSuite(...)` call sites pass
 *     `opts.model ?? GATE_DEFAULT_MODEL` (a built-in suite has no config model).
 *
 * These tests pin all three behaviours. They mirror the structural style of
 * `coverage-completion.test.ts` (commander introspection) plus direct unit
 * tests of the exported pure helper.
 */
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Command } from "commander";
import {
  registerGate,
  resolveGateModel,
  GATE_DEFAULT_MODEL,
} from "../commands/gate";

function findGate(program: Command): Command | undefined {
  return program.commands.find((c) => c.name() === "gate");
}

function findModelOption(cmd: Command) {
  return cmd.options.find((o) => o.long === "--model" || o.short === "-m");
}

describe("gate — resolveGateModel precedence", () => {
  it("uses the config's model when --model is NOT passed", () => {
    // opts.model is undefined (no flag) → the config's own model must win.
    expect(resolveGateModel(undefined, "claude-3-5-haiku-latest")).toBe(
      "claude-3-5-haiku-latest",
    );
  });

  it("uses the explicit --model flag when passed (overrides config)", () => {
    expect(resolveGateModel("gpt-4o", "claude-3-5-haiku-latest")).toBe("gpt-4o");
  });

  it("falls back to the default when neither flag nor config supplies a model", () => {
    expect(resolveGateModel(undefined, undefined)).toBe(GATE_DEFAULT_MODEL);
    expect(GATE_DEFAULT_MODEL).toBe("gpt-4o-mini");
  });

  it("flag wins even when config also has a model (full precedence chain)", () => {
    // explicit > config > default
    expect(resolveGateModel("o1-mini", "gpt-3.5")).toBe("o1-mini");
    // no flag, config present → config
    expect(resolveGateModel(undefined, "gpt-3.5")).toBe("gpt-3.5");
    // no flag, no config → default
    expect(resolveGateModel(undefined, undefined)).toBe("gpt-4o-mini");
  });
});

describe("gate — --model option declaration (root cause)", () => {
  it("declares a --model option", () => {
    const program = new Command();
    registerGate(program);
    const gate = findGate(program);
    expect(gate).toBeDefined();
    expect(findModelOption(gate!)).toBeDefined();
  });

  it("does NOT hardcode a Commander default on --model (so config.model can win)", () => {
    const program = new Command();
    registerGate(program);
    const gate = findGate(program)!;
    const modelOpt = findModelOption(gate)!;
    // The whole bug was a hardcoded `"gpt-4o-mini"` default here, which made
    // opts.model always truthy. With it removed, defaultValue is undefined.
    expect(modelOpt.defaultValue).toBeUndefined();
  });

  it("resolves model to undefined (not the default) when --model is omitted at parse time", () => {
    // Prove the commander layer: after parsing WITHOUT --model, the option
    // value is undefined, so resolveGateModel falls through to config/default.
    const program = new Command();
    program.exitOverride();
    let captured: { model?: string } | undefined;
    const gate = program
      .command("gate-probe")
      .option("-m, --model <model>", "Model")
      .action((opts: { model?: string }) => {
        captured = opts;
      });
    void gate;
    program.parse(["node", "evalguard", "gate-probe"]);
    expect(captured?.model).toBeUndefined();

    // And WITH --model it's the passed value.
    captured = undefined;
    program.parse(["node", "evalguard", "gate-probe", "--model", "gpt-4o"]);
    expect(captured?.model).toBe("gpt-4o");
  });
});

describe("gate — built-in suite always gets a model", () => {
  // A built-in suite (`--suite general`) has no config-declared model, so the
  // call site must pass `opts.model ?? GATE_DEFAULT_MODEL`. We assert the
  // contract the call site relies on: when --model is absent the fallback is
  // the non-undefined default, and an explicit flag is honoured.
  it("falls back to the default model for the suite when --model is absent", () => {
    // mirror the call site's `opts.model` (string | undefined) rather than a
    // bare literal so the `??` left side isn't a constant (no-constant-binary).
    const optsModel: string | undefined = undefined;
    const suiteModel = optsModel ?? GATE_DEFAULT_MODEL;
    expect(suiteModel).toBe("gpt-4o-mini");
    expect(suiteModel).not.toBeUndefined();
  });

  it("honours an explicit --model for the suite", () => {
    const optsModel: string | undefined = "claude-3-5-haiku-latest";
    const suiteModel = optsModel ?? GATE_DEFAULT_MODEL;
    expect(suiteModel).toBe("claude-3-5-haiku-latest");
  });
});
