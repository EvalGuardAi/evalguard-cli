import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { registerInit, LOCAL_YAML, TEMPLATES, templateNeedsApiKey } from "../init.js";

/**
 * ZERO-SIGNUP QUICKSTART — the documented path must complete.
 *
 * RED, measured on the built CLI from a clean scratch directory with no
 * OPENAI_API_KEY / EVALGUARD_API_KEY in the environment:
 *
 *   $ evalguard init --template hello-world
 *       ✓ Created evalguard.yaml
 *       Or run locally without an API key:
 *         npx @evalguard/cli eval --local                            EXIT 0
 *   $ evalguard eval --local
 *       ✖ No API key found. Set OPENAI_API_KEY environment variable.  EXIT 1
 *   $ evalguard eval:local evalguard.yaml    ("no API key needed" per its help)
 *       ✖ No API key found. Set OPENAI_API_KEY environment variable.  EXIT 1
 *
 * Three consecutive failures on the first thing a new user touches.
 *
 * Diagnosis correction worth recording: `--local` IS a real flag on `eval`
 * (index.ts:419) and it correctly delegates to `eval:local` — the reported
 * "not a flag" was a symptom, not the cause. The single root cause is that
 * `init -t hello-world` writes a config pinned to `openai:gpt-4o-mini` and then
 * prints "Or run locally without an API key" over it.
 *
 * GREEN, same clean directory, verified end-to-end against the rebuilt CLI:
 *
 *   $ evalguard init --local
 *   $ evalguard eval --local
 *       ● Results: 2 passed, 0 failed (100.0%)                        EXIT 0
 */

let tmpDir: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;
let stdout: string[];
let stderr: string[];

class ExitSentinel extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eg-quickstart-"));
  stdout = [];
  stderr = [];
  // A CLEAN directory, exactly as a new user would have.
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSentinel(code ?? 0);
  }) as never);
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void stdout.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void stderr.push(a.map(String).join(" ")));
});

afterEach(() => {
  cwdSpy.mockRestore();
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function runInit(args: string[]): Promise<number> {
  const program = new Command();
  program.exitOverride();
  registerInit(program);
  try {
    await program.parseAsync(["node", "evalguard", "init", ...args]);
  } catch (err) {
    if (err instanceof ExitSentinel) return err.code;
    throw err;
  }
  return 0;
}

const yaml = () => fs.readFileSync(path.join(tmpDir, "evalguard.yaml"), "utf-8");

describe("the printed next-steps must be true of the config just written", () => {
  it("`init -t hello-world` no longer claims the config runs without an API key", async () => {
    expect(await runInit(["--template", "hello-world", "--yes"])).toBe(0);

    // The config genuinely does need a key — that part is fine and unchanged.
    expect(templateNeedsApiKey(yaml())).toBe(true);
    expect(yaml()).toContain("openai:gpt-4o-mini");

    const printed = stdout.join("\n");
    // THE REGRESSION: this exact sentence, over an OpenAI-pinned config, is
    // what made the documented path fail at step 2.
    expect(printed).not.toContain("Or run locally without an API key");
    // and the keyless route it offers instead is the one that actually works
    expect(printed).toContain("npx @evalguard/cli init --local");
  });

  it("every command the next-steps mention is a command that exists", async () => {
    await runInit(["--template", "hello-world", "--yes"]);
    // Strip ANSI before matching. init prints these through `chalk.dim(...)`,
    // so with colour ENABLED the line begins with an escape sequence and
    // `startsWith("npx @evalguard/cli ")` matches nothing — `suggested` comes
    // back empty and the assertion below fails with "expected 0 to be greater
    // than 0". Whether that happens is decided by chalk's TTY/FORCE_COLOR
    // detection, i.e. by the terminal the suite runs in, not by the code under
    // test: green in CI (no TTY, colour off), red locally. Observed 2026-08-16.
    // The `.length > 0` guard is the only thing keeping the loop below from
    // passing vacuously, so an empty list must stay a failure — the fix is to
    // make the match colour-independent, not to relax the guard.
    const ESC = String.fromCharCode(27);
    const stripAnsi = (s: string) => s.split(new RegExp(ESC + "\[[0-9;]*m", "g")).join("");
    const suggested = stripAnsi(stdout.join("\n"))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("npx @evalguard/cli "))
      .map((l) => l.replace(/^npx @evalguard\/cli /, "").split(/\s+/)[0]);
    expect(suggested.length).toBeGreaterThan(0);
    // `init`, `eval`, `view` are all real top-level commands; the point is that
    // nothing here is a name that only exists in prose.
    for (const name of suggested) {
      expect(["init", "eval", "eval:local", "view", "scan"]).toContain(name);
    }
  });
});

describe("the keyless path actually is keyless", () => {
  it("`init --local` writes a config with NO API-key-bearing provider", async () => {
    expect(await runInit(["--local", "--yes"])).toBe(0);
    const written = yaml();
    expect(written).toBe(LOCAL_YAML);
    // The predicate the refusal below relies on, asserted on the real artifact.
    expect(templateNeedsApiKey(written)).toBe(false);
    expect(written).toContain("id: echo");
    // No `${…}` interpolation anywhere: the template mentions OPENAI_API_KEY in
    // a trailing COMMENT (how to upgrade to LLM scorers later), which is
    // documentation, not a requirement — so match on the interpolation syntax,
    // not the bare word.
    expect(written).not.toContain("${");
  });

  it("its next-steps point at `eval --local`, which is a real flag on `eval`", async () => {
    await runInit(["--local", "--yes"]);
    expect(stdout.join("\n")).toContain("npx @evalguard/cli eval --local");
  });
});

describe("`--local` is no longer silently ignored when a template is named", () => {
  it("refuses `--local -t hello-world` instead of writing an OpenAI-pinned config", async () => {
    // Was: scaffolded the hosted template and printed LOCAL next-steps over it,
    // i.e. the flag did nothing and the output lied about the result.
    const code = await runInit(["--local", "--template", "hello-world", "--yes"]);
    expect(code).toBe(2);
    expect(stderr.join("\n")).toMatch(/--local and --template hello-world conflict/);
    // And it wrote nothing, so the user's directory is untouched.
    expect(fs.existsSync(path.join(tmpDir, "evalguard.yaml"))).toBe(false);
  });

  it("POSITIVE CONTROL: `--local -t local-only` is not a conflict", async () => {
    expect(await runInit(["--local", "--template", "local-only", "--yes"])).toBe(0);
    expect(yaml()).toBe(LOCAL_YAML);
  });

  it("POSITIVE CONTROL: a template WITHOUT --local still scaffolds normally", async () => {
    expect(await runInit(["--template", "hello-world", "--yes"])).toBe(0);
    expect(yaml()).toContain("openai:gpt-4o-mini");
  });
});

describe("templateNeedsApiKey", () => {
  it("classifies every shipped template, so the refusal cannot go stale", () => {
    // Derived from the template's own `providers:` ids rather than a hard-coded
    // list, so adding a keyless template makes `--local` compose with it
    // automatically. Today exactly one config is keyless: LOCAL_YAML.
    expect(templateNeedsApiKey(LOCAL_YAML)).toBe(false);
    const hosted = Object.entries(TEMPLATES).filter(([, t]) => templateNeedsApiKey(t.yaml));
    expect(hosted.length).toBe(Object.keys(TEMPLATES).length);
  });

  it("treats an unrecognisable config as NEEDING a key (over-promising is the defect)", () => {
    expect(templateNeedsApiKey("description: nothing here")).toBe(true);
  });

  it("POSITIVE CONTROL: recognises each keyless provider `eval:local` supports", () => {
    for (const id of ["echo", "ollama", "localai", "llamafile", "llamacpp"]) {
      expect(templateNeedsApiKey(`providers:\n  - id: ${id}\n`), id).toBe(false);
    }
    expect(templateNeedsApiKey("providers:\n  - id: openai:gpt-4o-mini\n")).toBe(true);
    expect(templateNeedsApiKey("providers:\n  - id: anthropic:claude-3\n")).toBe(true);
  });
});
