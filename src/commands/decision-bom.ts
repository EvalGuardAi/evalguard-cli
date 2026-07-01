/**
 * `evalguard decision-bom verify <id>` — fetch + verify a signed Decision-BOM.
 *
 * Surfaces the Decision Bill-of-Materials verification route
 * (GET /api/v1/compliance/decision-bom/[id]) on the terminal. A Decision-BOM
 * is EvalGuard's cryptographically tamper-evident "why-allow / why-block"
 * artifact — it records the verdict plus every firewall layer / guardrail rule
 * that fired (with per-contribution scores + weights), the model/policy
 * versions, and input/output digests, all Ed25519-signed.
 *
 * The server RE-VERIFIES the Ed25519 signature server-side from the persisted
 * envelope and returns a `verification` block. This command prints that
 * verdict (VALID / TAMPERED) and exits non-zero when the signature does not
 * verify, so it can gate a forensic / audit pipeline:
 *
 *   evalguard decision-bom verify <bomId>
 *   evalguard decision-bom verify <bomId> --json
 *
 * Verification is the SERVER's job (it holds the canonical row + key) — the
 * CLI does not re-implement Ed25519; it surfaces the server's result.
 */
import { Command } from "commander";
import chalk from "chalk";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function baseUrl(): string {
  return resolveBaseUrl();
}

function apiKey(): string {
  const k = resolveApiKey();
  if (!k) {
    console.error(
      chalk.red("No EvalGuard API key found. Run `evalguard login --key <key>` first or set EVALGUARD_API_KEY."),
    );
    process.exit(1);
  }
  return k;
}

/** Shape of the fields this command reads from the server response. */
export interface DecisionBomVerifyResult {
  id: string;
  decisionId: string;
  surface: string;
  verdict: string;
  category: string;
  signedAt: string;
  createdAt: string;
  bom: unknown;
  signature: { algorithm: string; value: string; publicKeyPem: string };
  verification: { valid: boolean; reason?: string };
}

/**
 * Pure, unit-testable fetcher. Hits the server, unwraps the standard
 * `{ data }` envelope, and returns the verification result. Throws on bad
 * input / network / 4xx / 5xx.
 */
export async function fetchDecisionBomVerify(opts: {
  id: string;
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<DecisionBomVerifyResult> {
  if (!UUID_RE.test(opts.id)) {
    throw new Error(`decision-bom id must be a valid UUID. Got: ${opts.id}`);
  }
  const fetchFn = opts.fetchImpl ?? fetch;
  const res = await fetchFn(`${opts.baseUrl}/compliance/decision-bom/${encodeURIComponent(opts.id)}`, {
    method: "GET",
    headers: { authorization: `Bearer ${opts.apiKey}`, accept: "application/json" },
  });

  const json = (await res.json().catch(() => ({}))) as {
    data?: DecisionBomVerifyResult;
    error?: { message?: string; code?: string };
  };

  if (!res.ok) {
    throw new Error(
      `Decision-BOM verify failed: HTTP ${res.status} (${json.error?.code ?? "ERROR"}: ${json.error?.message ?? "unknown"})`,
    );
  }
  const data = json.data ?? (json as unknown as DecisionBomVerifyResult);
  if (!data || typeof data.verification?.valid !== "boolean") {
    throw new Error("Decision-BOM verify failed: malformed server response (no verification block)");
  }
  return data;
}

export function registerDecisionBom(program: Command): void {
  const cmd = program
    .command("decision-bom")
    .description("Fetch + verify signed Decision Bill-of-Materials (why-allow / why-block) artifacts");

  cmd
    .command("verify")
    .description("Fetch a Decision-BOM by id and re-verify its Ed25519 signature (exits 1 if tampered)")
    .argument("<id>", "Decision-BOM UUID")
    .option("--json", "Output the full server response as JSON", false)
    .action(async (id: string, opts: { json?: boolean }) => {
      let result: DecisionBomVerifyResult;
      try {
        result = await fetchDecisionBomVerify({ id, baseUrl: baseUrl(), apiKey: apiKey() });
      } catch (err) {
        console.error(chalk.red(`  ${(err as Error).message}`));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        process.exit(result.verification.valid ? 0 : 1);
      }

      const valid = result.verification.valid;
      const statusColor = valid ? chalk.green : chalk.red;
      const verdictColor = result.verdict === "block" ? chalk.red : result.verdict === "flag" ? chalk.yellow : chalk.green;

      console.log();
      console.log(chalk.bold.cyan("  EvalGuard") + chalk.dim(" — Decision-BOM verification"));
      console.log(chalk.dim("  ─────────────────────────────────────────────"));
      console.log();
      console.log(`  BOM id:    ${chalk.cyan(result.id)}`);
      console.log(`  Decision:  ${chalk.cyan(result.decisionId)}`);
      console.log(`  Surface:   ${result.surface}`);
      console.log(`  Verdict:   ${verdictColor(result.verdict.toUpperCase())} ${chalk.dim(`(${result.category})`)}`);
      console.log(`  Signed:    ${chalk.dim(result.signedAt)} (${result.signature.algorithm})`);
      console.log();
      console.log(`  ${statusColor("●")} Signature: ${statusColor(valid ? "VALID — artifact intact" : "TAMPERED / INVALID")}`);
      if (!valid && result.verification.reason) {
        console.log(chalk.red(`    ${result.verification.reason}`));
      }
      console.log();

      process.exit(valid ? 0 : 1);
    });
}
