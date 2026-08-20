/**
 * `evalguard fine-tune` — wraps the Phase 5 ledger endpoints from
 * 6e292782. Read-only today (list + get). Submit + cancel land once
 * the per-vendor adapters are wired (OpenAI / Anthropic / Vertex / ...).
 *
 *   evalguard fine-tune list [--status <s>] [--provider <p>] [--json]
 *   evalguard fine-tune get <jobId> [--json]
 */
import { Command } from "commander";
import chalk from "chalk";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";
import { boundedFetch, decodeJsonBody } from "../lib/http.js";

function baseUrl(): string {
  return resolveBaseUrl();
}
function apiKey(): string {
  const k = resolveApiKey();
  if (!k) {
    console.error(chalk.red("EVALGUARD_API_KEY not set. Run `evalguard init`."));
    process.exit(1);
  }
  return k;
}
async function apiFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await boundedFetch(`${baseUrl()}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "content-type": "application/json",
      "x-requested-with": "fetch",
      ...(init.headers ?? {}),
    },
  });
  const body = (await decodeJsonBody(res, `${path}`)) as { data?: unknown; error?: { message?: string } } | null;
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  }
  return body;
}

type JobStatus = "pending" | "validating" | "queued" | "running" | "succeeded" | "failed" | "cancelled";

interface Job {
  id: string;
  provider: string;
  base_model: string;
  fine_tuned_model: string | null;
  status: JobStatus;
  case_count: number;
  trained_tokens: number | null;
  estimated_cost: number | null;
  error_message: string | null;
  created_at: string;
  finished_at: string | null;
}

function colorize(status: JobStatus): typeof chalk.green {
  switch (status) {
    case "succeeded": return chalk.green;
    case "failed":    return chalk.red;
    case "running":
    case "validating": return chalk.yellow;
    case "cancelled":  return chalk.dim;
    default:          return chalk.cyan;
  }
}

export function registerFineTune(program: Command): void {
  const cmd = program.command("fine-tune").description("Manage cross-provider fine-tuning jobs");

  cmd
    .command("list")
    .description("List fine-tuning jobs for your org (newest first)")
    .option("--status <s>", "Filter to pending / validating / queued / running / succeeded / failed / cancelled")
    .option("--provider <p>", "Filter to a single provider (openai / anthropic / vertex / ...)")
    .option("--limit <n>", "Max rows", "50")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { status?: string; provider?: string; limit?: string; json?: boolean }) => {
      const qs = new URLSearchParams();
      if (opts.status) qs.set("status", opts.status);
      if (opts.provider) qs.set("provider", opts.provider);
      if (opts.limit) qs.set("limit", opts.limit);
      const body = (await apiFetch(`/fine-tune/jobs${qs.toString() ? `?${qs}` : ""}`)) as {
        data: { jobs: Job[]; total: number };
      };
      const jobs = body.data.jobs;
      if (opts.json) {
        console.log(JSON.stringify(body.data, null, 2));
        return;
      }
      console.log();
      if (jobs.length === 0) {
        console.log(chalk.dim("  No fine-tuning jobs yet."));
        console.log(chalk.dim("  Submit will be wired once per-vendor adapters land."));
        console.log();
        return;
      }
      console.log(chalk.bold(`  Fine-tuning jobs (${body.data.total} total)`));
      console.log();
      for (const j of jobs) {
        const c = colorize(j.status);
        console.log(`  ${chalk.dim(j.id.slice(0, 8))}  ${c(j.status.padEnd(10))} ${chalk.cyan(j.provider.padEnd(10))} ${j.base_model}`);
        if (j.fine_tuned_model) {
          console.log(`    ${chalk.dim("→")} ${chalk.green(j.fine_tuned_model)}`);
        }
        if (j.error_message) {
          console.log(`    ${chalk.dim("err:")} ${chalk.red(j.error_message)}`);
        }
        const cost = j.estimated_cost != null ? `$${Number(j.estimated_cost).toFixed(2)}` : "—";
        const tokens = j.trained_tokens != null ? `${j.trained_tokens.toLocaleString()} tokens` : "—";
        console.log(`    ${chalk.dim(`${j.case_count} cases · ${tokens} · ${cost} · ${new Date(j.created_at).toLocaleString()}`)}`);
      }
      console.log();
    });

  cmd
    .command("estimate")
    .description("Estimate fine-tune cost before submitting (cases × tokens × vendor rate × epochs)")
    .requiredOption("--provider <p>", "openai | anthropic | vertex | azure-openai | fireworks | together")
    .requiredOption("--base-model <m>", "Vendor base model id (eg. gpt-4o-mini-2024-07-18)")
    .requiredOption("--dataset <id>", "Dataset UUID")
    .requiredOption("--version <id>", "dataset_versions row UUID to pin to")
    .option("--epochs <n>", "Default 3", "3")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { provider: string; baseModel: string; dataset: string; version: string; epochs?: string; json?: boolean }) => {
      const body = (await apiFetch("/fine-tune/estimate", {
        method: "POST",
        body: JSON.stringify({
          provider: opts.provider,
          baseModel: opts.baseModel,
          datasetId: opts.dataset,
          datasetVersionId: opts.version,
          ...(opts.epochs ? { epochs: Number(opts.epochs) } : {}),
        }),
      })) as {
        data: {
          estimate: {
            totalTrainingTokens: number;
            epochs: number;
            estimatedUsd: number;
            source: string;
            rateLastUpdated: string;
            notes: string[];
          };
          caseCount: number;
          skippedCases: number;
        };
      };
      if (opts.json) {
        console.log(JSON.stringify(body.data, null, 2));
        return;
      }
      const e = body.data.estimate;
      console.log();
      console.log(chalk.bold(`  Fine-tune cost forecast`));
      console.log();
      console.log(`  ${chalk.dim("Cases:       ")} ${body.data.caseCount}${body.data.skippedCases > 0 ? chalk.dim(` (skipped ${body.data.skippedCases} incomplete rows)`) : ""}`);
      console.log(`  ${chalk.dim("Tokens:      ")} ${e.totalTrainingTokens.toLocaleString()}`);
      console.log(`  ${chalk.dim("Epochs:      ")} ${e.epochs}`);
      console.log();
      console.log(`  ${chalk.dim("Estimated:   ")} ${chalk.green(`$${e.estimatedUsd.toFixed(4)}`)}`);
      console.log();
      console.log(`  ${chalk.dim("Rate source: ")} ${e.source}`);
      console.log(`  ${chalk.dim("Last verified:")} ${e.rateLastUpdated}`);
      for (const note of e.notes) {
        console.log(`  ${chalk.dim("Note: ")}${chalk.dim(note)}`);
      }
      console.log();
    });

  cmd
    .command("submit")
    .description("Submit a new fine-tuning job pinned to an immutable dataset_versions snapshot")
    .requiredOption("--provider <p>", "openai | anthropic | vertex | azure-openai | fireworks | together")
    .requiredOption("--base-model <m>", "Vendor base model id (eg. gpt-4o-mini-2024-07-18)")
    .requiredOption("--dataset <id>", "Dataset UUID")
    .requiredOption("--version <id>", "dataset_versions row UUID to pin to")
    .option("--suffix <s>", "Optional vendor-side label that shows up in their UI")
    .option("--hyperparameters <json>", 'Optional JSON object (e.g. \'{"n_epochs":3}\')')
    .option("--project <id>", "Optional project UUID to tag the job with")
    .option("--json", "Output as JSON", false)
    .action(async (opts: {
      provider: string;
      baseModel: string;
      dataset: string;
      version: string;
      suffix?: string;
      hyperparameters?: string;
      project?: string;
      json?: boolean;
    }) => {
      let hyperparameters: Record<string, unknown> | undefined;
      if (opts.hyperparameters) {
        try {
          hyperparameters = JSON.parse(opts.hyperparameters) as Record<string, unknown>;
        } catch {
          console.error(chalk.red("--hyperparameters must be valid JSON"));
          process.exit(1);
        }
      }
      const body = (await apiFetch("/fine-tune/jobs", {
        method: "POST",
        body: JSON.stringify({
          provider: opts.provider,
          baseModel: opts.baseModel,
          datasetId: opts.dataset,
          datasetVersionId: opts.version,
          ...(opts.suffix ? { suffix: opts.suffix } : {}),
          ...(hyperparameters ? { hyperparameters } : {}),
          ...(opts.project ? { projectId: opts.project } : {}),
        }),
      })) as { data: { job: Job } };
      const j = body.data.job;
      if (opts.json) {
        console.log(JSON.stringify(j, null, 2));
        return;
      }
      console.log(chalk.green(`  ✓ Submitted ${j.id}`));
      console.log(`  ${chalk.dim("provider:    ")} ${j.provider}`);
      console.log(`  ${chalk.dim("base:        ")} ${j.base_model}`);
      console.log(`  ${chalk.dim("status:      ")} ${colorize(j.status)(j.status)}`);
      console.log(chalk.dim(`  Poll status with: evalguard fine-tune get ${j.id}`));
    });

  cmd
    .command("cancel <jobId>")
    .description("Cancel an in-flight fine-tuning job (idempotent — terminal jobs return as-is)")
    .option("--json", "Output as JSON", false)
    .action(async (jobId: string, opts: { json?: boolean }) => {
      const body = (await apiFetch(`/fine-tune/jobs/${encodeURIComponent(jobId)}/cancel`, {
        method: "POST",
        body: "{}",
      })) as { data: { job: Job; alreadyTerminal?: boolean } };
      const j = body.data.job;
      if (opts.json) {
        console.log(JSON.stringify(body.data, null, 2));
        return;
      }
      if (body.data.alreadyTerminal) {
        console.log(chalk.dim(`  Job ${j.id} is already ${j.status} — no-op.`));
        return;
      }
      console.log(chalk.green(`  ✓ Cancelled ${j.id}`));
      console.log(`  ${chalk.dim("status:      ")} ${colorize(j.status)(j.status)}`);
    });

  cmd
    .command("get <jobId>")
    .description("Fetch a single fine-tuning job by id")
    .option("--json", "Output as JSON", false)
    .action(async (jobId: string, opts: { json?: boolean }) => {
      const body = (await apiFetch(`/fine-tune/jobs/${encodeURIComponent(jobId)}`)) as {
        data: { job: Job & { hyperparameters: Record<string, unknown>; events: unknown[] } };
      };
      const j = body.data.job;
      if (opts.json) {
        console.log(JSON.stringify(j, null, 2));
        return;
      }
      const c = colorize(j.status);
      console.log();
      console.log(`  ${chalk.bold(j.id)}`);
      console.log(`  ${chalk.dim("status:    ")} ${c(j.status)}`);
      console.log(`  ${chalk.dim("provider:  ")} ${j.provider}`);
      console.log(`  ${chalk.dim("base:      ")} ${j.base_model}`);
      if (j.fine_tuned_model) {
        console.log(`  ${chalk.dim("output:    ")} ${chalk.green(j.fine_tuned_model)}`);
      }
      console.log(`  ${chalk.dim("cases:     ")} ${j.case_count}`);
      if (j.trained_tokens != null) {
        console.log(`  ${chalk.dim("tokens:    ")} ${j.trained_tokens.toLocaleString()}`);
      }
      if (j.estimated_cost != null) {
        console.log(`  ${chalk.dim("cost:      ")} $${Number(j.estimated_cost).toFixed(2)}`);
      }
      if (j.error_message) {
        console.log(`  ${chalk.dim("error:     ")} ${chalk.red(j.error_message)}`);
      }
      console.log(`  ${chalk.dim("created:   ")} ${new Date(j.created_at).toLocaleString()}`);
      if (j.finished_at) {
        console.log(`  ${chalk.dim("finished:  ")} ${new Date(j.finished_at).toLocaleString()}`);
      }
      console.log();
    });
}
