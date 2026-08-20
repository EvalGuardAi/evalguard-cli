/**
 * `evalguard models` — model-scan promote + CycloneDX-ML attestation (Gap #1).
 *
 *   evalguard models:promote <scanId> --to-env <env> [--override --reason "..."]
 *   evalguard models:attestation <scanId> [--out <file.json>]
 */
import { Command } from "commander";
import chalk from "chalk";
import * as fs from "fs";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";
import { boundedFetch, decodeJsonBody, expectObject, expectResult } from "../lib/http.js";

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

export function registerModelsPromote(program: Command): void {
  const cmd = program.command("models").description("Model-scan governance — promote scanned weights + fetch CycloneDX-ML attestations");

  cmd
    .command("promote <scanId>")
    .description("Promote a scanned model to a deployment environment (verdict-gated)")
    .requiredOption("--to-env <env>", "Target environment (staging | prod | ...)")
    .option("--from-env <env>", "Source environment")
    .option("--override", "Force-promote suspicious/malicious scans", false)
    .option("--reason <text>", "Justification (required when --override; >=8 chars)")
    .action(async (scanId: string, opts: { toEnv: string; fromEnv?: string; override?: boolean; reason?: string }) => {
      const body = (await apiFetch(`/security/model-scan/${encodeURIComponent(scanId)}/promote`, {
        method: "POST",
        body: JSON.stringify({
          toEnv: opts.toEnv,
          fromEnv: opts.fromEnv,
          override: opts.override ?? false,
          reason: opts.reason,
        }),
      })) as { success: boolean; data: { decision: string; toEnv: string; gateStatus: string } };
      console.log(chalk.green(`✓ ${body.data.decision} → ${body.data.toEnv} (gate=${body.data.gateStatus})`));
    });

  cmd
    .command("attestation <scanId>")
    .description("Fetch the CycloneDX-ML attestation document for a scan")
    .option("--out <file>", "Write JSON to file instead of stdout")
    .action(async (scanId: string, opts: { out?: string }) => {
      // A CycloneDX-ML ATTESTATION is a supply-chain artifact. `body.data.attestation`
      // was `undefined` for a 200 carrying `{"success":true,"data":{}}`, and
      // `JSON.stringify(undefined)` is the string "undefined" — which this command
      // printed, or wrote to `--out`, with exit 0.
      const result = expectResult<{ attestation: Record<string, unknown>; cached?: boolean }>(
        await apiFetch(`/security/model-scan/${encodeURIComponent(scanId)}/attestation`),
        "GET /security/model-scan/:id/attestation",
        ["attestation"],
      );
      const json = JSON.stringify(
        expectObject(result.attestation, "GET /security/model-scan/:id/attestation"),
        null,
        2,
      );
      if (opts.out) {
        fs.writeFileSync(opts.out, json);
        console.log(chalk.green(`✓ Attestation written to ${opts.out} (${(json.length / 1024).toFixed(1)} KB, cached=${result.cached ?? false})`));
      } else {
        console.log(json);
      }
    });
}
