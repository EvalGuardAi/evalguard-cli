/**
 * Regression: `evalguard validate` must accept the `init -t security-scan`
 * template, whose plugins live under `redteam.plugins` (not a top-level
 * `attackTypes`/`plugins`). Before the fix the nested shape was misclassified
 * (rejected as an eval missing scorers/cases) — its own scaffold output failed
 * validation (audit: cli-validate-rejects-redteam-template).
 *
 * `fs` is mocked here (rather than touching a temp dir) so the test is immune
 * to the global `vi.mock("node:fs")` other suites install.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import * as fs from "fs";
import { registerValidate } from "../validate.js";

vi.mock("fs");

describe("validate accepts redteam.plugins scan configs (cli-validate-rejects-redteam-template)", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) =>
      undefined as never) as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function output(): string {
    return logSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
  }

  async function runValidate(yaml: string): Promise<void> {
    vi.mocked(fs.readFileSync).mockReturnValue(yaml as never);
    const program = new Command();
    program.exitOverride();
    registerValidate(program);
    // `.yaml` extension makes validate parse it as YAML.
    await program.parseAsync(["node", "evalguard", "validate", "evalguard.yaml"]);
  }

  // `validate` dynamically `import()`s @evalguard/core; under the full
  // parallel suite that first-load can exceed the 5s default.
  it("accepts the security-scan template (redteam.plugins) as a valid scan", { timeout: 30_000 }, async () => {
    await runValidate(
      [
        "description: Security scan for prompt injection",
        "prompts:",
        "  - file: prompts/system.txt",
        "redteam:",
        "  plugins:",
        "    - prompt-injection",
        "    - pii-leak",
        "  strategies:",
        "    - base64",
        "  numTests: 20",
        "",
      ].join("\n"),
    );

    expect(output()).toContain("valid (scan)");
    // It must NOT be misclassified as an eval (no "Missing 'scorers'" error).
    expect(output()).not.toContain("Missing 'scorers'");
    expect(output()).not.toContain("Missing 'cases'");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("reports an unknown plugin inside redteam.plugins as a scan error", { timeout: 30_000 }, async () => {
    await runValidate(
      [
        "prompts:",
        "  - file: prompts/system.txt",
        "redteam:",
        "  plugins:",
        "    - definitely-not-a-real-plugin",
        "",
      ].join("\n"),
    );

    expect(output()).toContain("Unknown plugin");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
