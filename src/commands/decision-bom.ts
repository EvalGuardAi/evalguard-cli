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
import { boundedFetch, decodeJsonBody, expectResult } from "../lib/http.js";

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
  /** Everything the renderer treats as optional is TYPED optional — see the
   *  renderer note; a type that over-promises is how `verdict.toUpperCase()`
   *  passed `tsc` and threw at runtime. */
  decisionId?: string;
  surface?: string;
  verdict: string;
  category?: string;
  signedAt?: string;
  createdAt?: string;
  bom?: unknown;
  signature?: { algorithm: string; value: string; publicKeyPem: string };
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
  const fetchFn = opts.fetchImpl ?? boundedFetch;
  const res = await fetchFn(`${opts.baseUrl}/compliance/decision-bom/${encodeURIComponent(opts.id)}`, {
    method: "GET",
    headers: { authorization: `Bearer ${opts.apiKey}`, accept: "application/json" },
  });

  const json = (await decodeJsonBody(res, "decision-bom")) as {
    error?: { message?: string; code?: string };
  } | null;

  if (!res.ok) {
    throw new Error(
      `Decision-BOM verify failed: HTTP ${res.status} (${json?.error?.code ?? "ERROR"}: ${json?.error?.message ?? "unknown"})`,
    );
  }
  // `json.data ?? (json as unknown as T)` handed an unrelated 200 to the
  // renderer; the `verification.valid` guard below caught the worst of it by
  // luck, not by contract. Make the envelope handling explicit so a 200 carrying
  // `{"success":false,…}` is an error rather than a "verification" object.
  // `required` was empty, so a 200 carrying a verification block and nothing
  // else passed the guard below and then died in the RENDERER:
  //
  //     TypeError: Cannot read properties of undefined (reading 'toUpperCase')
  //         at …/dist/commands/decision-bom.js  (result.verdict.toUpperCase())
  //
  // Exit was non-zero, so no wrong artifact was produced — but an unhandled
  // stack trace is not a refusal, and it names a line of our code rather than
  // the server that sent an incomplete body. `id` + `verdict` are the two
  // fields this route always sends and the renderer cannot do without; the rest
  // are rendered defensively below.
  const data = expectResult<DecisionBomVerifyResult>(json, "GET /decision-bom/:id", [
    "id",
    "verdict",
  ]);
  if (typeof data.verification?.valid !== "boolean") {
    throw new Error("Decision-BOM verify failed: malformed server response (no verification block)");
  }
  if (typeof data.verdict !== "string") {
    throw new Error(
      `Decision-BOM verify failed: the server's \`verdict\` is ${typeof data.verdict}, not a string — ` +
        "refusing to render a compliance artifact from a body this command cannot read.",
    );
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
      // Everything except `id`/`verdict` (both now required at the boundary) is
      // rendered through `?? "—"`: an optional field that is absent must print
      // a dash, never the word "undefined" — and never throw halfway down a
      // compliance artifact, leaving the signature verdict unprinted.
      const dash = chalk.dim("—");
      console.log(`  BOM id:    ${chalk.cyan(result.id)}`);
      console.log(`  Decision:  ${result.decisionId ? chalk.cyan(result.decisionId) : dash}`);
      console.log(`  Surface:   ${result.surface ?? dash}`);
      console.log(`  Verdict:   ${verdictColor(result.verdict.toUpperCase())} ${chalk.dim(`(${result.category ?? "—"})`)}`);
      console.log(`  Signed:    ${chalk.dim(result.signedAt ?? "—")} (${result.signature?.algorithm ?? "—"})`);
      console.log();
      console.log(`  ${statusColor("●")} Signature: ${statusColor(valid ? "VALID — artifact intact" : "TAMPERED / INVALID")}`);
      if (!valid && result.verification.reason) {
        console.log(chalk.red(`    ${result.verification.reason}`));
      }
      console.log();

      process.exit(valid ? 0 : 1);
    });
}
