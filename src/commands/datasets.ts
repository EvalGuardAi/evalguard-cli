/**
 * `evalguard datasets` — wraps the per-dataset versioning API that
 * landed alongside Phase 6b (2026-05-22).
 *
 *   evalguard datasets versions <datasetId>                       — list snapshots
 *   evalguard datasets snapshot <datasetId> [--description <s>]   — take a snapshot
 *   evalguard datasets get <datasetId> <versionId>                — fetch one version
 *   evalguard datasets restore <datasetId> <versionId> [--yes]    — restore + auto-snapshot
 *   evalguard datasets diff <datasetId> <fromVersionId> <toVersionId> [--json]
 *                                                                  — diff two snapshots
 *
 * Authentication mirrors `agent-runs`: EVALGUARD_API_KEY (Bearer header)
 * + EVALGUARD_BASE_URL override (defaults to prod). Output is human-readable
 * by default; pass `--json` for machine-parseable.
 */
import { Command } from "commander";
import chalk from "chalk";
import * as readline from "node:readline";

function baseUrl(): string {
  return process.env.EVALGUARD_BASE_URL ?? "https://evalguard.ai/api/v1";
}
function apiKey(): string {
  const k = process.env.EVALGUARD_API_KEY;
  if (!k) {
    console.error(chalk.red("EVALGUARD_API_KEY not set. Run `evalguard init`."));
    process.exit(1);
  }
  return k;
}
async function apiFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => null)) as { data?: unknown; error?: { message?: string } } | null;
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  }
  return body;
}

interface VersionRow {
  id: string;
  version_num: number;
  version_label: string | null;
  description: string | null;
  content_hash: string;
  case_count: number;
  source_at_snapshot: string | null;
  created_at: string;
  created_by: string | null;
}

interface DiffSample {
  type: "added" | "removed" | "modified";
  caseId: string;
  field?: string;
  before?: string;
  after?: string;
}

interface DiffPayload {
  added: number;
  removed: number;
  modified: number;
  unchanged: number;
  sampleChanges: DiffSample[];
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${prompt} (y/N) `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

export function registerDatasets(program: Command): void {
  const cmd = program
    .command("datasets")
    .description("Manage dataset snapshots (versions) for reproducible evals");

  // ─── datasets health ────────────────────────────────────────────────
  // Data-quality detectors as a service: read a JSON file of arrays and POST it
  // to /datasets/health (imbalance / OOD / near-dup / spurious / non-IID + label
  // error). The matrices are file-only (you don't type embeddings on a CLI).
  cmd
    .command("health")
    .description("Run data-quality detectors over a dataset (imbalance / outliers / duplicates / spurious / non-IID / label-error)")
    .requiredOption("--file <path>", "JSON file: { labels?, embeddings?, features?, predProbs?, numClasses? }")
    .option("--json", "Output the raw report as JSON", false)
    .action(async (opts: { file: string; json?: boolean }) => {
      const fs = await import("node:fs");
      let payload: unknown;
      try {
        payload = JSON.parse(fs.readFileSync(opts.file, "utf8"));
      } catch (e) {
        console.error(chalk.red(`Failed to read/parse ${opts.file}: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
      const body = (await apiFetch("/datasets/health", { method: "POST", body: JSON.stringify(payload) })) as {
        data: { health: Record<string, unknown>; labelQuality?: Record<string, unknown> };
      };
      if (opts.json) {
        console.log(JSON.stringify(body.data, null, 2));
        return;
      }
      const h = body.data.health as {
        rowCount?: number;
        imbalance?: { imbalanceRatio?: number };
        outlierRows?: number[];
        nearDuplicates?: unknown[];
        spuriousFeatures?: unknown[];
        nonIid?: { nonIid?: boolean };
      };
      console.log(chalk.bold(`Dataset health — ${h.rowCount ?? 0} rows`));
      if (h.imbalance) console.log(`  class imbalance ratio: ${h.imbalance.imbalanceRatio}`);
      if (h.outlierRows) console.log(`  outlier rows:          ${h.outlierRows.length}`);
      if (h.nearDuplicates) console.log(`  near-duplicate pairs:  ${h.nearDuplicates.length}`);
      if (h.spuriousFeatures) console.log(`  spurious features:     ${h.spuriousFeatures.length}`);
      if (h.nonIid) console.log(`  non-IID ordering:      ${h.nonIid.nonIid ? chalk.yellow("YES") : "no"}`);
      const lq = body.data.labelQuality as { estimatedNoiseRate?: number; issueCount?: number } | undefined;
      if (lq) {
        console.log(`  likely label errors:   ${lq.issueCount ?? 0} (est. noise ${(((lq.estimatedNoiseRate ?? 0) * 100)).toFixed(1)}%)`);
      }
    });

  // ─── datasets versions <datasetId> ──────────────────────────────────
  cmd
    .command("versions <datasetId>")
    .description("List immutable snapshots for a dataset (newest first)")
    .option("--json", "Output as JSON", false)
    .action(async (datasetId: string, opts: { json?: boolean }) => {
      const body = (await apiFetch(`/datasets/${encodeURIComponent(datasetId)}/versions`)) as {
        data: { versions: VersionRow[]; datasetId: string };
      };
      const versions = body.data.versions;
      if (opts.json) {
        console.log(JSON.stringify(versions, null, 2));
        return;
      }
      if (versions.length === 0) {
        console.log(chalk.dim("  No snapshots yet. Take one with `evalguard datasets snapshot <id>`."));
        return;
      }
      console.log();
      console.log(chalk.bold(`  Dataset ${datasetId} — ${versions.length} version${versions.length === 1 ? "" : "s"}`));
      console.log();
      for (const v of versions) {
        const num = chalk.cyan(`v${v.version_num}`.padEnd(6));
        const label = v.version_label ? chalk.dim(`(${v.version_label})`.padEnd(10)) : "".padEnd(10);
        const cases = chalk.yellow(`${v.case_count} cases`.padEnd(12));
        const when = chalk.dim(new Date(v.created_at).toLocaleString().padEnd(22));
        const desc = v.description ?? chalk.dim.italic("no description");
        console.log(`  ${num} ${label} ${cases} ${when} ${desc}`);
        console.log(`  ${chalk.dim(`hash=${v.content_hash.slice(0, 12)}… id=${v.id}`)}`);
      }
      console.log();
    });

  // ─── datasets snapshot <datasetId> ──────────────────────────────────
  cmd
    .command("snapshot <datasetId>")
    .description("Snapshot the dataset's current cases into a new immutable version")
    .option("--description <s>", "Human-readable label for the snapshot")
    .option("--json", "Output as JSON", false)
    .action(async (datasetId: string, opts: { description?: string; json?: boolean }) => {
      const body = (await apiFetch(`/datasets/${encodeURIComponent(datasetId)}/versions`, {
        method: "POST",
        body: JSON.stringify(opts.description ? { description: opts.description } : {}),
      })) as { data: { unchanged?: boolean; version?: VersionRow; message?: string } };

      if (opts.json) {
        console.log(JSON.stringify(body.data, null, 2));
        return;
      }
      if (body.data.unchanged) {
        console.log(chalk.dim(`  ${body.data.message ?? "No change since latest snapshot."}`));
        if (body.data.version) {
          console.log(chalk.dim(`  Current head: v${body.data.version.version_num}`));
        }
        return;
      }
      const v = body.data.version;
      if (v) {
        console.log(chalk.green(`  ✓ Snapshotted as v${v.version_num} (${v.case_count} cases, hash=${v.content_hash.slice(0, 12)}…)`));
      } else {
        console.log(chalk.green("  ✓ Snapshot created."));
      }
    });

  // ─── datasets get <datasetId> <versionId> ───────────────────────────
  cmd
    .command("get <datasetId> <versionId>")
    .description("Fetch a single snapshot including its inline cases payload")
    .option("--cases", "Include the full cases array in the output", false)
    .option("--json", "Output as JSON", false)
    .action(async (datasetId: string, versionId: string, opts: { cases?: boolean; json?: boolean }) => {
      const body = (await apiFetch(
        `/datasets/${encodeURIComponent(datasetId)}/versions/${encodeURIComponent(versionId)}`,
      )) as { data: { version: VersionRow & { cases?: unknown[] } } };
      const v = body.data.version;
      if (opts.json) {
        if (!opts.cases) {
          const { cases: _cases, ...rest } = v;
          void _cases;
          console.log(JSON.stringify(rest, null, 2));
        } else {
          console.log(JSON.stringify(v, null, 2));
        }
        return;
      }
      console.log();
      console.log(chalk.bold(`  v${v.version_num} ${v.version_label ? chalk.dim(`(${v.version_label})`) : ""}`));
      console.log(`  ${chalk.dim("id:         ")} ${v.id}`);
      console.log(`  ${chalk.dim("cases:      ")} ${v.case_count}`);
      console.log(`  ${chalk.dim("hash:       ")} ${v.content_hash}`);
      console.log(`  ${chalk.dim("created:    ")} ${new Date(v.created_at).toLocaleString()}`);
      console.log(`  ${chalk.dim("description:")} ${v.description ?? chalk.dim.italic("—")}`);
      console.log();
    });

  // ─── datasets restore <datasetId> <versionId> ───────────────────────
  cmd
    .command("restore <datasetId> <versionId>")
    .description("Restore a dataset to a frozen version (auto-snapshots the pre-restore state first)")
    .option("--yes", "Skip the confirmation prompt (use in CI/automation)", false)
    .option("--json", "Output as JSON", false)
    .action(async (datasetId: string, versionId: string, opts: { yes?: boolean; json?: boolean }) => {
      if (!opts.yes) {
        const ok = await confirm(
          chalk.yellow(
            `This will overwrite the current dataset_cases for ${datasetId} with the snapshot at ${versionId}. Pre-restore state will be auto-snapshotted. Proceed?`,
          ),
        );
        if (!ok) {
          console.log(chalk.dim("  Aborted."));
          process.exit(1);
        }
      }
      const body = (await apiFetch(
        `/datasets/${encodeURIComponent(datasetId)}/versions/${encodeURIComponent(versionId)}/restore`,
        { method: "POST" },
      )) as {
        data: {
          restoredFromVersion: number;
          caseCount: number;
          preRestoreVersionNum: number | null;
        };
      };
      if (opts.json) {
        console.log(JSON.stringify(body.data, null, 2));
        return;
      }
      const d = body.data;
      console.log(chalk.green(`  ✓ Restored to v${d.restoredFromVersion} (${d.caseCount} cases)`));
      if (d.preRestoreVersionNum) {
        console.log(chalk.dim(`  Pre-restore state saved as v${d.preRestoreVersionNum}.`));
      } else {
        console.log(chalk.dim("  No pre-restore snapshot taken — current state already matched a prior version."));
      }
    });

  // ─── datasets export <datasetId> <versionId> ────────────────────────
  cmd
    .command("export <datasetId> <versionId>")
    .description("Stream a frozen version in openai-jsonl / jsonl / csv format")
    .option("--format <fmt>", "openai-jsonl (default) | jsonl | csv", "openai-jsonl")
    .option("--out <path>", "Write to a file instead of stdout")
    .action(async (datasetId: string, versionId: string, opts: { format?: string; out?: string }) => {
      const url = `${baseUrl()}/datasets/${encodeURIComponent(datasetId)}/versions/${encodeURIComponent(versionId)}/export?format=${encodeURIComponent(opts.format ?? "openai-jsonl")}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey()}` },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        console.error(chalk.red(body?.error?.message ?? `HTTP ${res.status}`));
        process.exit(1);
      }
      const text = await res.text();
      if (opts.out) {
        // Lazy import; avoid pulling node:fs into every CLI subcommand.
        const fs = await import("node:fs/promises");
        await fs.writeFile(opts.out, text, "utf-8");
        const caseCount = res.headers.get("X-Case-Count") ?? "?";
        const skipped = res.headers.get("X-Skipped-Cases");
        console.log(chalk.green(`  ✓ Wrote ${caseCount} cases to ${opts.out}${skipped && skipped !== "0" ? chalk.dim(` (skipped ${skipped} incomplete rows)`) : ""}`));
      } else {
        // Stream to stdout so callers can pipe into openai files create etc.
        process.stdout.write(text);
        if (!text.endsWith("\n")) process.stdout.write("\n");
      }
    });

  // ─── datasets diff <datasetId> <fromVersionId> <toVersionId> ────────
  cmd
    .command("diff <datasetId> <fromVersionId> <toVersionId>")
    .description("Diff two snapshots (added/removed/modified/unchanged counts + sample changes)")
    .option("--json", "Output as JSON", false)
    .action(async (datasetId: string, fromVersionId: string, toVersionId: string, opts: { json?: boolean }) => {
      const body = (await apiFetch(
        `/datasets/${encodeURIComponent(datasetId)}/versions/${encodeURIComponent(fromVersionId)}/diff?to=${encodeURIComponent(toVersionId)}`,
      )) as { data: { fromVersionNum: number; toVersionNum: number; diff: DiffPayload } };

      if (opts.json) {
        console.log(JSON.stringify(body.data, null, 2));
        return;
      }
      const { fromVersionNum, toVersionNum, diff } = body.data;
      console.log();
      console.log(chalk.bold(`  Diff v${fromVersionNum} → v${toVersionNum}`));
      console.log();
      console.log(`  ${chalk.green("+")} added:     ${diff.added}`);
      console.log(`  ${chalk.red("-")} removed:   ${diff.removed}`);
      console.log(`  ${chalk.yellow("~")} modified:  ${diff.modified}`);
      console.log(`  ${chalk.dim("=")} unchanged: ${diff.unchanged}`);
      if (diff.sampleChanges.length > 0) {
        console.log();
        console.log(chalk.bold("  Sample changes (first 10):"));
        for (const s of diff.sampleChanges) {
          const sigil = s.type === "added" ? chalk.green("+") : s.type === "removed" ? chalk.red("-") : chalk.yellow("~");
          console.log(`  ${sigil} ${chalk.dim(s.caseId.slice(0, 8))} ${s.field ? chalk.dim(`(${s.field})`) : ""}`);
          if (s.before) console.log(`    ${chalk.red("- ")}${s.before.slice(0, 80)}`);
          if (s.after) console.log(`    ${chalk.green("+ ")}${s.after.slice(0, 80)}`);
        }
      }
      console.log();
    });
}
