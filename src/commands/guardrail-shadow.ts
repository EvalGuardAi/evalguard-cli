/**
 * `evalguard guardrail-shadow` — live-traffic guardrail A/B (RB-9).
 *
 *   evalguard guardrail-shadow create   --org <id> --project <id> --name <n>
 *                                       [--shadow-sensitivity <s>] [--shadow-rules <csv>]
 *                                       [--enforcing-sensitivity <s>] [--enforcing-rules <csv>] [--json]
 *   evalguard guardrail-shadow list     --org <id> --project <id> [--json]
 *   evalguard guardrail-shadow evaluate --org <id> --project <id> --config <id> --content <text> [--field input|output] [--json]
 *   evalguard guardrail-shadow rm       --org <id> --config <id> [--json]
 *
 * `evaluate` runs one sample through the config's enforcing + shadow firewall
 * settings and prints how they diverge. Feed it traffic samples / a CI corpus to
 * decide whether a guardrail change is safe to promote.
 */
import { Command } from "commander";
import chalk from "chalk";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SENS = ["monitor", "balanced", "strict", "lockdown"] as const;
export type ShadowSensitivity = (typeof SENS)[number];

export interface ShadowApiOpts {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

async function call(path: string, init: RequestInit, opts: ShadowApiOpts): Promise<unknown> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${opts.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

export async function createShadowConfig(
  args: {
    orgId: string;
    projectId: string;
    name: string;
    enforcingSensitivity?: ShadowSensitivity;
    enforcingRules?: string[];
    shadowSensitivity?: ShadowSensitivity;
    shadowRules?: string[];
  } & ShadowApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.orgId)) throw new Error("orgId must be a valid UUID");
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  if (!args.name) throw new Error("name is required");
  const payload: Record<string, unknown> = { orgId: args.orgId, projectId: args.projectId, name: args.name };
  if (args.enforcingSensitivity) payload.enforcingSensitivity = args.enforcingSensitivity;
  if (args.enforcingRules) payload.enforcingRules = args.enforcingRules;
  if (args.shadowSensitivity) payload.shadowSensitivity = args.shadowSensitivity;
  if (args.shadowRules) payload.shadowRules = args.shadowRules;
  return call("/gateway/guardrails/shadow", { method: "POST", body: JSON.stringify(payload) }, args);
}

export async function listShadowConfigs(
  args: { orgId: string; projectId: string } & ShadowApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  const qs = new URLSearchParams({ orgId: args.orgId, projectId: args.projectId });
  return call(`/gateway/guardrails/shadow?${qs.toString()}`, { method: "GET" }, args);
}

export async function evaluateShadow(
  args: {
    orgId: string;
    projectId: string;
    configId: string;
    content: string;
    field?: "input" | "output";
  } & ShadowApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.configId)) throw new Error("configId must be a valid UUID");
  if (!args.content) throw new Error("content is required");
  const payload: Record<string, unknown> = {
    orgId: args.orgId,
    projectId: args.projectId,
    configId: args.configId,
    content: args.content,
  };
  if (args.field) payload.field = args.field;
  return call("/gateway/guardrails/shadow/evaluate", { method: "POST", body: JSON.stringify(payload) }, args);
}

export async function deleteShadowConfig(
  args: { orgId: string; configId: string } & ShadowApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.configId)) throw new Error("configId must be a valid UUID");
  const qs = new URLSearchParams({ orgId: args.orgId, id: args.configId });
  return call(`/gateway/guardrails/shadow?${qs.toString()}`, { method: "DELETE" }, args);
}

function envConfig(): ShadowApiOpts {
  const apiKey = process.env.EVALGUARD_API_KEY;
  if (!apiKey) {
    console.error(chalk.red("EVALGUARD_API_KEY not set. Run `evalguard init`."));
    process.exit(1);
  }
  return { baseUrl: process.env.EVALGUARD_BASE_URL ?? "https://evalguard.ai/api/v1", apiKey };
}

function unwrap(body: unknown): unknown {
  return (body as { data?: unknown } | null)?.data ?? body;
}

function csv(v?: string): string[] | undefined {
  if (v === undefined) return undefined;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export function registerGuardrailShadow(program: Command): void {
  const cmd = program
    .command("guardrail-shadow")
    .description("Live-traffic guardrail A/B: compare a candidate firewall config to the live one (RB-9)");

  cmd
    .command("create")
    .description("Create a shadow guardrail config")
    .requiredOption("--org <id>", "Org UUID")
    .requiredOption("--project <id>", "Project UUID")
    .requiredOption("--name <name>", "Config name")
    .option("--enforcing-sensitivity <s>", `Live snapshot: ${SENS.join(" | ")}`)
    .option("--enforcing-rules <csv>", "Live force-block categories (comma-separated)")
    .option("--shadow-sensitivity <s>", `Candidate: ${SENS.join(" | ")}`)
    .option("--shadow-rules <csv>", "Candidate force-block categories (comma-separated)")
    .option("--json", "Output as JSON", false)
    .action(
      async (opts: {
        org: string; project: string; name: string;
        enforcingSensitivity?: string; enforcingRules?: string;
        shadowSensitivity?: string; shadowRules?: string; json?: boolean;
      }) => {
        try {
          const data = unwrap(
            await createShadowConfig({
              orgId: opts.org, projectId: opts.project, name: opts.name,
              enforcingSensitivity: opts.enforcingSensitivity as ShadowSensitivity | undefined,
              enforcingRules: csv(opts.enforcingRules),
              shadowSensitivity: opts.shadowSensitivity as ShadowSensitivity | undefined,
              shadowRules: csv(opts.shadowRules),
              ...envConfig(),
            }),
          ) as { id?: string; name?: string };
          if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }
          console.log(chalk.green(`  ✓ Created shadow config ${chalk.cyan(String(data.id))} "${data.name}"`));
        } catch (e) {
          console.error(chalk.red(e instanceof Error ? e.message : String(e)));
          process.exit(1);
        }
      },
    );

  cmd
    .command("list")
    .description("List shadow configs + their divergence stats")
    .requiredOption("--org <id>", "Org UUID")
    .requiredOption("--project <id>", "Project UUID")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { org: string; project: string; json?: boolean }) => {
      try {
        const data = unwrap(await listShadowConfigs({ orgId: opts.org, projectId: opts.project, ...envConfig() })) as Array<{
          id: string; name: string; enabled: boolean;
          stats?: { total: number; divergenceRate: number; recommendation: string };
        }>;
        if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }
        if (!Array.isArray(data) || data.length === 0) { console.log(chalk.dim("  (no shadow configs)")); return; }
        for (const c of data) {
          const on = c.enabled ? chalk.green("on") : chalk.dim("off");
          console.log(`  ${chalk.cyan(c.id)}  "${c.name}"  [${on}]  samples=${c.stats?.total ?? 0}  divergence=${((c.stats?.divergenceRate ?? 0) * 100).toFixed(1)}%`);
          if (c.stats?.recommendation) console.log(`      ${chalk.dim(c.stats.recommendation)}`);
        }
      } catch (e) {
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
    });

  cmd
    .command("evaluate")
    .description("Run one content sample through the enforcing + shadow configs and show the divergence")
    .requiredOption("--org <id>", "Org UUID")
    .requiredOption("--project <id>", "Project UUID")
    .requiredOption("--config <id>", "Shadow config UUID")
    .requiredOption("--content <text>", "Content to evaluate")
    .option("--field <field>", "input | output", "input")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { org: string; project: string; config: string; content: string; field?: string; json?: boolean }) => {
      try {
        const field = opts.field === "output" ? "output" : "input";
        const data = unwrap(
          await evaluateShadow({ orgId: opts.org, projectId: opts.project, configId: opts.config, content: opts.content, field, ...envConfig() }),
        ) as {
          divergence?: string;
          enforcing?: { blocked: boolean; category: string | null };
          shadow?: { blocked: boolean; category: string | null };
          latencyOverheadMs?: number;
        };
        if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }
        const color = data.divergence === "shadow-looser" ? chalk.red : data.divergence === "shadow-stricter" ? chalk.yellow : chalk.dim;
        console.log(`  ${chalk.dim("divergence:")} ${color(String(data.divergence))}`);
        console.log(`  ${chalk.dim("enforcing: ")} blocked=${data.enforcing?.blocked} category=${data.enforcing?.category ?? "—"}`);
        console.log(`  ${chalk.dim("shadow:    ")} blocked=${data.shadow?.blocked} category=${data.shadow?.category ?? "—"}`);
        console.log(`  ${chalk.dim("latency Δ: ")} ${data.latencyOverheadMs}ms`);
      } catch (e) {
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
    });

  cmd
    .command("rm")
    .description("Delete a shadow config")
    .requiredOption("--org <id>", "Org UUID")
    .requiredOption("--config <id>", "Shadow config UUID")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { org: string; config: string; json?: boolean }) => {
      try {
        const data = unwrap(await deleteShadowConfig({ orgId: opts.org, configId: opts.config, ...envConfig() }));
        if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }
        console.log(chalk.green("  ✓ Deleted"));
      } catch (e) {
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
    });
}
