/**
 * Regression: `evalguard init -t <template> --local` must honor the chosen
 * template instead of always scaffolding the local-only hello-world YAML
 * (audit: cli-init-local-ignores-template).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { registerInit } from "../init.js";

describe("init --local honors --template (cli-init-local-ignores-template)", () => {
  let tmpDir: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eg-init-"));
    process.chdir(tmpDir);
    // Silence the command's banner / next-steps output.
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("scaffolds the security-scan template (redteam.plugins) when -t is passed with --local", async () => {
    const program = new Command();
    program.exitOverride();
    registerInit(program);
    await program.parseAsync(["node", "evalguard", "init", "-t", "security-scan", "--local"]);

    const yaml = fs.readFileSync(path.join(tmpDir, "evalguard.yaml"), "utf-8");
    // The security-scan template — NOT the local-only placeholder.
    expect(yaml).toContain("redteam:");
    expect(yaml).toContain("prompt-injection");
    expect(yaml).not.toContain("Local evaluation with built-in scorers");
  });

  it("still scaffolds the local-only YAML when --local is used without -t", async () => {
    const program = new Command();
    program.exitOverride();
    registerInit(program);
    await program.parseAsync(["node", "evalguard", "init", "--local"]);

    const yaml = fs.readFileSync(path.join(tmpDir, "evalguard.yaml"), "utf-8");
    expect(yaml).toContain("Local evaluation with built-in scorers");
    expect(yaml).not.toContain("redteam:");
  });
});
