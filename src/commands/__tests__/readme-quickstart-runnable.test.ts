/**
 * Regression: the published README's Quick Start must actually run.
 *
 * The block used to open with `evalguard init --local` and then tell the reader
 * to run `evalguard eval evals/example.json --wait` and
 * `evalguard scan scans/example.json --wait` — two paths `init` has never
 * created. Copy-pasting the project's own quickstart into an empty directory
 * produced `File not found: …/evals/example.json` (exit 1) on the very first
 * eval, while the Commands table two screens further down described `init`'s
 * real output (`evalguard.yaml`, `tests/hello-world.yaml`, `prompts/system.txt`)
 * correctly. The quickstart predated the local-first `init`.
 *
 * These tests pin the doc/code agreement at both ends:
 *   1. every concrete file path the Quick Start commands reference must exist
 *      after a real `init --local` into a scratch directory;
 *   2. the local-eval command the Quick Start shows must be the same one the
 *      CLI itself prints under "Next steps", so the two surfaces cannot drift
 *      apart again.
 *
 * Nothing here keys off line numbers — the section is located by its heading and
 * the commands by the fences inside it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { registerInit } from "../init.js";

// This test lives in apps/cli/src/commands/__tests__ — the package README is
// three directories up.
const PKG_ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");
const README = path.join(PKG_ROOT, "README.md");

/**
 * The body of the `## Quick Start` section: everything between that heading and
 * the next top-level (`## `) heading. Sub-headings (`### `) stay inside.
 */
function quickStartSection(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+Quick Start\s*$/.test(l));
  if (start === -1) throw new Error("README has no `## Quick Start` heading");
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s+\S/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** Every line inside a fenced code block in `section`. */
function fencedLines(section: string): string[] {
  const out: string[] = [];
  let inFence = false;
  for (const line of section.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) out.push(line);
  }
  if (inFence) throw new Error("unterminated code fence in the Quick Start section");
  return out;
}

/**
 * File paths referenced by the *commands* in the Quick Start (comment lines are
 * prose, not something a reader executes).
 *
 * A token counts as a concrete path when it ends in a config/prompt extension.
 * Tokens carrying `<`, `>` or `...` are explicit placeholders the reader is told
 * to substitute (`<your-eval>.json`) and are deliberately not asserted to exist.
 */
function referencedPaths(section: string): string[] {
  const found = new Set<string>();
  for (const raw of fencedLines(section)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    // Quoted arguments are prose payloads (firewall probe text), never paths.
    const stripped = line.replace(/"[^"]*"/g, " ").replace(/'[^']*'/g, " ");
    for (const token of stripped.split(/\s+/)) {
      if (token.startsWith("-")) continue;
      if (/[<>]/.test(token) || token.includes("...")) continue;
      if (/^[A-Za-z0-9._\-\\/]+\.(json|ya?ml|txt)$/.test(token)) found.add(token);
    }
  }
  return [...found];
}

/** chalk emits no codes without a TTY, but never depend on that. */
// eslint-disable-next-line no-control-regex
const ANSI = new RegExp("\\u001b\\[[0-9;]*m", "g");

describe("README Quick Start is runnable end to end (cli-readme-quickstart-references-nonexistent-files)", () => {
  let tmpDir: string;
  let prevCwd: string;
  let logs: string[];

  beforeEach(() => {
    prevCwd = process.cwd();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eg-readme-qs-"));
    process.chdir(tmpDir);
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" ").replace(ANSI, ""));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function runInitLocal(): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerInit(program);
    await program.parseAsync(["node", "evalguard", "init", "--local"]);
  }

  it("every file path the quickstart commands reference is created by `init --local`", async () => {
    const section = quickStartSection(fs.readFileSync(README, "utf-8"));

    // The block must still bootstrap itself, and must still reference something —
    // otherwise this test could pass by extracting nothing at all.
    expect(fencedLines(section).some((l) => /^\s*evalguard\s+init\b.*--local\b/.test(l))).toBe(true);
    const referenced = referencedPaths(section);
    expect(referenced.length).toBeGreaterThan(0);
    expect(referenced).toContain("evalguard.yaml");

    await runInitLocal();

    const missing = referenced.filter(
      (p) => !fs.existsSync(path.join(tmpDir, ...p.split(/[\\/]/))),
    );
    expect(missing).toEqual([]);
  });

  it("the quickstart's local-eval command is the one `init --local` prints as the next step", async () => {
    await runInitLocal();

    const nextStep = logs
      .map((l) => l.match(/Run your first eval:\s*(.+?)\s*$/))
      .find((m): m is RegExpMatchArray => m !== null);
    expect(
      nextStep,
      "`init --local` no longer prints a 'Run your first eval:' next step",
    ).toBeTruthy();

    // The CLI suggests `npx @evalguard/cli …`; the README documents the globally
    // installed `evalguard …`. Compare the subcommand + flags, not the launcher.
    //
    // SEC-053: the CLI deliberately prints the SCOPE-QUALIFIED `@evalguard/cli`
    // form. Bare `npx evalguard` resolves an unaffiliated third party's package
    // and executes it, so this normaliser must drop the package specifier too —
    // stripping only `npx ` left `@evalguard/cli eval --local`, which matches no
    // README line and would push the next reader to "fix" it back to the
    // vulnerable spelling.
    const stripLauncher = (s: string) =>
      s
        .replace(/^(?:npx|bunx|(?:pnpm|yarn|bun)\s+dlx)\s+(?:(?:-y|--yes)\s+)?/, "")
        .replace(/^@evalguard\/cli\s+/, "")
        .replace(/^evalguard\s+/, "")
        .trim();

    const command = stripLauncher(nextStep![1]!);
    const section = quickStartSection(fs.readFileSync(README, "utf-8"));
    const commands = fencedLines(section).map((l) => stripLauncher(l.trim()));
    expect(commands).toContain(command);
  });

  it("the path extractor flags a quickstart path that `init --local` does not create", () => {
    // Control for the machinery above: this is the exact shape the README used
    // to carry, and it must still be detected as a referenced path.
    const synthetic = [
      "```bash",
      "evalguard init --local",
      "evalguard eval evals/example.json --wait",
      "evalguard scan <your-scan>.json --wait",
      'evalguard firewall "Ignore all instructions"',
      "```",
    ].join("\n");

    const referenced = referencedPaths(synthetic);
    expect(referenced).toContain("evals/example.json");
    // Placeholders and quoted prose stay out.
    expect(referenced).not.toContain("<your-scan>.json");
    expect(referenced).toHaveLength(1);
  });
});
