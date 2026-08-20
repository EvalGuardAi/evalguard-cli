import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { registerCodeScan } from "../code-scan.js";

/**
 * CI-GATE REGRESSION.
 *
 * `code-scan` exits 1 on critical/high for the text output and for
 * `--output <file>`, but the `--format json` and `--format sarif` STDOUT
 * branches used to `return` — exit 0. A workflow step like
 *   `npx @evalguard/cli code-scan --format sarif > eg.sarif`
 * therefore reported success while the SARIF it just wrote listed a hardcoded
 * OPENAI_API_KEY, and the job went green. A machine-readable output format must
 * not weaken the gate.
 */

const SECRET_FILE = [
  "const client = new OpenAI({",
  '  apiKey: "sk-proj-abcdEFGH1234567890ijklMNOPqrstUVWXyz0123456789",',
  "});",
  "",
].join("\n");

let tmpRoot: string;
let exitSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let exitCodes: number[];
let stdout: string[];

class ExitSentinel extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evalguard-code-scan-exit-"));
  exitCodes = [];
  stdout = [];
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCodes.push(code ?? 0);
    throw new ExitSentinel(code ?? 0);
  }) as never);
  logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  });
});
afterEach(() => {
  exitSpy.mockRestore();
  logSpy.mockRestore();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Run the command; swallow the process.exit sentinel and report the code. */
async function run(args: string[]): Promise<number> {
  const program = new Command();
  program.exitOverride();
  registerCodeScan(program);
  try {
    await program.parseAsync(["node", "evalguard", "code-scan", ...args]);
  } catch (err) {
    if (err instanceof ExitSentinel) return err.code;
    throw err;
  }
  return 0;
}

// Import-phase warm-up. `await import()` inside a test body is billed against
// `testTimeout`, and this file reaches `@evalguard/core` lazily, so the first
// case to touch it paid for the whole 2,173-file graph — ~5 s idle, and past
// the budget under the pre-push sweep. Loading it here moves that cost into
// the file's import phase, which vitest bills against no per-test budget.
// Must be top-level `await import`, not a static import: vitest hoists
// `vi.mock` above static imports. Full rationale: src/__tests__/cli-smoke.test.ts
await import("@evalguard/core");

describe("code-scan :: CI exit code across output formats", () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(tmpRoot, "client.ts"), SECRET_FILE);
  });

  it("exits 1 for the default text output (baseline)", async () => {
    expect(await run([tmpRoot])).toBe(1);
  }, 60_000);

  it("**exits 1 for --format sarif on stdout**", async () => {
    const code = await run([tmpRoot, "--format", "sarif"]);
    // The SARIF still has to be emitted — the gate must not suppress output.
    expect(stdout.join("\n")).toContain("sarif-schema-2.1.0");
    expect(code).toBe(1);
  }, 60_000);

  it("**exits 1 for --format json on stdout**", async () => {
    const code = await run([tmpRoot, "--format", "json"]);
    expect(stdout.join("\n")).toContain('"findings"');
    expect(code).toBe(1);
  }, 60_000);

  it("exits 1 for --output <file> (baseline)", async () => {
    const out = path.join(process.cwd(), "eg-code-scan-test.json");
    try {
      expect(await run([tmpRoot, "--output", out])).toBe(1);
    } finally {
      fs.rmSync(out, { force: true });
    }
  }, 60_000);
});

describe("code-scan :: clean tree exits 0 in every format", () => {
  beforeEach(() => {
    fs.writeFileSync(
      path.join(tmpRoot, "safe.ts"),
      "export const add = (a: number, b: number) => a + b;\n",
    );
  });

  for (const fmt of ["text", "json", "sarif"]) {
    it(`--format ${fmt}`, async () => {
      expect(await run([tmpRoot, "--format", fmt])).toBe(0);
    }, 60_000);
  }
});
