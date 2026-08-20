import { describe, it, expect } from "vitest";
import { Command } from "commander";

/**
 * CLI Smoke Tests — verify that CLI modules are importable,
 * commands are correctly registered, and core dependencies are wired.
 */

// ---------------------------------------------------------------------------
// Module Import Tests
// ---------------------------------------------------------------------------

/* ─── IMPORT-PHASE WARM-UP: WHY THIS LINE EXISTS ──────────────────────────
 *
 * `await import()` inside a test body or hook is billed against `testTimeout`.
 * Every command module in this package reaches `@evalguard/core` LAZILY — the
 * barrel re-exports 3,594 symbols over a 2,173-file closure — so the FIRST case
 * in a file to touch it pays for transforming and evaluating that entire graph
 * on top of its own work, and every case after it reads a warm registry.
 *
 * The signature is unmistakable, measured 2026-08-13 on an idle box:
 *
 *     should import the commands module                        8082 ms
 *     should import registerEvalLocal                             0 ms
 *     should import registerScanLocal                             0 ms      …
 *
 * One case carries the whole file's cost. That fits inside a budget on an idle
 * box and does not fit under the pre-push sweep, which is why these files are
 * green 1940/1940 in isolation and red only under the sweep. Reproduced under
 * the 14-way CPU oversubscription `06e38379c` uses to stand in for it:
 *
 *     should import the commands module      30010 ms  ->  Test timed out in 30000ms
 *     should import registerEvalLocal        19067 ms  ->  passed, but inherited the stall
 *
 * — the second line being the cascade `055821495` documents: a timed-out test
 * does NOT cancel its in-flight dynamic import, so the next case on that module
 * observes a half-initialised one.
 *
 * The fix is to move the load into this file's IMPORT phase, which vitest bills
 * against no per-test budget. It must be a top-level `await import`, NOT a
 * static import: vitest hoists `vi.mock` above static imports, so a static one
 * would load the graph BEFORE this file's mocks are registered — a different
 * module than the cases are written against.
 *
 * The cases below are deliberately left alone. Several of them have `await
 * import()` as their actual SUBJECT ("should import the commands module"), so
 * rewriting them to read a hoisted binding would delete what they check. After
 * this line their `await import()` is a warm-registry lookup, which is the
 * point — the cost moved, the assertions did not.
 *
 * Sibling files in this package carry the short form of this note and point
 * back here.
 */
await import("@evalguard/core");
await import("../commands");

describe("CLI Smoke Tests -- Module Imports", () => {
  it("should import the commands module", async () => {
    const mod = await import("../commands");
    expect(mod).toBeDefined();
    expect(typeof mod.registerList).toBe("function");
  });

  it("should import registerEvalLocal", async () => {
    const mod = await import("../commands");
    expect(typeof mod.registerEvalLocal).toBe("function");
  });

  it("should import registerScanLocal", async () => {
    const mod = await import("../commands");
    expect(typeof mod.registerScanLocal).toBe("function");
  });

  it("should import registerGenerate", async () => {
    const mod = await import("../commands");
    expect(typeof mod.registerGenerate).toBe("function");
  });

  it("should import registerValidate", async () => {
    const mod = await import("../commands");
    expect(typeof mod.registerValidate).toBe("function");
  });

  it("should import registerCompare", async () => {
    const mod = await import("../commands");
    expect(typeof mod.registerCompare).toBe("function");
  });

  it("should import registerFirewall", async () => {
    const mod = await import("../commands");
    expect(typeof mod.registerFirewall).toBe("function");
  });

  it("should import registerWatch", async () => {
    const mod = await import("../commands");
    expect(typeof mod.registerWatch).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Core Dependencies
// ---------------------------------------------------------------------------

describe("CLI Core Dependencies", () => {
  it("should import @evalguard/core", async () => {
    const core = await import("@evalguard/core");
    expect(core).toBeDefined();
  });

  it("should access ALL_PLUGINS from core (canonical FEATURE_COUNTS floor)", async () => {
    const { ALL_PLUGINS, FEATURE_COUNTS } = await import("@evalguard/core");
    expect(ALL_PLUGINS.length).toBeGreaterThanOrEqual(FEATURE_COUNTS.attackPlugins);
  });

  it("should access ALL_STRATEGIES from core (canonical FEATURE_COUNTS floor)", async () => {
    const { ALL_STRATEGIES, FEATURE_COUNTS } = await import("@evalguard/core");
    expect(ALL_STRATEGIES.length).toBeGreaterThanOrEqual(FEATURE_COUNTS.redTeamStrategies);
  });

  it("should access BUILT_IN_SCORERS from core (canonical FEATURE_COUNTS floor)", async () => {
    const { BUILT_IN_SCORERS, FEATURE_COUNTS } = await import("@evalguard/core");
    expect(Object.keys(BUILT_IN_SCORERS).length).toBeGreaterThanOrEqual(FEATURE_COUNTS.scorers);
  });
});

// ---------------------------------------------------------------------------
// Command Registration (via Commander)
// ---------------------------------------------------------------------------

describe("CLI Command Registration", () => {
  it("registers all 8 Phase 6 commands on a Commander program", async () => {
    const {
      registerEvalLocal,
      registerScanLocal,
      registerGenerate,
      registerValidate,
      registerCompare,
      registerList,
      registerFirewall,
      registerWatch,
    } = await import("../commands");

    const program = new Command();
    registerEvalLocal(program);
    registerScanLocal(program);
    registerGenerate(program);
    registerValidate(program);
    registerCompare(program);
    registerList(program);
    registerFirewall(program);
    registerWatch(program);

    const commandNames = program.commands.map((c) => c.name());
    expect(commandNames).toContain("eval:local");
    expect(commandNames).toContain("scan:local");
    expect(commandNames).toContain("generate");
    expect(commandNames).toContain("validate");
    expect(commandNames).toContain("compare");
    expect(commandNames).toContain("list");
    expect(commandNames).toContain("firewall");
    expect(commandNames).toContain("watch");
  });

  it("eval:local command has a description mentioning locally", async () => {
    const { registerEvalLocal } = await import("../commands/eval-local");
    const program = new Command();
    registerEvalLocal(program);
    const cmd = program.commands.find((c) => c.name() === "eval:local");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("locally");
  });

  it("scan:local command has a description mentioning locally", async () => {
    const { registerScanLocal } = await import("../commands/scan-local");
    const program = new Command();
    registerScanLocal(program);
    const cmd = program.commands.find((c) => c.name() === "scan:local");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("locally");
  });

  it("validate command registers with correct description", async () => {
    const { registerValidate } = await import("../commands/validate");
    const program = new Command();
    registerValidate(program);
    const cmd = program.commands.find((c) => c.name() === "validate");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Validate");
  });

  it("compare command registers with correct description", async () => {
    const { registerCompare } = await import("../commands/compare");
    const program = new Command();
    registerCompare(program);
    const cmd = program.commands.find((c) => c.name() === "compare");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Compare");
  });

  it("firewall command registers with correct description", async () => {
    const { registerFirewall } = await import("../commands/firewall");
    const program = new Command();
    registerFirewall(program);
    const cmd = program.commands.find((c) => c.name() === "firewall");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("firewall");
  });

  it("watch command registers with correct description", async () => {
    const { registerWatch } = await import("../commands/watch");
    const program = new Command();
    registerWatch(program);
    const cmd = program.commands.find((c) => c.name() === "watch");
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toContain("Watch");
  });

  it("list command registers subcommands", async () => {
    const { registerList } = await import("../commands/list");
    const program = new Command();
    registerList(program);
    const listCmd = program.commands.find((c) => c.name() === "list");
    expect(listCmd).toBeDefined();

    const subcommands = listCmd!.commands.map((c) => c.name());
    expect(subcommands).toContain("scorers");
    expect(subcommands).toContain("plugins");
    expect(subcommands).toContain("strategies");
    expect(subcommands).toContain("graders");
    expect(subcommands).toContain("providers");
    expect(subcommands).toContain("attacks");
  });

  it("generate command registers subcommands", async () => {
    const { registerGenerate } = await import("../commands/generate");
    const program = new Command();
    registerGenerate(program);
    const genCmd = program.commands.find((c) => c.name() === "generate");
    expect(genCmd).toBeDefined();

    const subcommands = genCmd!.commands.map((c) => c.name());
    expect(subcommands).toContain("tests");
    expect(subcommands).toContain("assertions");
    expect(subcommands).toContain("rag");
  });
});

// ---------------------------------------------------------------------------
// Help Output Simulation
// ---------------------------------------------------------------------------

describe("CLI Help Output", () => {
  it("program name is evalguard", () => {
    const program = new Command();
    program.name("evalguard").version("0.0.1");
    expect(program.name()).toBe("evalguard");
  });

  it("program version is 0.0.1", () => {
    const program = new Command();
    program.name("evalguard").version("0.0.1");
    expect(program.version()).toBe("0.0.1");
  });

  it("help text includes all built-in commands", () => {
    const program = new Command();
    program.name("evalguard").version("0.0.1");
    program.command("login").description("Authenticate");
    program.command("logout").description("Remove credentials");
    program.command("init").description("Initialize project");
    program.command("eval").description("Run evaluation");
    program.command("scan").description("Run security scan");
    program.command("whoami").description("Show auth status");

    const helpText = program.helpInformation();
    expect(helpText).toContain("login");
    expect(helpText).toContain("logout");
    expect(helpText).toContain("init");
    expect(helpText).toContain("eval");
    expect(helpText).toContain("scan");
    expect(helpText).toContain("whoami");
  });

  it("help text includes registered Phase 6 commands", async () => {
    const {
      registerEvalLocal,
      registerScanLocal,
      registerGenerate,
      registerValidate,
      registerCompare,
      registerList,
      registerFirewall,
      registerWatch,
    } = await import("../commands");

    const program = new Command();
    program.name("evalguard").version("0.0.1");
    registerEvalLocal(program);
    registerScanLocal(program);
    registerGenerate(program);
    registerValidate(program);
    registerCompare(program);
    registerList(program);
    registerFirewall(program);
    registerWatch(program);

    const helpText = program.helpInformation();
    expect(helpText).toContain("eval:local");
    expect(helpText).toContain("scan:local");
    expect(helpText).toContain("generate");
    expect(helpText).toContain("validate");
    expect(helpText).toContain("compare");
    expect(helpText).toContain("list");
    expect(helpText).toContain("firewall");
    expect(helpText).toContain("watch");
  });
});

// ---------------------------------------------------------------------------
// Invalid Command Handling
// ---------------------------------------------------------------------------

describe("CLI Invalid Command Handling", () => {
  it("unknown command is not found in registered commands", async () => {
    const {
      registerEvalLocal,
      registerScanLocal,
      registerGenerate,
      registerValidate,
      registerCompare,
      registerList,
      registerFirewall,
      registerWatch,
    } = await import("../commands");

    const program = new Command();
    registerEvalLocal(program);
    registerScanLocal(program);
    registerGenerate(program);
    registerValidate(program);
    registerCompare(program);
    registerList(program);
    registerFirewall(program);
    registerWatch(program);

    const commandNames = program.commands.map((c) => c.name());
    expect(commandNames).not.toContain("nonexistent-command");
    expect(commandNames).not.toContain("deploy");
    expect(commandNames).not.toContain("run");
  });

  it("Commander throws for unknown subcommands via parse", () => {
    const program = new Command();
    program.name("test-cli").exitOverride();
    program.command("hello").description("Say hello");

    // Commander should throw when it encounters unknown commands
    // if exitOverride is set
    expect(() => {
      program.parse(["node", "test-cli", "nonexistent"], { from: "user" });
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Version Flag
// ---------------------------------------------------------------------------

describe("CLI Version Flag", () => {
  it("Commander outputs version when --version flag is passed", () => {
    const program = new Command();
    program.name("evalguard").version("0.0.1").exitOverride();

    let versionOutput = "";
    program.configureOutput({
      writeOut: (str: string) => {
        versionOutput = str;
      },
    });

    try {
      program.parse(["node", "evalguard", "--version"], { from: "user" });
    } catch {
      // Commander throws after outputting version with exitOverride
    }

    expect(versionOutput).toContain("0.0.1");
  });
});
