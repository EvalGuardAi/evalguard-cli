/**
 * `evalguard siem` — bidirectional SIEM integration (Gap #6).
 *
 *   evalguard siem:tokens:list --project <id>
 *   evalguard siem:tokens:create --source <splunk|sentinel|qradar|generic_webhook> --label <name> [--actions <list>] --project <id>
 *   evalguard siem:tokens:revoke <tokenId> --project <id>
 */
import { Command } from "commander";
import chalk from "chalk";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";
import { boundedFetch, decodeJsonBody } from "../lib/http.js";

function baseUrl(): string { return resolveBaseUrl(); }
function apiKey(): string {
  const k = resolveApiKey();
  if (!k) { console.error(chalk.red("No EvalGuard API key found. Run `evalguard login --key <key>` or set EVALGUARD_API_KEY.")); process.exit(1); }
  return k;
}
async function apiFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await boundedFetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey()}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await decodeJsonBody(res, `${path}`);
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

export function registerSiem(program: Command): void {
  const cmd = program.command("siem").description("Bidirectional SIEM — mint inbound-webhook tokens for Splunk/Sentinel/QRadar");
  const tokens = cmd.command("tokens").description("Manage inbound-webhook HMAC tokens");

  tokens
    .command("list")
    .requiredOption("--project <projectId>", "Project ID")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { project: string; json?: boolean }) => {
      const body = (await apiFetch(`/siem/inbound/tokens?projectId=${encodeURIComponent(opts.project)}`)) as {
        success: boolean;
        data: { tokens: Array<{ id: string; source: string; label: string; allowed_actions: string[]; revoked: boolean; last_used_at: string | null; created_at: string }>; total: number };
      };
      if (opts.json) { console.log(JSON.stringify(body.data.tokens, null, 2)); return; }
      if (body.data.total === 0) { console.log(chalk.dim("No tokens.")); return; }
      console.log(chalk.bold("\nID                                    Source          Label            Actions                     Revoked"));
      for (const t of body.data.tokens) {
        console.log(`  ${t.id}  ${t.source.padEnd(14)} ${t.label.padEnd(16)} ${t.allowed_actions.join(",").padEnd(28)} ${t.revoked}`);
      }
    });

  tokens
    .command("create")
    .requiredOption("--source <source>", "splunk | sentinel | qradar | generic_webhook")
    .requiredOption("--label <label>", "Human-readable label (3-64 chars)")
    .option("--actions <list>", "Comma-separated allowed actions", "quarantine_key")
    .option("--rate-limit <n>", "Max inbound actions per minute", "30")
    .requiredOption("--project <projectId>", "Project ID")
    .action(async (opts: { source: string; label: string; actions: string; rateLimit: string; project: string }) => {
      const body = (await apiFetch(`/siem/inbound/tokens`, {
        method: "POST",
        body: JSON.stringify({
          source: opts.source,
          label: opts.label,
          allowedActions: opts.actions.split(",").map((a) => a.trim()).filter(Boolean),
          rateLimitPerMin: Number(opts.rateLimit),
          projectId: opts.project,
        }),
      })) as { success: boolean; data: { token: { id: string; hmacSecret: string }; note: string } };
      console.log(chalk.green(`✓ Token created: ${body.data.token.id}`));
      console.log();
      console.log(chalk.bold("HMAC secret (shown exactly once — save it now):"));
      console.log(chalk.yellow(`  ${body.data.token.hmacSecret}`));
      console.log();
      console.log(chalk.dim(body.data.note));
    });

  tokens
    .command("revoke <tokenId>")
    .requiredOption("--project <projectId>", "Project ID")
    .option("-y, --yes", "Skip confirmation", false)
    .option("--dry-run", "Show the token that would be revoked without changing anything", false)
    .action(async (tokenId: string, opts: { project: string; yes?: boolean; dryRun?: boolean }) => {
      // T1.4b (2026-05-20): revoking a SIEM token cuts the inbound
      // webhook for Splunk/Sentinel/QRadar — incidents stop flowing
      // until a new token is minted + plumbed. --dry-run + --yes
      // are required guard rails before this action runs.
      if (opts.dryRun) {
        const body = (await apiFetch(
          `/siem/inbound/tokens?id=${encodeURIComponent(tokenId)}&projectId=${encodeURIComponent(opts.project)}`,
        )) as {
          success: boolean;
          data: {
            token?: {
              id: string;
              source: string;
              label: string;
              allowed_actions: string[];
              revoked: boolean;
              last_used_at: string | null;
            };
          };
        };
        const t = body.data.token;
        console.log();
        console.log(chalk.dim("  [dry-run]") + " The following token WOULD be revoked:");
        if (!t) {
          console.log(chalk.yellow(`  Token ${tokenId} not found.`));
        } else if (t.revoked) {
          console.log(chalk.yellow(`  Token ${tokenId} is already revoked — no-op.`));
        } else {
          console.log(`  ${chalk.dim("Id")}        ${t.id}`);
          console.log(`  ${chalk.dim("Source")}    ${t.source}`);
          console.log(`  ${chalk.dim("Label")}     ${t.label}`);
          console.log(`  ${chalk.dim("Actions")}   ${t.allowed_actions.join(", ")}`);
          console.log(`  ${chalk.dim("Last used")} ${t.last_used_at ?? "never"}`);
        }
        console.log(chalk.dim("  No changes written."));
        console.log();
        return;
      }
      if (!opts.yes) {
        console.error(chalk.yellow(`Pass --yes to confirm revocation of ${tokenId}, or --dry-run to preview.`));
        process.exit(1);
      }
      await apiFetch(`/siem/inbound/tokens?id=${encodeURIComponent(tokenId)}&projectId=${encodeURIComponent(opts.project)}`, { method: "DELETE" });
      console.log(chalk.green(`✓ Token revoked: ${tokenId}`));
    });
}
