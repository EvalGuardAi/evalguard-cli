/**
 * `evalguard keys` — manage BYOK provider API keys stored in the vault.
 *
 *   evalguard keys:list [--org <orgId>]
 *   evalguard keys:add <provider> [--label <label>]
 *      reads the plaintext key from stdin or --key-file so it never
 *      appears in your shell history.
 *   evalguard keys:remove <key-id>
 *
 * Plaintext goes directly to Supabase Vault (libsodium envelope) on the
 * server; our CLI never logs it and responses contain only metadata.
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import { createInterface } from "readline";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";

interface ProviderKey {
  id: string;
  provider: string;
  project_id: string | null;
  label: string | null;
  key_last4: string | null;
  created_at: string;
  rotated_at: string | null;
}

function baseUrl(): string {
  return resolveBaseUrl();
}

function apiKey(): string {
  const k = resolveApiKey();
  if (!k) {
    console.error(
      chalk.red(
        "No EvalGuard API key found. Run `evalguard login --key <key>` or set EVALGUARD_API_KEY.",
      ),
    );
    process.exit(1);
  }
  return k;
}

function orgIdFromOpts(opts: { org?: string }): string {
  const id = opts.org ?? process.env.EVALGUARD_ORG_ID;
  if (!id) {
    console.error(chalk.red("Provide --org <orgId> or set EVALGUARD_ORG_ID."));
    process.exit(1);
  }
  return id;
}

async function readPlaintextFromStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, terminal: false });
    const chunks: string[] = [];
    rl.on("line", (l) => chunks.push(l));
    rl.on("close", () => resolve(chunks.join("\n").trim()));
    rl.on("error", reject);
  });
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
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } })?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body;
}

export function registerKeys(program: Command): void {
  const keys = program
    .command("keys")
    .description("Manage BYOK provider API keys (stored in Supabase Vault)");

  keys
    .command("list")
    .description("List BYOK keys in your org (metadata only; plaintext never leaves the vault)")
    .option("--org <orgId>", "Organization ID (or set EVALGUARD_ORG_ID)")
    .option("--project <projectId>", "Filter to a specific project")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { org?: string; project?: string; json?: boolean }) => {
      const orgId = orgIdFromOpts(opts);
      const qs = new URLSearchParams({ orgId });
      if (opts.project) qs.set("projectId", opts.project);
      const body = (await apiFetch(`/provider-keys?${qs}`)) as {
        success: boolean;
        data: { keys: ProviderKey[]; total: number };
      };
      const rows = body.data.keys;
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log(chalk.dim("No keys stored yet."));
        return;
      }
      console.log();
      console.log(chalk.bold(" Provider       Label            Last-4   Scope          Rotated"));
      console.log(chalk.dim(" ───────────    ───────────      ──────   ─────────────  ───────"));
      for (const k of rows) {
        const scope = k.project_id ? "project" : "org-default";
        const last4 = k.key_last4 ? `…${k.key_last4}` : "—";
        const rotated = k.rotated_at ? new Date(k.rotated_at).toISOString().slice(0, 10) : "—";
        console.log(
          ` ${k.provider.padEnd(14)} ${(k.label ?? "—").padEnd(16)} ${last4.padEnd(8)} ${scope.padEnd(14)} ${rotated}`,
        );
      }
      console.log();
    });

  keys
    .command("add")
    .description("Add or rotate a BYOK key. Plaintext is read from stdin or --key-file.")
    .argument("<provider>", "Provider name (openai, anthropic, groq, ...)")
    .option("--org <orgId>", "Organization ID (or set EVALGUARD_ORG_ID)")
    .option("--project <projectId>", "Scope this key to a specific project (vs org-default)")
    .option("--label <label>", "Human-readable label")
    .option("--key-file <path>", "Read plaintext from file instead of stdin")
    .action(
      async (
        provider: string,
        opts: { org?: string; project?: string; label?: string; keyFile?: string },
      ) => {
        const orgId = orgIdFromOpts(opts);

        let plaintext: string;
        if (opts.keyFile) {
          plaintext = fs.readFileSync(opts.keyFile, "utf-8").trim();
        } else {
          if (process.stdin.isTTY) {
            console.error(
              chalk.yellow(
                "Paste key and press Ctrl-D (Ctrl-Z on Windows). Avoid typing it directly — use --key-file or shell redirection for safety.",
              ),
            );
          }
          plaintext = await readPlaintextFromStdin();
        }
        if (!plaintext || plaintext.length < 8) {
          console.error(chalk.red("Plaintext key is empty or too short to be valid."));
          process.exit(1);
        }

        const body = (await apiFetch("/provider-keys", {
          method: "POST",
          body: JSON.stringify({
            orgId,
            provider,
            apiKey: plaintext,
            projectId: opts.project,
            label: opts.label,
          }),
        })) as { success: boolean; data: { key: ProviderKey; rotated: boolean } };

        const k = body.data.key;
        const verb = body.data.rotated ? "rotated" : "stored";
        console.log(chalk.green(`✓ ${verb} ${k.provider} key (last-4 …${k.key_last4 ?? "????"})`));
        console.log(chalk.dim(`  id: ${k.id}`));
      },
    );

  keys
    .command("remove")
    .description("Revoke a BYOK key. Cannot be undone.")
    .argument("<key-id>", "Key id (from `evalguard keys list`)")
    .option("--org <orgId>", "Organization ID (or set EVALGUARD_ORG_ID)")
    .option("-y, --yes", "Skip confirmation", false)
    .option("--dry-run", "Show the key that would be revoked without changing anything", false)
    .action(async (keyId: string, opts: { org?: string; yes?: boolean; dryRun?: boolean }) => {
      // T1.4b (2026-05-20): revoking a key is destructive + can immediately
      // break running workloads that still hold its plaintext. --dry-run
      // lets an operator preview the target key (provider, label, last4)
      // before pulling the trigger.
      const orgId = orgIdFromOpts(opts);
      if (opts.dryRun) {
        const body = (await apiFetch(
          `/provider-keys?id=${keyId}&orgId=${orgId}`,
        )) as { success: boolean; data: { key?: ProviderKey } };
        const k = body.data.key;
        console.log();
        console.log(chalk.dim("  [dry-run]") + " The following key WOULD be revoked:");
        if (!k) {
          console.log(chalk.yellow(`  Key ${keyId} not found (or already revoked).`));
        } else {
          console.log(`  ${chalk.dim("Id")}        ${k.id}`);
          console.log(`  ${chalk.dim("Provider")}  ${k.provider}`);
          console.log(`  ${chalk.dim("Label")}     ${k.label ?? "—"}`);
          console.log(`  ${chalk.dim("Last-4")}    ${k.key_last4 ? `…${k.key_last4}` : "—"}`);
          console.log(`  ${chalk.dim("Scope")}     ${k.project_id ? "project " + k.project_id : "org-default"}`);
        }
        console.log(chalk.dim("  No changes written."));
        console.log();
        return;
      }
      if (!opts.yes) {
        console.error(chalk.yellow(`Pass --yes to confirm revocation of ${keyId}, or --dry-run to preview.`));
        process.exit(1);
      }
      await apiFetch(`/provider-keys?id=${keyId}&orgId=${orgId}`, { method: "DELETE" });
      console.log(chalk.green(`✓ revoked ${keyId}`));
    });
}
