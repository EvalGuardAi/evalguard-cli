/**
 * `evalguard moderation` — vision content moderation (BYO vision model).
 *
 *   evalguard moderation image --org <id> --project <id> --url   <https://…> [--threshold 0.7] [--json]
 *   evalguard moderation image --org <id> --project <id> --file  cat.png      [--threshold 0.7] [--json]
 *
 * Image moderation needs a real vision model; EvalGuard ships zero weights. This
 * runs the moderation engine against the project's BYO vision vendor (OpenAI
 * omni-moderation today) using its BYOK key. `--file` is base64-encoded locally.
 * Fails CLOSED (flagged) on backend error. API fn takes an injectable `fetchImpl`
 * for offline unit tests.
 */
import { Command } from "commander";
import chalk from "chalk";
import { resolveApiKey, resolveBaseUrl } from "../lib/config.js";
import {
  boundedFetch,
  decodeJsonBody,
  expectBooleanField,
  expectNumberField,
  expectResult,
} from "../lib/http.js";
import {
  parseCountFlag,
  parseHttpUrlFlag,
  parseUnitIntervalFlag,
} from "../lib/arg-validate.js";

/**
 * What a dropped or out-of-range `--threshold` actually costs, said once and
 * reused by all three subcommands.
 *
 * `--threshold <n>` used to declare `parseFloat` as Commander's coercion:
 *
 *   --threshold abc → NaN → `JSON.stringify` writes `"threshold":null` → the
 *     field never reaches the server, whose own default (0.5) runs instead;
 *   --threshold 5   → forwarded, and a max-category score lives in 0..1, so the
 *     gate can never fire;
 *   --threshold .7x → parseFloat silently returns 0.7.
 *
 * All three then print `clean (1.0%)` and exit 0. The operator walks away
 * believing a stricter gate ran than the one that did — which, for a
 * content-moderation tool, is the single most expensive thing to get wrong.
 */
const THRESHOLD_CONSEQUENCE =
  "The flag would have been dropped at the wire and the server's DEFAULT threshold would have run, " +
  "while the verdict on screen read as though yours had.";

/**
 * The ceiling POST /moderation/video actually enforces — its Zod body schema is
 * `frames: z.array(...).min(1).max(256)`, `maxFrames: z.number().int().min(1).max(256)`,
 * `sampleEveryN: …min(1).max(256)`. Copied rather than invented, so the CLI
 * refuses exactly what the route refuses and nothing more.
 */
const MAX_VIDEO_FRAMES = 256;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ENDPOINT_IMAGE = "POST /moderation/image";
const ENDPOINT_VIDEO = "POST /moderation/video";
const ENDPOINT_DEEPFAKE = "POST /moderation/deepfake";

export interface ModerationApiOpts {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

async function callModeration(path: string, payload: unknown, args: ModerationApiOpts): Promise<unknown> {
  const f = args.fetchImpl ?? boundedFetch;
  const res = await f(`${args.baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${args.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await decodeJsonBody(res, `${path}`);
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return json;
}

export async function moderateImage(
  args: {
    orgId: string;
    projectId: string;
    imageUrl?: string;
    imageBase64?: string;
    mimeType?: string;
    threshold?: number;
    provider?: "openai";
  } & ModerationApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.orgId)) throw new Error("orgId must be a valid UUID");
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  if (!args.imageUrl && !args.imageBase64) throw new Error("imageUrl or imageBase64 is required");
  return callModeration("/moderation/image", {
    orgId: args.orgId,
    projectId: args.projectId,
    imageUrl: args.imageUrl,
    imageBase64: args.imageBase64,
    mimeType: args.mimeType,
    threshold: args.threshold,
    provider: args.provider,
  }, args);
}

export interface ModerationFrame {
  imageUrl?: string;
  imageBase64?: string;
  mimeType?: string;
  timestampMs?: number;
}

export async function moderateVideo(
  args: {
    orgId: string;
    projectId: string;
    frames: ModerationFrame[];
    threshold?: number;
    maxFrames?: number;
    sampleEveryN?: number;
    provider?: "openai";
  } & ModerationApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.orgId)) throw new Error("orgId must be a valid UUID");
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  if (!args.frames || args.frames.length === 0) throw new Error("at least one frame is required");
  return callModeration("/moderation/video", {
    orgId: args.orgId,
    projectId: args.projectId,
    frames: args.frames,
    threshold: args.threshold,
    maxFrames: args.maxFrames,
    sampleEveryN: args.sampleEveryN,
    provider: args.provider,
  }, args);
}

export async function detectDeepfake(
  args: {
    orgId: string;
    projectId: string;
    kind?: "image" | "video";
    imageUrl?: string;
    imageBase64?: string;
    mimeType?: string;
    frames?: ModerationFrame[];
    threshold?: number;
  } & ModerationApiOpts,
): Promise<unknown> {
  if (!UUID_RE.test(args.orgId)) throw new Error("orgId must be a valid UUID");
  if (!UUID_RE.test(args.projectId)) throw new Error("projectId must be a valid UUID");
  if (!args.imageUrl && !args.imageBase64 && !(args.frames && args.frames.length > 0)) {
    throw new Error("provide imageUrl/imageBase64 (image) or frames[] (video)");
  }
  return callModeration("/moderation/deepfake", {
    orgId: args.orgId,
    projectId: args.projectId,
    kind: args.kind,
    imageUrl: args.imageUrl,
    imageBase64: args.imageBase64,
    mimeType: args.mimeType,
    frames: args.frames,
    threshold: args.threshold,
  }, args);
}

function envConfig(): ModerationApiOpts {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(chalk.red("EVALGUARD_API_KEY not set. Run `evalguard init`."));
    process.exit(1);
  }
  return { baseUrl: resolveBaseUrl(), apiKey };
}

async function readImageBase64(file: string): Promise<{ base64: string; mimeType?: string }> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  try {
    const ext = path.extname(file).toLowerCase().replace(".", "");
    const mimeType =
      ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext ? `image/${ext}` : undefined;
    return { base64: fs.readFileSync(file).toString("base64"), mimeType };
  } catch (e) {
    console.error(chalk.red(`Failed to read ${file}: ${e instanceof Error ? e.message : String(e)}`));
    process.exit(1);
  }
}

export function registerModeration(program: Command): void {
  const cmd = program
    .command("moderation")
    .description("Vision content moderation (BYO vision model — OpenAI omni-moderation)");

  cmd
    .command("image")
    .description("Moderate an image for harmful content via the project's BYO vision model")
    .requiredOption("--org <id>", "Org UUID")
    .requiredOption("--project <id>", "Project UUID")
    .option("--url <url>", "Public image URL")
    .option("--file <path>", "Local image file (base64-encoded locally)")
    // NO `parseFloat` coercion — see THRESHOLD_CONSEQUENCE. Commander would run
    // it before the action, so the action could no longer tell "abc" (a typo)
    // from a deliberate absence: both arrive as a falsy number.
    .option("--threshold <n>", "Flag threshold on the max category score (0..1)")
    .option("--json", "Output as JSON", false)
    .action(
      async (opts: {
        org: string;
        project: string;
        url?: string;
        file?: string;
        threshold?: string;
        json?: boolean;
      }) => {
        // OUTSIDE the try: a refusal is not a moderation failure, and wrapping
        // it would turn an exit-2 usage error into "moderation image failed" +
        // exit 1. The validators exit the process themselves.
        const threshold = parseUnitIntervalFlag(opts.threshold, "--threshold", THRESHOLD_CONSEQUENCE);
        const url = parseHttpUrlFlag(
          opts.url,
          "--url",
          "The server has to reject it, so this costs a round trip to learn what `new URL()` knows locally.",
        );
        try {
          if (!url && !opts.file) throw new Error("provide --url or --file");
          const img = opts.file ? await readImageBase64(opts.file) : undefined;
          const body = await moderateImage({
            orgId: opts.org,
            projectId: opts.project,
            imageUrl: url,
            imageBase64: img?.base64,
            mimeType: img?.mimeType,
            threshold,
            ...envConfig(),
          });
          // A CONTENT-MODERATION VERDICT, so it is refused rather than
          // reconstructed. `body.data ?? (body as unknown as …)` printed
          // `clean (NaN%)` with exit 0 against a 200 carrying
          // `{"success":false,"error":{"message":"vision provider timed out"}}`
          // — the backend said it had failed and the CLI answered "clean".
          const result = expectResult<{
            flagged: boolean; score: number; categories?: string[]; provider?: string;
          }>(body, ENDPOINT_IMAGE);
          const flagged = expectBooleanField(result, "flagged", ENDPOINT_IMAGE);
          const score = expectNumberField(result, "score", ENDPOINT_IMAGE);
          if (opts.json) return void console.log(JSON.stringify(result, null, 2));
          const pct = (score * 100).toFixed(1);
          const verdict = flagged
            ? chalk.red(`FLAGGED (${pct}%)`)
            : chalk.green(`clean (${pct}%)`);
          console.log();
          console.log(`  ${verdict}${result.provider ? chalk.dim(`  [${result.provider}]`) : ""}`);
          if (result.categories?.length) console.log(`  ${chalk.dim("categories:")} ${result.categories.join(", ")}`);
          console.log();
        } catch (e) {
          console.error(chalk.red(`moderation image failed: ${e instanceof Error ? e.message : String(e)}`));
          process.exit(1);
        }
      },
    );

  cmd
    .command("video")
    .description("Moderate a video by sampling its frames (pass --frame URLs; extract with ffmpeg first)")
    .requiredOption("--org <id>", "Org UUID")
    .requiredOption("--project <id>", "Project UUID")
    .requiredOption("--frame <url...>", "Frame image URL(s) — repeat or space-separate")
    // Same removal of the silent `parseFloat` / `parseInt` coercions as `image`.
    // Fixing one subcommand and leaving its two siblings is not a fix — the next
    // operator simply hits the same wall from `video`.
    .option("--threshold <n>", "Flag threshold on the max frame score (0..1)")
    .option("--max-frames <n>", "Cap on frames moderated")
    .option("--sample-every <n>", "Take every Nth frame")
    .option("--json", "Output as JSON", false)
    .action(
      async (opts: {
        org: string;
        project: string;
        frame: string[];
        threshold?: string;
        maxFrames?: string;
        sampleEvery?: string;
        json?: boolean;
      }) => {
        const threshold = parseUnitIntervalFlag(opts.threshold, "--threshold", THRESHOLD_CONSEQUENCE);
        const maxFrames = parseCountFlag(opts.maxFrames, "--max-frames", {
          max: MAX_VIDEO_FRAMES,
          consequence: "A NaN cap is dropped at the wire and every supplied frame would have been moderated.",
        });
        const sampleEvery = parseCountFlag(opts.sampleEvery, "--sample-every", {
          max: MAX_VIDEO_FRAMES,
          consequence: "A NaN stride is dropped at the wire and every frame would have been sampled.",
        });
        const frames = opts.frame.map((raw, i) => ({
          imageUrl: parseHttpUrlFlag(
            raw,
            `--frame[${i}]`,
            "The server has to reject it, so this costs a round trip per bad frame.",
          )!,
        }));
        try {
          const body = await moderateVideo({
            orgId: opts.org,
            projectId: opts.project,
            frames,
            threshold,
            maxFrames,
            sampleEveryN: sampleEvery,
            ...envConfig(),
          });
          const r = expectResult<{
            flagged: boolean; score: number; categories?: string[];
            firstFlaggedFrame?: number; framesEvaluated?: number;
          }>(body, ENDPOINT_VIDEO);
          const flagged = expectBooleanField(r, "flagged", ENDPOINT_VIDEO);
          const score = expectNumberField(r, "score", ENDPOINT_VIDEO);
          const framesEvaluated = expectNumberField(r, "framesEvaluated", ENDPOINT_VIDEO);
          if (opts.json) return void console.log(JSON.stringify(r, null, 2));
          const pct = (score * 100).toFixed(1);
          const verdict = flagged ? chalk.red(`FLAGGED (${pct}%)`) : chalk.green(`clean (${pct}%)`);
          console.log();
          console.log(`  ${verdict}  ${chalk.dim(`${framesEvaluated} frame(s)`)}${r.firstFlaggedFrame !== undefined ? chalk.dim(`  first@${r.firstFlaggedFrame}`) : ""}`);
          if (r.categories?.length) console.log(`  ${chalk.dim("categories:")} ${r.categories.join(", ")}`);
          console.log();
        } catch (e) {
          console.error(chalk.red(`moderation video failed: ${e instanceof Error ? e.message : String(e)}`));
          process.exit(1);
        }
      },
    );

  cmd
    .command("deepfake")
    .description("Detect a visual deepfake (image or video frames) via the BYO ML sidecar")
    .requiredOption("--org <id>", "Org UUID")
    .requiredOption("--project <id>", "Project UUID")
    .option("--url <url>", "Image URL (image mode)")
    .option("--frame <url...>", "Frame image URL(s) for video mode")
    .option("--threshold <n>", "Synthetic threshold (0..1)")
    .option("--json", "Output as JSON", false)
    .action(
      async (opts: { org: string; project: string; url?: string; frame?: string[]; threshold?: string; json?: boolean }) => {
        const threshold = parseUnitIntervalFlag(opts.threshold, "--threshold", THRESHOLD_CONSEQUENCE);
        const url = parseHttpUrlFlag(
          opts.url,
          "--url",
          "The server has to reject it, so this costs a round trip to learn what `new URL()` knows locally.",
        );
        const frames = opts.frame?.map((raw, i) => ({
          imageUrl: parseHttpUrlFlag(
            raw,
            `--frame[${i}]`,
            "The server has to reject it, so this costs a round trip per bad frame.",
          )!,
        }));
        try {
          if (!url && !(frames && frames.length)) throw new Error("provide --url (image) or --frame (video)");
          const body = await detectDeepfake({
            orgId: opts.org,
            projectId: opts.project,
            kind: frames && frames.length ? "video" : "image",
            imageUrl: url,
            frames,
            threshold,
            ...envConfig(),
          });
          // Measured before this change: `likely genuine (NaN% synthetic)`,
          // exit 0, against a backend that had explicitly reported failure.
          const r = expectResult<{ synthetic: boolean; probability: number; label?: string }>(
            body,
            ENDPOINT_DEEPFAKE,
          );
          const synthetic = expectBooleanField(r, "synthetic", ENDPOINT_DEEPFAKE);
          const probability = expectNumberField(r, "probability", ENDPOINT_DEEPFAKE);
          if (opts.json) return void console.log(JSON.stringify(r, null, 2));
          const pct = (probability * 100).toFixed(1);
          const verdict = synthetic ? chalk.red(`likely SYNTHETIC (${pct}%)`) : chalk.green(`likely genuine (${pct}% synthetic)`);
          console.log();
          console.log(`  ${verdict}${r.label ? chalk.dim(`  [${r.label}]`) : ""}`);
          console.log();
        } catch (e) {
          console.error(chalk.red(`moderation deepfake failed: ${e instanceof Error ? e.message : String(e)}`));
          process.exit(1);
        }
      },
    );
}
