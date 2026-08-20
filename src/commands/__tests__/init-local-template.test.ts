/**
 * Regression: `evalguard init -t <template> --local` must honor the chosen
 * template instead of always scaffolding the local-only hello-world YAML
 * (audit: cli-init-local-ignores-template).
 *
 * ─── SUPERSEDED 2026-08-10, deliberately ────────────────────────────────────
 *
 * That earlier fix swapped WHICH flag got silently dropped rather than removing
 * the contradiction. Before it, `-t <template>` was ignored; after it, `--local`
 * was — the source comment reads "scaffold that template in local mode", but no
 * local-mode transform exists or ever existed, so the command wrote a config
 * pinned to `openai:gpt-4o-mini` and then printed local-mode next-steps over it.
 *
 * A local-mode transform was considered and does not work: forcing the built-in
 * `echo` provider onto a hosted template leaves its LLM-graded asserts
 * (`factuality`, `llm-rubric`) ungradeable. Measured on hello-world —
 * `eval --local --provider echo` → "1 passed, 2 failed", exit 1. That is not a
 * local mode, it is a red run.
 *
 * So the two flags genuinely conflict, and the command now says so (exit 2,
 * nothing written) instead of picking a winner in silence. The test below is
 * updated to that decision; the `--local` without `-t` and `--list-templates`
 * cases are unchanged and still pin the original audit's other findings.
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

  it("REFUSES `-t security-scan --local` rather than silently dropping one of the flags", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args.join(" ")));
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);

    const program = new Command();
    program.exitOverride();
    registerInit(program);
    await expect(
      program.parseAsync(["node", "evalguard", "init", "-t", "security-scan", "--local"]),
    ).rejects.toThrow("EXIT:2");

    expect(errors.join("\n")).toMatch(/--local and --template security-scan conflict/);
    // The template is NOT scaffolded — and neither is the local-only YAML.
    // Nothing is written at all, so the user's directory is untouched.
    expect(fs.existsSync(path.join(tmpDir, "evalguard.yaml"))).toBe(false);
    exitSpy.mockRestore();
  });

  it("POSITIVE CONTROL: `-t security-scan` WITHOUT --local still scaffolds that template", async () => {
    // The half of the original audit finding that still holds: naming a
    // template must produce that template, not the local-only placeholder.
    const program = new Command();
    program.exitOverride();
    registerInit(program);
    await program.parseAsync(["node", "evalguard", "init", "-t", "security-scan"]);

    const yaml = fs.readFileSync(path.join(tmpDir, "evalguard.yaml"), "utf-8");
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

  // Audit L4 (cli-init-list-templates-omits-local-only): `-t local-only` and the
  // interactive menu both accept `local-only`, so `--list-templates` must list it.
  it("`init --list-templates` includes local-only alongside the TEMPLATES", async () => {
    const logs: string[] = [];
    // console.log is already spied (silenced) in beforeEach; re-point it here so
    // we can assert on what --list-templates prints.
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });

    const program = new Command();
    program.exitOverride();
    registerInit(program);
    await program.parseAsync(["node", "evalguard", "init", "--list-templates"]);

    const out = logs.join("\n");
    expect(out).toContain("local-only");
    expect(out).toContain("No API key needed");
    // Sanity: the real templates are still listed.
    expect(out).toContain("hello-world");
    expect(out).toContain("security-scan");
  });
});
