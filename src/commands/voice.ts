/**
 * `evalguard voice` — word-level ASR + deepfake detection via the voice-ML sidecar.
 *
 *   evalguard voice transcribe --project <id> --file call.wav [--language en] [--json]
 *   evalguard voice deepfake   --project <id> --file clip.wav [--json]
 *
 * `--file` is any audio file (WAV/MP3/…); the CLI base64-encodes the bytes and
 * the sidecar decodes them. Requires the operator-deployed voice-ML sidecar on
 * the server (the API returns 503 otherwise). API functions take an injectable
 * `fetchImpl` for offline unit tests.
 */
import { Command } from "commander";
import chalk from "chalk";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";
import {
  boundedFetch,
  decodeJsonBody,
  expectNumberField,
  expectResult,
} from "../lib/http.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ENDPOINT_TRANSCRIBE = "POST /voice/transcribe";
const ENDPOINT_DEEPFAKE = "POST /voice/deepfake";

export interface VoiceApiOpts {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

async function call(path: string, body: unknown, opts: VoiceApiOpts): Promise<unknown> {
  const f = opts.fetchImpl ?? boundedFetch;
  const res = await f(`${opts.baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await decodeJsonBody(res, `${path}`);
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

export async function transcribeVoice(
  args: { projectId: string; audioBase64: string; language?: string } & VoiceApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  if (!args.audioBase64) throw new Error("audio is required");
  return call("/voice/transcribe", { projectId: args.projectId, audioBase64: args.audioBase64, language: args.language }, args);
}

export async function scoreDeepfake(
  args: { projectId: string; audioBase64: string } & VoiceApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  if (!args.audioBase64) throw new Error("audio is required");
  return call("/voice/deepfake-score", { projectId: args.projectId, audioBase64: args.audioBase64 }, args);
}

function envConfig(): VoiceApiOpts {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(chalk.red("EVALGUARD_API_KEY not set. Run `evalguard init`."));
    process.exit(1);
  }
  return { baseUrl: resolveBaseUrl(), apiKey };
}

async function readAudioBase64(file: string): Promise<string> {
  const fs = await import("node:fs");
  try {
    return fs.readFileSync(file).toString("base64");
  } catch (e) {
    console.error(chalk.red(`Failed to read ${file}: ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }
}

export function registerVoice(program: Command): void {
  const cmd = program.command("voice").description("Word-level ASR + deepfake detection (via the voice-ML sidecar)");

  cmd
    .command("transcribe")
    .description("Transcribe an audio file with word-level timestamps")
    .requiredOption("--project <id>", "Project UUID")
    .requiredOption("--file <path>", "Audio file (WAV/MP3/…)")
    .option("--language <iso>", "Force a language (ISO 639-1); auto-detect if omitted")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { project: string; file: string; language?: string; json?: boolean }) => {
      try {
        const audioBase64 = await readAudioBase64(opts.file);
        const body = await transcribeVoice({ projectId: opts.project, audioBase64, language: opts.language, ...envConfig() });
        // `text` is the whole point of the command; without it there is no
        // transcript, and the previous cast rendered `undefined` as one.
        const result = expectResult<{
          language?: string; durationMs?: number; text: string; words?: { word: string }[];
        }>(body, ENDPOINT_TRANSCRIBE, ["text"]);
        if (opts.json) return void console.log(JSON.stringify(result, null, 2));
        console.log();
        console.log(`  ${chalk.dim("language:")} ${result.language ?? "?"}   ${chalk.dim("duration:")} ${result.durationMs ?? "?"}ms   ${chalk.dim("words:")} ${result.words?.length ?? 0}`);
        console.log(`  ${chalk.bold("transcript:")} ${result.text}`);
        console.log();
      } catch (e) {
        console.error(chalk.red(`voice transcribe failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });

  cmd
    .command("deepfake")
    .description("Score an audio file for synthetic-speech / deepfake probability")
    .requiredOption("--project <id>", "Project UUID")
    .requiredOption("--file <path>", "Audio file (WAV/MP3/…)")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { project: string; file: string; json?: boolean }) => {
      try {
        const audioBase64 = await readAudioBase64(opts.file);
        const body = await scoreDeepfake({ projectId: opts.project, audioBase64, ...envConfig() });
        // A DEEPFAKE VERDICT. Measured before this change: an absent
        // `probability` rendered as `likely genuine (NaN% synthetic)`, exit 0 —
        // the reassuring branch, produced from nothing.
        const result = expectResult<{ probability: number; model?: string }>(body, ENDPOINT_DEEPFAKE);
        const probability = expectNumberField(result, "probability", ENDPOINT_DEEPFAKE);
        if (opts.json) return void console.log(JSON.stringify(result, null, 2));
        const pct = (probability * 100).toFixed(1);
        const verdict = probability >= 0.5 ? chalk.red(`likely synthetic (${pct}%)`) : chalk.green(`likely genuine (${pct}% synthetic)`);
        console.log();
        console.log(`  ${verdict}${result.model ? chalk.dim(`  [${result.model}]`) : ""}`);
        console.log();
      } catch (e) {
        console.error(chalk.red(`voice deepfake failed: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }
    });
}
