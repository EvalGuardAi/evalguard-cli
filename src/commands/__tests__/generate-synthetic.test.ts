import { describe, expect, it, afterEach, vi } from "vitest";
import { Command } from "commander";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  registerGenerateDataset,
  serializeSyntheticDataset,
  type SyntheticCliDataset,
} from "../generate-dataset.js";

/**
 * Reachability proof for packages/core/src/synthetic (SyntheticDataFactory).
 *
 * Before 2026-08 the module was exported from `@evalguard/core` and imported
 * by nothing but its own unit test — no route, no CLI command, no worker job.
 * `evalguard generate synthetic` is now the shipped caller; `registerGenerateDataset`
 * is invoked at apps/cli/src/index.ts:680.
 */

const written: string[] = [];

afterEach(() => {
  for (const f of written.splice(0)) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* best effort */
    }
  }
});

function tmpFile(name: string): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "eg-syn-")), name);
  written.push(p);
  return p;
}

// Import-phase warm-up. `await import()` inside a test body is billed against
// `testTimeout`, and this file reaches `@evalguard/core` lazily, so the first
// case to touch it paid for the whole 2,173-file graph — ~5 s idle, and past
// the budget under the pre-push sweep. Loading it here moves that cost into
// the file's import phase, which vitest bills against no per-test budget.
// Must be top-level `await import`, not a static import: vitest hoists
// `vi.mock` above static imports. Full rationale: src/__tests__/cli-smoke.test.ts
await import("@evalguard/core");

describe("evalguard generate synthetic — registration", () => {
  it("registers the subcommand under `generate`", () => {
    const program = new Command();
    registerGenerateDataset(program);
    const gen = program.commands.find((c) => c.name() === "generate");
    expect(gen).toBeDefined();
    expect(gen!.commands.map((c) => c.name())).toContain("synthetic");
  });

  it("still registers the pre-existing `dataset` subcommand", () => {
    const program = new Command();
    registerGenerateDataset(program);
    const gen = program.commands.find((c) => c.name() === "generate")!;
    expect(gen.commands.map((c) => c.name())).toContain("dataset");
  });
});

describe("evalguard generate synthetic — end to end", () => {
  it("calls SyntheticDataFactory and writes a JSON dataset", async () => {
    const out = tmpFile("out.json");
    const program = new Command();
    program.exitOverride();
    registerGenerateDataset(program);

    await program.parseAsync([
      "node",
      "evalguard",
      "generate",
      "synthetic",
      "--domain",
      "healthcare",
      "--type",
      "pii_test",
      "--count",
      "6",
      "--seed",
      "42",
      "--output",
      out,
    ]);

    expect(fs.existsSync(out)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(out, "utf-8"));
    expect(parsed.domain).toBe("healthcare");
    expect(parsed.type).toBe("pii_test");
    expect(parsed.cases).toHaveLength(6);
    expect(parsed.cases[0].input.length).toBeGreaterThan(0);
  });

  it("is reproducible from --seed", async () => {
    const runOnce = async (out: string) => {
      const program = new Command();
      program.exitOverride();
      registerGenerateDataset(program);
      await program.parseAsync([
        "node",
        "evalguard",
        "generate",
        "synthetic",
        "--domain",
        "general",
        "--type",
        "qa_pairs",
        "--count",
        "8",
        "--seed",
        "1234",
        "--output",
        out,
      ]);
      return JSON.parse(fs.readFileSync(out, "utf-8")).cases.map(
        (c: { input: string }) => c.input,
      );
    };

    const a = await runOnce(tmpFile("a.json"));
    const b = await runOnce(tmpFile("b.json"));
    expect(a).toEqual(b);
  });
});

/**
 * `--difficulty` is a documented enum (SyntheticDataConfig.difficulty is
 * `"easy" | "medium" | "hard"`), and every sibling option — domain, type,
 * count, seed — is validated and exits 1 on a bad value. `--difficulty` was
 * passed straight through, so `--difficulty banana` silently tagged every
 * emitted item `"banana"` and wrote the file.
 */
describe("evalguard generate synthetic — --difficulty validation", () => {
  const VALID = ["easy", "medium", "hard"];

  async function runWithDifficulty(value: string, out: string): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerGenerateDataset(program);
    await program.parseAsync([
      "node",
      "evalguard",
      "generate",
      "synthetic",
      "--domain",
      "general",
      "--type",
      "qa_pairs",
      "--count",
      "3",
      "--seed",
      "7",
      "--difficulty",
      value,
      "--output",
      out,
    ]);
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a value outside the enum, exits 1, and writes nothing", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    // Make exit actually stop the action, the way it does in a real process —
    // otherwise a "validated" option could still fall through and write.
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);

    const out = tmpFile("bad-difficulty.json");
    await expect(runWithDifficulty("banana", out)).rejects.toThrow("process.exit:1");

    expect(errors.join("\n")).toContain("--difficulty");
    expect(errors.join("\n")).toContain("banana");
    expect(fs.existsSync(out)).toBe(false);
  });

  it("accepts every documented level and tags the items with it", async () => {
    for (const level of VALID) {
      const out = tmpFile(`ok-${level}.json`);
      await runWithDifficulty(level, out);
      const parsed = JSON.parse(fs.readFileSync(out, "utf-8"));
      expect(parsed.cases.length).toBeGreaterThan(0);
      for (const c of parsed.cases) {
        expect(c.difficulty).toBe(level);
      }
    }
  });
});

describe("serializeSyntheticDataset", () => {
  const dataset: SyntheticCliDataset = {
    id: "dataset-1",
    items: [
      {
        id: "syn-1",
        input: 'He said "hi", then left',
        expectedOutput: "line1\nline2",
        category: "qa_pairs",
        difficulty: "medium",
        language: "en",
      },
      { id: "syn-2", input: "plain", category: "qa_pairs", difficulty: "medium", language: "en" },
    ],
    metadata: {
      generatedAt: "2026-08-02T00:00:00.000Z",
      domain: "general",
      type: "qa_pairs",
      totalItems: 2,
      languages: ["en"],
      qualityScore: 100,
      groundTruthCoverage: 50,
    },
  };

  it("escapes quotes, commas and newlines in CSV", () => {
    const csv = serializeSyntheticDataset(dataset, "csv");
    const [header, row1] = csv.split("\n");
    expect(header).toBe("id,input,expectedOutput,category,difficulty,language");
    expect(row1).toContain('"He said ""hi"", then left"');
  });

  it("emits an empty CSV cell (not a foreign answer) for an unlabelled item", () => {
    const csv = serializeSyntheticDataset(dataset, "csv");
    const rows = csv.split("\n");
    // syn-2 has no expectedOutput — the third column must be empty.
    expect(rows[rows.length - 1]).toContain('plain,""');
  });

  it("carries the measured metrics into JSON output", () => {
    const parsed = JSON.parse(serializeSyntheticDataset(dataset, "json"));
    expect(parsed.qualityScore).toBe(100);
    expect(parsed.groundTruthCoverage).toBe(50);
  });
});
