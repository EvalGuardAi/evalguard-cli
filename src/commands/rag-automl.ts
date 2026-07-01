/**
 * `evalguard rag-automl run <config.json>` — combinatorial RAG node search →
 * reproducible IR-metric (nDCG / MAP / MRR) leaderboard.
 *
 * Surfaces the RAG AutoML route (POST /api/v1/experiments/rag-automl) on the
 * terminal. The server enumerates the Cartesian product of the discrete
 * `searchSpace`, scores each config's submitted retrieval `runs` against the
 * shared ground-truth `qrels`, ranks the leaderboard, and persists the study
 * for replay. The CLI just submits the config file and renders the leaderboard:
 *
 *   evalguard rag-automl run study.json
 *   evalguard rag-automl run study.json --json
 *   evalguard rag-automl list --project <projectId>
 *   evalguard rag-automl get <studyId> --project <projectId>
 *
 * The config file is the POST body the route already validates (projectId,
 * name, searchSpace, qrels, runs, optional objective/objectiveK/ks/maxConfigs).
 * The CLI does NOT re-implement the search engine or IR metrics — the server
 * owns the @evalguard/core rag-automl engine; the CLI is a thin client.
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import * as path from "path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function baseUrl(): string {
  return process.env.EVALGUARD_BASE_URL ?? "https://evalguard.ai/api/v1";
}

function apiKey(): string {
  const k = process.env.EVALGUARD_API_KEY;
  if (!k) {
    console.error(
      chalk.red("EVALGUARD_API_KEY is not set. Run `evalguard login` first or export the key."),
    );
    process.exit(1);
  }
  return k;
}

export interface RagAutoMLLeaderboardEntry {
  rank: number;
  configIndex: number;
  config: Record<string, unknown>;
  objectiveValue: number | null;
  metrics?: unknown;
  failureReason?: string;
}

export interface RagAutoMLStudy {
  id: string;
  name: string;
  status: string;
  objective: string;
  objectiveK: number;
  ks?: number[];
  totalConfigs: number;
  evaluatedConfigs: number;
  failedConfigs: number;
  bestConfig: Record<string, unknown> | null;
  bestObjectiveValue: number | null;
  leaderboard?: RagAutoMLLeaderboardEntry[];
  message?: string;
}

async function unwrap<T>(res: Response, label: string): Promise<T> {
  const json = (await res.json().catch(() => ({}))) as {
    data?: T;
    error?: { message?: string; code?: string };
  };
  if (!res.ok) {
    throw new Error(
      `${label} failed: HTTP ${res.status} (${json.error?.code ?? "ERROR"}: ${json.error?.message ?? "unknown"})`,
    );
  }
  return (json.data ?? (json as unknown as T)) as T;
}

/** POST a RAG AutoML study config → ranked leaderboard. Pure + testable. */
export async function runRagAutoMLStudy(opts: {
  config: unknown;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<RagAutoMLStudy> {
  const cfg = opts.config as { projectId?: unknown };
  if (typeof cfg?.projectId !== "string" || !UUID_RE.test(cfg.projectId)) {
    throw new Error("config.projectId must be a valid project UUID");
  }
  const fetchFn = opts.fetchImpl ?? fetch;
  const res = await fetchFn(`${opts.baseUrl}/experiments/rag-automl`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(opts.config),
  });
  return unwrap<RagAutoMLStudy>(res, "RAG AutoML run");
}

/** GET the list of studies for a project. Pure + testable. */
export async function listRagAutoMLStudies(opts: {
  projectId: string;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<unknown[]> {
  if (!UUID_RE.test(opts.projectId)) {
    throw new Error(`projectId must be a valid UUID. Got: ${opts.projectId}`);
  }
  const fetchFn = opts.fetchImpl ?? fetch;
  const res = await fetchFn(
    `${opts.baseUrl}/experiments/rag-automl?projectId=${encodeURIComponent(opts.projectId)}`,
    { method: "GET", headers: { authorization: `Bearer ${opts.apiKey}` } },
  );
  return unwrap<unknown[]>(res, "RAG AutoML list");
}

/** GET one study + its full ranked leaderboard (replay). Pure + testable. */
export async function getRagAutoMLStudy(opts: {
  studyId: string;
  projectId: string;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<RagAutoMLStudy> {
  if (!UUID_RE.test(opts.projectId)) {
    throw new Error(`projectId must be a valid UUID. Got: ${opts.projectId}`);
  }
  const fetchFn = opts.fetchImpl ?? fetch;
  const params = new URLSearchParams({ projectId: opts.projectId, studyId: opts.studyId });
  const res = await fetchFn(`${opts.baseUrl}/experiments/rag-automl?${params.toString()}`, {
    method: "GET",
    headers: { authorization: `Bearer ${opts.apiKey}` },
  });
  return unwrap<RagAutoMLStudy>(res, "RAG AutoML get");
}

function printLeaderboard(study: RagAutoMLStudy): void {
  console.log();
  console.log(chalk.bold.cyan("  EvalGuard") + chalk.dim(" — RAG AutoML leaderboard"));
  console.log(chalk.dim("  ─────────────────────────────────────────────"));
  console.log();
  console.log(`  Study:     ${chalk.cyan(study.name)} ${chalk.dim(`(${study.id})`)}`);
  console.log(`  Status:    ${study.status}`);
  console.log(`  Objective: ${chalk.bold(`${study.objective}@${study.objectiveK}`)}`);
  console.log(
    `  Configs:   ${chalk.green(String(study.evaluatedConfigs))} evaluated, ` +
      `${chalk.red(String(study.failedConfigs))} failed, ${study.totalConfigs} total`,
  );
  console.log();

  const board = study.leaderboard ?? [];
  if (board.length === 0) {
    console.log(chalk.dim("  No leaderboard rows returned."));
  } else {
    for (const e of board.slice(0, 20)) {
      const score =
        e.objectiveValue == null ? chalk.dim("n/a") : chalk.bold((e.objectiveValue).toFixed(4));
      const rankColor = e.rank === 1 ? chalk.green : chalk.dim;
      const cfg = JSON.stringify(e.config);
      const fail = e.failureReason ? chalk.red(`  [${e.failureReason}]`) : "";
      console.log(`  ${rankColor(`#${String(e.rank).padEnd(3)}`)} ${score}  ${chalk.dim(cfg)}${fail}`);
    }
    if (board.length > 20) console.log(chalk.dim(`  … ${board.length - 20} more`));
  }
  console.log();
  if (study.message) console.log(chalk.dim(`  ${study.message}`));
  console.log();
}

export function registerRagAutoML(program: Command): void {
  const cmd = program
    .command("rag-automl")
    .description("Combinatorial RAG node search → reproducible IR-metric (nDCG/MAP/MRR) leaderboard");

  cmd
    .command("run")
    .description("Submit a RAG AutoML study config (JSON) and render the ranked leaderboard")
    .argument("<config>", "Path to a study config JSON (projectId, name, searchSpace, qrels, runs, …)")
    .option("--json", "Output the full study + leaderboard as JSON", false)
    .action(async (configPath: string, opts: { json?: boolean }) => {
      const resolved = path.resolve(configPath);
      if (!fs.existsSync(resolved)) {
        console.error(chalk.red(`Config file not found: ${resolved}`));
        process.exit(1);
      }
      let config: unknown;
      try {
        config = JSON.parse(fs.readFileSync(resolved, "utf-8"));
      } catch (err) {
        console.error(chalk.red(`Invalid JSON in ${resolved}: ${(err as Error).message}`));
        process.exit(1);
      }

      let study: RagAutoMLStudy;
      try {
        study = await runRagAutoMLStudy({ config, baseUrl: baseUrl(), apiKey: apiKey() });
      } catch (err) {
        console.error(chalk.red(`  ${(err as Error).message}`));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(study, null, 2));
        return;
      }
      printLeaderboard(study);
    });

  cmd
    .command("list")
    .description("List RAG AutoML studies for a project (newest first)")
    .requiredOption("-p, --project <projectId>", "Project UUID")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { project: string; json?: boolean }) => {
      let studies: unknown[];
      try {
        studies = await listRagAutoMLStudies({ projectId: opts.project, baseUrl: baseUrl(), apiKey: apiKey() });
      } catch (err) {
        console.error(chalk.red(`  ${(err as Error).message}`));
        process.exit(1);
      }
      if (opts.json) {
        console.log(JSON.stringify(studies, null, 2));
        return;
      }
      console.log();
      if (studies.length === 0) {
        console.log(chalk.dim("  No RAG AutoML studies for this project."));
        console.log();
        return;
      }
      for (const s of studies as Array<Record<string, unknown>>) {
        console.log(
          `  ${chalk.cyan(String(s.id))}  ${chalk.bold(String(s.name))}  ` +
            chalk.dim(`${String(s.objective)}@${String(s.objective_k ?? "")} • ${String(s.status)}`),
        );
      }
      console.log();
    });

  cmd
    .command("get")
    .description("Fetch one study + its full ranked leaderboard (replay)")
    .argument("<studyId>", "Study UUID")
    .requiredOption("-p, --project <projectId>", "Project UUID")
    .option("--json", "Output as JSON", false)
    .action(async (studyId: string, opts: { project: string; json?: boolean }) => {
      let study: RagAutoMLStudy;
      try {
        study = await getRagAutoMLStudy({ studyId, projectId: opts.project, baseUrl: baseUrl(), apiKey: apiKey() });
      } catch (err) {
        console.error(chalk.red(`  ${(err as Error).message}`));
        process.exit(1);
      }
      if (opts.json) {
        console.log(JSON.stringify(study, null, 2));
        return;
      }
      printLeaderboard(study);
    });
}
