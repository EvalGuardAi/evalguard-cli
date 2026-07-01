import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { ciWorkflowYaml } from "../init.js";
import { registerEvalLocal } from "../eval-local.js";

/**
 * Extract the `run:` shell command from the scaffolded GitHub Actions YAML.
 */
function extractRunCmd(yaml: string): string {
  const m = yaml.match(/run:\s+(.+)/);
  if (!m) throw new Error("no run: line in scaffolded workflow");
  return m[1]!.trim();
}

/**
 * Parse the npx run command into the evalguard subcommand + args, ignoring the
 * `npx -y @evalguard/cli` prefix.
 */
function evalguardArgs(runCmd: string): string[] {
  const parts = runCmd.split(/\s+/);
  const idx = parts.indexOf("@evalguard/cli");
  return parts.slice(idx + 1);
}

describe("ciWorkflowYaml scaffold (cli-init-ci-scaffolds-nonexistent-command)", () => {
  it("does NOT emit the non-existent `eval-local --config` command", () => {
    for (const isLocal of [true, false]) {
      const yaml = ciWorkflowYaml(isLocal);
      expect(yaml).not.toContain("eval-local");
      expect(yaml).not.toContain("--config evalguard.yaml");
    }
  });

  it("emits `eval:local evalguard.yaml` (real command name + positional file)", () => {
    const runCmd = extractRunCmd(ciWorkflowYaml(true));
    const args = evalguardArgs(runCmd);
    expect(args[0]).toBe("eval:local");
    expect(args).toContain("evalguard.yaml");
    // The positional file must NOT be behind a non-existent --config flag.
    expect(args).not.toContain("--config");
  });

  it("scaffolded command resolves against the registered command set", () => {
    const program = new Command();
    program.exitOverride();
    registerEvalLocal(program);

    const runCmd = extractRunCmd(ciWorkflowYaml(false));
    const subcommand = evalguardArgs(runCmd)[0];

    const registered = program.commands.map((c) => c.name());
    expect(registered).toContain(subcommand);
  });
});
