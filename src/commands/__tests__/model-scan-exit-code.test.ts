import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Command } from "commander";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { registerModelScan } from "../model-scan.js";

/**
 * CI-GATE REGRESSION (deep-E2E audit 2026-07-25, M9).
 *
 * `model-scan` exits 1 on critical findings for the human-readable text output,
 * but the `--format json` branch used to `return` before the exit-code block —
 * so the MACHINE-READABLE mode a pipeline actually uses was the one that failed
 * open. A CI step like
 *   `evalguard model-scan ./models --format json > scan.json`
 * went green on a pickle containing `os.system`, and the backdoored model
 * shipped. The JSON body even reported `hasCritical: true`; only the process
 * exit code disagreed.
 *
 * Same class as the code-scan exit-code regression next door.
 */

/**
 * A minimal pickle that trips the scanner's `os.system` suspicious-import rule
 * (critical) — the exact shape of a trojaned checkpoint.
 */
const MALICIOUS_PICKLE = Buffer.from(
  "\x80\x04\x95\x20\x00\x00\x00\x00\x00\x00\x00\x8c\x02os\x94\x8c\x06system\x94\x93\x94\x8c\x09os.system\x94",
  "binary",
);

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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evalguard-model-scan-exit-"));
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
  registerModelScan(program);
  try {
    await program.parseAsync(["node", "evalguard", ...args]);
  } catch (err) {
    if (err instanceof ExitSentinel) return err.code;
    throw err;
  }
  return exitCodes.length > 0 ? exitCodes[exitCodes.length - 1] : 0;
}

describe("model-scan exit code parity across output formats", () => {
  it("--format json exits 1 when a model file carries a CRITICAL finding", async () => {
    const modelPath = path.join(tmpRoot, "weights.pkl");
    fs.writeFileSync(modelPath, MALICIOUS_PICKLE);

    const code = await run(["model-scan", modelPath, "--format", "json"]);

    // The JSON body must still carry the finding...
    const payload = JSON.parse(stdout.join("\n"));
    expect(Array.isArray(payload)).toBe(true);
    expect(payload.some((f: { hasCritical?: boolean }) => f.hasCritical === true)).toBe(true);
    // ...AND the process must fail the pipeline.
    expect(code).toBe(1);
  });

  it("--format json exits 0 for a clean model file", async () => {
    const modelPath = path.join(tmpRoot, "clean.safetensors");
    // SafeTensors header: 8-byte little-endian length + JSON metadata.
    const header = Buffer.from(JSON.stringify({ __metadata__: { format: "pt" } }), "utf8");
    const len = Buffer.alloc(8);
    len.writeUInt32LE(header.length, 0);
    fs.writeFileSync(modelPath, Buffer.concat([len, header]));

    const code = await run(["model-scan", modelPath, "--format", "json"]);
    expect(code).toBe(0);
  });
});
