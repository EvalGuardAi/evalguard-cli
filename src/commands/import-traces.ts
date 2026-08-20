/**
 * `evalguard import:traces --from <platform> <file>` — import a trace
 * export from Helicone, Langfuse, or Portkey into EvalGuard's neutral
 * trace shape.
 *
 * Closes A8 from the 2026-05-08 v2 audit. Promptfoo's
 * `src/integrations/` directory ships analogous adapters; this is
 * our equivalent for the LLM observability platforms.
 *
 * Behaviour:
 *   1. Read the file (JSON or NDJSON).
 *   2. Dispatch to the platform-specific importer.
 *   3. Print a summary: total / errors / dupes.
 *   4. Optionally write the neutral spans as JSON to `--output`.
 *   5. (Future) POST to /api/v1/traces for ingestion when the user
 *      passes `--ingest`.
 *
 * No silent drops. Records the importer can't parse are surfaced as
 * errors with their original index. Re-running the same import
 * doesn't double-count: spans use a stable hash id, and the import
 * function dedupes within a single run.
 */

import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";
import {
  importTraces,
  SUPPORTED_PLATFORMS,
  type TraceImportPlatform,
} from "@evalguard/core";

function loadFile(filePath: string): unknown {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(chalk.red(`File not found: ${resolved}`));
    process.exit(1);
  }
  const text = fs.readFileSync(resolved, "utf8");

  // Support both JSON ([...] / { data: [...] }) and JSONL (one record per line).
  if (filePath.toLowerCase().endsWith(".jsonl") || filePath.toLowerCase().endsWith(".ndjson")) {
    const records: unknown[] = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch (e) {
        console.error(chalk.red(`Invalid JSON on line: ${trimmed.slice(0, 80)}…`));
        process.exit(1);
      }
    }
    return records;
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(chalk.red(`Failed to parse JSON: ${(e as Error).message}`));
    process.exit(1);
  }
}

function isSupported(p: string): p is TraceImportPlatform {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(p);
}

export function registerImportTraces(program: Command): void {
  program
    .command("import:traces")
    .description("Import traces from Helicone / Langfuse / Portkey exports")
    .argument("<file>", "Path to the export file (JSON or JSONL)")
    .requiredOption("--from <platform>", `Source platform (${SUPPORTED_PLATFORMS.join(" | ")})`)
    .option("-o, --output <path>", "Write the imported neutral-shape spans to this JSON file")
    .option("--show-errors", "Print full error list (default: count only)", false)
    .option("--limit <n>", "Process only the first N records (smoke testing)", (v) => parseInt(v, 10))
    .action((file: string, opts: { from: string; output?: string; showErrors?: boolean; limit?: number }) => {
      const platform = opts.from.toLowerCase();
      if (!isSupported(platform)) {
        console.error(chalk.red(`Unknown platform: ${opts.from}`));
        console.error(`  Supported: ${SUPPORTED_PLATFORMS.join(", ")}`);
        process.exit(1);
      }

      const raw = loadFile(file);

      // Apply --limit to the input array if present (for smoke runs)
      let bounded: unknown = raw;
      if (typeof opts.limit === "number" && opts.limit > 0) {
        if (Array.isArray(raw)) {
          bounded = raw.slice(0, opts.limit);
        } else if (raw && typeof raw === "object") {
          const obj = raw as { data?: unknown[]; observations?: unknown[]; logs?: unknown[] };
          if (Array.isArray(obj.data)) bounded = { ...obj, data: obj.data.slice(0, opts.limit) };
          else if (Array.isArray(obj.observations)) bounded = { ...obj, observations: obj.observations.slice(0, opts.limit) };
          else if (Array.isArray(obj.logs)) bounded = { ...obj, logs: obj.logs.slice(0, opts.limit) };
        }
      }

      const result = importTraces(platform, bounded);

      // Summary
      console.log("");
      console.log(chalk.bold(`  ${result.platform} import summary`));
      console.log(`  ${chalk.dim("Spans imported")}    ${chalk.green(result.spans.length)}`);
      console.log(`  ${chalk.dim("Skipped duplicates")} ${result.skippedDuplicates}`);
      console.log(`  ${chalk.dim("Parse errors")}      ${result.errors.length === 0 ? chalk.green(0) : chalk.red(result.errors.length)}`);

      if (result.errors.length > 0 && opts.showErrors) {
        console.log("");
        console.log(chalk.red("  Errors:"));
        for (const e of result.errors.slice(0, 25)) {
          console.log(`    [#${e.index}] ${e.message}`);
        }
        if (result.errors.length > 25) {
          console.log(chalk.dim(`    … and ${result.errors.length - 25} more (re-run with --output to see all in JSON)`));
        }
      } else if (result.errors.length > 0) {
        console.log(chalk.dim(`  Re-run with \`--show-errors\` to see them.`));
      }

      // Optional file output
      if (opts.output) {
        const outPath = path.resolve(opts.output);
        fs.writeFileSync(
          outPath,
          JSON.stringify(
            {
              platform: result.platform,
              importedAt: new Date().toISOString(),
              spans: result.spans,
              errors: result.errors,
              skippedDuplicates: result.skippedDuplicates,
            },
            null,
            2,
          ),
        );
        console.log(`  ${chalk.green("✓")} Wrote ${chalk.cyan(outPath)}`);
      }

      console.log("");
      // Exit non-zero when there are parse errors AND no spans were
      // produced — that's the "the file is wrong" case the user
      // probably wants their CI to gate on. Mixed (some-ok-some-bad)
      // exits 0; consult --show-errors.
      if (result.errors.length > 0 && result.spans.length === 0) {
        process.exit(1);
      }
    });
}
