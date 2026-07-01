/**
 * `evalguard red-team-plan` — capability-driven red-team planning.
 *
 *   evalguard red-team-plan --mcp --code --pii [--json]
 *
 * Describe what an agent can do via flags; the planner returns the attack
 * categories + concrete plugins that apply. Wraps POST /security/red-team-plan.
 * Auth uses the shared resolver: env EVALGUARD_API_KEY > the stored credential
 * from `evalguard login` (~/.evalguard/config.json) — consistent with every
 * other authed command (live-E2E 2026-06-21: this command alone ignored the
 * stored login and demanded the env var).
 */
import { Command } from "commander";
import chalk from "chalk";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";

function baseUrl(): string {
  return resolveBaseUrl();
}
function apiKey(): string {
  const k = resolveApiKey();
  if (!k) {
    console.error(
      chalk.red("Not authenticated. Run `evalguard login` (or set EVALGUARD_API_KEY)."),
    );
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
  if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  return body;
}

interface RedTeamPlan {
  categories: { id: string; name: string; pluginCount: number }[];
  plugins: { id: string; name: string; severity: string; category: string }[];
  totalPlugins: number;
}

interface PlanOpts {
  tools?: boolean;
  code?: boolean;
  db?: boolean;
  mcp?: boolean;
  memory?: boolean;
  conversational?: boolean;
  multimodal?: boolean;
  pii?: boolean;
  network?: boolean;
  advice?: boolean;
  systemPrompt?: boolean;
  json?: boolean;
}

export function registerRedTeam(program: Command): void {
  program
    .command("red-team-plan")
    .description("Select the red-team attacks that apply to an agent's described capabilities")
    .option("--tools", "Agent uses tools/functions with side effects")
    .option("--code", "Agent generates/executes code")
    .option("--db", "Agent queries a database")
    .option("--mcp", "Agent speaks the Model Context Protocol")
    .option("--memory", "Agent has long-term memory or RAG")
    .option("--conversational", "Agent holds multi-turn conversations")
    .option("--multimodal", "Agent accepts/produces images/audio/video")
    .option("--pii", "Agent processes personal/sensitive data")
    .option("--network", "Agent makes outbound network requests")
    .option("--advice", "Agent gives regulated professional advice")
    .option("--system-prompt", "Agent runs behind a confidential system prompt")
    .option("--json", "Output the raw plan as JSON", false)
    .action(async (opts: PlanOpts) => {
      const caps = {
        usesTools: !!opts.tools,
        executesCode: !!opts.code,
        queriesDatabase: !!opts.db,
        usesMcp: !!opts.mcp,
        hasMemoryOrRag: !!opts.memory,
        isConversational: !!opts.conversational,
        isMultimodal: !!opts.multimodal,
        handlesPii: !!opts.pii,
        makesNetworkRequests: !!opts.network,
        givesProfessionalAdvice: !!opts.advice,
        hasSystemPrompt: !!opts.systemPrompt,
      };
      const body = (await apiFetch("/security/red-team-plan", {
        method: "POST",
        body: JSON.stringify(caps),
      })) as { data: { plan: RedTeamPlan } };
      const plan = body.data.plan;
      if (opts.json) {
        console.log(JSON.stringify(plan, null, 2));
        return;
      }
      console.log(
        chalk.bold(`Red-team plan — ${plan.totalPlugins} plugins across ${plan.categories.length} categories`),
      );
      for (const c of plan.categories) {
        console.log(`  ${chalk.cyan(c.id.padEnd(24))} ${String(c.pluginCount).padStart(3)} plugins  ${chalk.dim(c.name)}`);
      }
    });
}
