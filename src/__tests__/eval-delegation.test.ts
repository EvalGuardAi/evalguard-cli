// @vitest-environment node
//
// Regression: `evalguard eval --local` MUST forward every flag the eval:local
// sub-command understands. A real-user smoke found the documented quickstart
// `evalguard eval --local --verbose` errored with "unknown option '--verbose'"
// because `eval` delegated to `eval:local` while forwarding ONLY `--model`.
//
// `buildEvalLocalArgs` is the single source of truth for that forwarding
// contract, so these tests pin the exact argv it produces.
import { describe, expect, it } from "vitest";
import { buildEvalLocalArgs } from "../commands/eval-delegation";

describe("buildEvalLocalArgs — eval → eval:local flag forwarding", () => {
  it("always leads with the resolved config file path", () => {
    expect(buildEvalLocalArgs("cfg.yaml", {})).toEqual(["cfg.yaml"]);
  });

  it("forwards --verbose (the documented quickstart that previously errored)", () => {
    expect(buildEvalLocalArgs("cfg.yaml", { verbose: true })).toEqual([
      "cfg.yaml",
      "--verbose",
    ]);
  });

  it("does NOT emit --verbose when it is falsy", () => {
    expect(buildEvalLocalArgs("cfg.yaml", { verbose: false })).toEqual(["cfg.yaml"]);
  });

  it("forwards --provider and --model", () => {
    expect(buildEvalLocalArgs("cfg.yaml", { provider: "echo", model: "echo" })).toEqual([
      "cfg.yaml",
      "--model",
      "echo",
      "--provider",
      "echo",
    ]);
  });

  it("forwards --output", () => {
    expect(buildEvalLocalArgs("cfg.yaml", { output: "json" })).toEqual([
      "cfg.yaml",
      "--output",
      "json",
    ]);
  });

  it("forwards --no-cache only when cache was explicitly disabled", () => {
    expect(buildEvalLocalArgs("cfg.yaml", { cache: false })).toEqual([
      "cfg.yaml",
      "--no-cache",
    ]);
    // cache true / undefined → no flag (default behaviour preserved).
    expect(buildEvalLocalArgs("cfg.yaml", { cache: true })).toEqual(["cfg.yaml"]);
    expect(buildEvalLocalArgs("cfg.yaml", {})).toEqual(["cfg.yaml"]);
  });

  it("forwards all flags together in a stable order", () => {
    expect(
      buildEvalLocalArgs("cfg.yaml", {
        model: "echo",
        provider: "echo",
        output: "json",
        verbose: true,
        cache: false,
      }),
    ).toEqual([
      "cfg.yaml",
      "--model",
      "echo",
      "--provider",
      "echo",
      "--output",
      "json",
      "--verbose",
      "--no-cache",
    ]);
  });

  it("every forwarded flag is one eval:local actually declares", async () => {
    // Guard against drift: if eval:local drops/renames an option we'd forward a
    // flag it no longer accepts and re-introduce the "unknown option" failure.
    const { Command } = await import("commander");
    const { registerEvalLocal } = await import("../commands/eval-local");
    const program = new Command();
    registerEvalLocal(program);
    const evalLocal = program.commands.find((c) => c.name() === "eval:local")!;
    const declared = new Set(
      evalLocal.options.flatMap((o) => [o.long, o.short].filter(Boolean) as string[]),
    );
    // The maximal arg set, minus the leading file path and option VALUES.
    const args = buildEvalLocalArgs("cfg.yaml", {
      model: "m",
      provider: "p",
      output: "json",
      verbose: true,
      cache: false,
    });
    const flags = args.filter((a) => a.startsWith("--"));
    for (const f of flags) {
      expect(declared.has(f)).toBe(true);
    }
  });
});
