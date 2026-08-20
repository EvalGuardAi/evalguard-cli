/**
 * `evalguard rag ingest` — managed RAG chunk(+embed) pipeline.
 *
 *   evalguard rag ingest --file docs.json [--json]
 *
 * Reads a JSON file of documents and POSTs to /rag/ingest (chunk + optional
 * embed). Auth mirrors `datasets`: EVALGUARD_API_KEY (Bearer) + EVALGUARD_BASE_URL.
 */
import { Command } from "commander";
import chalk from "chalk";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";
import { boundedFetch, decodeJsonBody, expectResult } from "../lib/http.js";

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
      ...(init.headers ?? {}),
    },
  });
  const body = (await decodeJsonBody(res, `${path}`)) as { data?: unknown; error?: { message?: string } } | null;
  if (!res.ok) throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
  return body;
}

export function registerRag(program: Command): void {
  const cmd = program.command("rag").description("Managed RAG ingest (chunk + embed) pipeline");

  cmd
    .command("ingest")
    .description("Chunk (and optionally embed) a batch of documents from a JSON file")
    .requiredOption("--file <path>", "JSON file: { documents: [{text, metadata?}], chunking?, embed?, embedModel?, projectId? }")
    .option("--json", "Output the raw result as JSON", false)
    .action(async (opts: { file: string; json?: boolean }) => {
      const fs = await import("node:fs");
      let payload: unknown;
      try {
        payload = JSON.parse(fs.readFileSync(opts.file, "utf8"));
      } catch (e) {
        console.error(chalk.red(`Failed to read/parse ${opts.file}: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
      // `RAG ingest — undefined chunks · not embedded`, exit 0, was the measured
      // output for a 200 carrying `{"success":true,"data":{}}`: the ingest may
      // never have happened and the CLI reported a completed one.
      const d = expectResult<{ chunkCount: number; embedded: boolean; model?: string; chunks?: unknown[] }>(
        await apiFetch("/rag/ingest", { method: "POST", body: JSON.stringify(payload) }),
        "POST /rag/ingest",
        ["chunkCount", "embedded"],
      );
      if (opts.json) {
        console.log(JSON.stringify(d, null, 2));
        return;
      }
      const embedNote = d.embedded ? chalk.green(` · embedded (${d.model})`) : chalk.dim(" · not embedded");
      console.log(chalk.bold(`RAG ingest — ${d.chunkCount} chunk${d.chunkCount === 1 ? "" : "s"}`) + embedNote);
    });
}
