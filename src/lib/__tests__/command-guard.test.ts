/**
 * `evalguard <unknown> --help` used to exit 0.
 *
 * Measured on the built CLI before the fix (Node 24):
 *   evalguard definitely-not-a-command          → error: unknown command …  EXIT 1
 *   evalguard definitely-not-a-command --help   → <root help>               EXIT 0
 *
 * Commander resolves `--help` on the ROOT command during option parsing, prints
 * the root help and exits 0 before it ever reaches the unknown-subcommand
 * branch — so a typo'd step in a CI pipeline passes silently and is skipped.
 */
import { describe, it, expect } from "vitest";
import {
  ROOT_VALUE_OPTIONS,
  checkCommandPath,
  checkTopLevelCommand,
  firstPositional,
  suggestCommand,
  type CommandNode,
} from "../command-guard.js";

const KNOWN = ["runs", "scans", "eval", "eval:local", "scan", "login", "whoami", "list"];

/** Shorthand for a leaf command that takes N positional arguments. */
function leaf(name: string, opts: Partial<CommandNode> = {}): CommandNode {
  return {
    name,
    aliases: [],
    subcommands: [],
    valueOptions: [],
    takesPositionalArgs: false,
    ...opts,
  };
}

/**
 * A miniature of the SHIPPED program: the `benchmark` group as registered in
 * commands/benchmark.ts (list · run <suite> · info <suite> · agent-suites), the
 * `siem` → `tokens` → … nesting, and a top-level leaf that takes an argument.
 */
const ROOT: CommandNode = {
  name: "evalguard",
  aliases: [],
  valueOptions: ROOT_VALUE_OPTIONS,
  takesPositionalArgs: false,
  subcommands: [
    {
      ...leaf("benchmark"),
      subcommands: [
        leaf("list"),
        leaf("run", { valueOptions: ["-m", "--model", "-s", "--sample"], takesPositionalArgs: true }),
        leaf("info", { takesPositionalArgs: true }),
        leaf("agent-suites"),
      ],
    },
    {
      ...leaf("siem"),
      subcommands: [
        { ...leaf("tokens"), subcommands: [leaf("list"), leaf("revoke", { takesPositionalArgs: true })] },
      ],
    },
    leaf("whoami"),
    leaf("scan", { takesPositionalArgs: true, aliases: ["sc"] }),
  ],
};

describe("firstPositional", () => {
  it("finds a plain command", () => {
    expect(firstPositional(["runs", "--project", "p1"])).toBe("runs");
  });

  it("skips root flags", () => {
    expect(firstPositional(["--help"])).toBeNull();
    expect(firstPositional(["-V"])).toBeNull();
    expect(firstPositional([])).toBeNull();
  });

  it("does not mistake a value-taking option's VALUE for a command", () => {
    // `--profile self-hosted runs` — `self-hosted` is the profile name.
    expect(firstPositional(["--profile", "self-hosted", "runs"])).toBe("runs");
    expect(firstPositional(["--profile", "self-hosted"])).toBeNull();
  });

  it("handles the inline --profile=name form", () => {
    expect(firstPositional(["--profile=self-hosted", "runs"])).toBe("runs");
  });

  it("stops at the -- separator", () => {
    expect(firstPositional(["--", "runs"])).toBeNull();
  });

  it("ROOT_VALUE_OPTIONS is not empty — an empty list would silently disable the skip", () => {
    expect(ROOT_VALUE_OPTIONS.length).toBeGreaterThan(0);
    expect(ROOT_VALUE_OPTIONS).toContain("--profile");
  });
});

describe("suggestCommand", () => {
  it("suggests the obvious typo", () => {
    expect(suggestCommand("runz", KNOWN)).toBe("runs");
    expect(suggestCommand("scna", KNOWN)).toBe("scan");
  });

  it("stays quiet when nothing is close", () => {
    expect(suggestCommand("definitely-not-a-command", KNOWN)).toBeNull();
  });
});

describe("checkTopLevelCommand", () => {
  it("REJECTS an unknown command even when --help is present (the defect)", () => {
    expect(checkTopLevelCommand(["definitely-not-a-command", "--help"], KNOWN)).toEqual({
      unknown: "definitely-not-a-command",
      suggestion: null,
    });
    expect(checkTopLevelCommand(["runz", "--help"], KNOWN)).toEqual({
      unknown: "runz",
      suggestion: "runs",
    });
  });

  it("rejects an unknown command behind a root option", () => {
    expect(checkTopLevelCommand(["--profile", "prod", "runz"], KNOWN)?.unknown).toBe("runz");
  });

  // ── CONTROLS: must pass both before and after the fix ──
  it("allows a known command, with or without --help", () => {
    expect(checkTopLevelCommand(["runs"], KNOWN)).toBeNull();
    expect(checkTopLevelCommand(["runs", "--help"], KNOWN)).toBeNull();
    expect(checkTopLevelCommand(["eval:local", "x.yaml"], KNOWN)).toBeNull();
  });

  it("allows commander's built-in help command and bare help flags", () => {
    expect(checkTopLevelCommand(["help"], KNOWN)).toBeNull();
    expect(checkTopLevelCommand(["help", "runs"], KNOWN)).toBeNull();
    expect(checkTopLevelCommand(["--help"], KNOWN)).toBeNull();
    expect(checkTopLevelCommand([], KNOWN)).toBeNull();
  });

  // The defect this section pins: the guard above only ever reads the FIRST
  // positional, so the very bug it was written for survived one level down.
  it("does NOT see an unknown SUBCOMMAND — the gap checkCommandPath closes", () => {
    // `benchmark` IS a known top-level command, so this returns null and the
    // argv goes on to Commander, which prints the benchmark help and exits 0.
    expect(checkTopLevelCommand(["benchmark", "bogus-suite", "--help"], ["benchmark"])).toBeNull();
  });
});

describe("checkCommandPath — unknown SUBCOMMAND at any depth", () => {
  it("REJECTS an unrecognised benchmark name even with --help (the defect)", () => {
    // Measured on dist/index.js before the fix:
    //   evalguard benchmark bogus-suite          → error: unknown command   EXIT 1
    //   evalguard benchmark bogus-suite --help   → <benchmark help>         EXIT 0
    expect(checkCommandPath(["benchmark", "bogus-suite", "--help"], ROOT)).toEqual({
      unknown: "bogus-suite",
      path: ["benchmark"],
      suggestion: null,
    });
  });

  it("rejects it without --help too, and offers a suggestion for a typo", () => {
    expect(checkCommandPath(["benchmark", "bogus-suite"], ROOT)?.unknown).toBe("bogus-suite");
    expect(checkCommandPath(["benchmark", "lst", "--help"], ROOT)).toEqual({
      unknown: "lst",
      path: ["benchmark"],
      suggestion: "list",
    });
  });

  it("rejects at THREE levels deep", () => {
    expect(checkCommandPath(["siem", "tokens", "bogus", "--help"], ROOT)).toEqual({
      unknown: "bogus",
      path: ["siem", "tokens"],
      suggestion: null,
    });
  });

  it("rejects an unknown subcommand behind a root option", () => {
    expect(checkCommandPath(["--profile", "prod", "benchmark", "nope"], ROOT)?.unknown).toBe("nope");
  });

  // ── CONTROLS: must pass BOTH before and after the fix ──
  it("does not mistake a leaf command's ARGUMENT for a subcommand", () => {
    // `run` has no subcommands, so `<suite>` is an argument — benchmark.ts
    // validates it itself and already exits 1 for an unknown one. Flagging it
    // here would double-report, and would break `info <suite>` the same way.
    expect(checkCommandPath(["benchmark", "run", "mmlu", "--model", "gpt-4o-mini"], ROOT)).toBeNull();
    expect(checkCommandPath(["benchmark", "info", "definitely-not-real"], ROOT)).toBeNull();
    expect(checkCommandPath(["scan", "evalguard.yaml"], ROOT)).toBeNull();
  });

  it("does not mistake a value-taking option's VALUE for a subcommand", () => {
    // `--model list` — `list` is the model name, and it also happens to be a
    // sibling subcommand name. Consuming option values keeps them apart.
    expect(checkCommandPath(["benchmark", "run", "mmlu", "--model", "list"], ROOT)).toBeNull();
    expect(checkCommandPath(["--profile", "benchmark", "whoami"], ROOT)).toBeNull();
  });

  it("allows every real command path, with and without --help", () => {
    expect(checkCommandPath(["benchmark"], ROOT)).toBeNull();
    expect(checkCommandPath(["benchmark", "--help"], ROOT)).toBeNull();
    expect(checkCommandPath(["benchmark", "list", "--json"], ROOT)).toBeNull();
    expect(checkCommandPath(["benchmark", "agent-suites"], ROOT)).toBeNull();
    expect(checkCommandPath(["siem", "tokens", "list"], ROOT)).toBeNull();
    expect(checkCommandPath(["whoami"], ROOT)).toBeNull();
    expect(checkCommandPath(["sc", "evalguard.yaml"], ROOT)).toBeNull(); // alias
    expect(checkCommandPath([], ROOT)).toBeNull();
    expect(checkCommandPath(["--help"], ROOT)).toBeNull();
  });

  it("allows commander's built-in help at every level, and stops at --", () => {
    expect(checkCommandPath(["help"], ROOT)).toBeNull();
    expect(checkCommandPath(["benchmark", "help"], ROOT)).toBeNull();
    expect(checkCommandPath(["help", "benchmark"], ROOT)).toBeNull();
    expect(checkCommandPath(["--", "benchmark", "bogus"], ROOT)).toBeNull();
  });
});
