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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ModerationApiOpts {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

async function callModeration(path: string, payload: unknown, args: ModerationApiOpts): Promise<unknown> {
  const f = args.fetchImpl ?? fetch;
  const res = await f(`${args.baseUrl}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${args.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => null);
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
  const apiKey = process.env.EVALGUARD_API_KEY;
  if (!apiKey) {
    console.error(chalk.red("EVALGUARD_API_KEY not set. Run `evalguard init`."));
    process.exit(1);
  }
  return { baseUrl: process.env.EVALGUARD_BASE_URL ?? "https://evalguard.ai/api/v1", apiKey };
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
    .option("--threshold <n>", "Flag threshold on the max category score (0..1)", parseFloat)
    .option("--json", "Output as JSON", false)
    .action(
      async (opts: {
        org: string;
        project: string;
        url?: string;
        file?: string;
        threshold?: number;
        json?: boolean;
      }) => {
        try {
          if (!opts.url && !opts.file) throw new Error("provide --url or --file");
          const img = opts.file ? await readImageBase64(opts.file) : undefined;
          const body = (await moderateImage({
            orgId: opts.org,
            projectId: opts.project,
            imageUrl: opts.url,
            imageBase64: img?.base64,
            mimeType: img?.mimeType,
            threshold: opts.threshold,
            ...envConfig(),
          })) as {
            data?: { flagged: boolean; score: number; categories: string[]; provider?: string };
          };
          const result =
            body.data ??
            (body as unknown as { flagged: boolean; score: number; categories: string[]; provider?: string });
          if (opts.json) return void console.log(JSON.stringify(result, null, 2));
          const pct = (result.score * 100).toFixed(1);
          const verdict = result.flagged
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
    .option("--threshold <n>", "Flag threshold on the max frame score (0..1)", parseFloat)
    .option("--max-frames <n>", "Cap on frames moderated", (v) => parseInt(v, 10))
    .option("--sample-every <n>", "Take every Nth frame", (v) => parseInt(v, 10))
    .option("--json", "Output as JSON", false)
    .action(
      async (opts: {
        org: string;
        project: string;
        frame: string[];
        threshold?: number;
        maxFrames?: number;
        sampleEvery?: number;
        json?: boolean;
      }) => {
        try {
          const body = (await moderateVideo({
            orgId: opts.org,
            projectId: opts.project,
            frames: opts.frame.map((url) => ({ imageUrl: url })),
            threshold: opts.threshold,
            maxFrames: opts.maxFrames,
            sampleEveryN: opts.sampleEvery,
            ...envConfig(),
          })) as { data?: { flagged: boolean; score: number; categories: string[]; firstFlaggedFrame?: number; framesEvaluated: number } };
          const r = body.data ?? (body as unknown as { flagged: boolean; score: number; categories: string[]; firstFlaggedFrame?: number; framesEvaluated: number });
          if (opts.json) return void console.log(JSON.stringify(r, null, 2));
          const pct = (r.score * 100).toFixed(1);
          const verdict = r.flagged ? chalk.red(`FLAGGED (${pct}%)`) : chalk.green(`clean (${pct}%)`);
          console.log();
          console.log(`  ${verdict}  ${chalk.dim(`${r.framesEvaluated} frame(s)`)}${r.firstFlaggedFrame !== undefined ? chalk.dim(`  first@${r.firstFlaggedFrame}`) : ""}`);
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
    .option("--threshold <n>", "Synthetic threshold (0..1)", parseFloat)
    .option("--json", "Output as JSON", false)
    .action(
      async (opts: { org: string; project: string; url?: string; frame?: string[]; threshold?: number; json?: boolean }) => {
        try {
          if (!opts.url && !(opts.frame && opts.frame.length)) throw new Error("provide --url (image) or --frame (video)");
          const body = (await detectDeepfake({
            orgId: opts.org,
            projectId: opts.project,
            kind: opts.frame && opts.frame.length ? "video" : "image",
            imageUrl: opts.url,
            frames: opts.frame?.map((url) => ({ imageUrl: url })),
            threshold: opts.threshold,
            ...envConfig(),
          })) as { data?: { synthetic: boolean; probability: number; label?: string } };
          const r = body.data ?? (body as unknown as { synthetic: boolean; probability: number; label?: string });
          if (opts.json) return void console.log(JSON.stringify(r, null, 2));
          const pct = (r.probability * 100).toFixed(1);
          const verdict = r.synthetic ? chalk.red(`likely SYNTHETIC (${pct}%)`) : chalk.green(`likely genuine (${pct}% synthetic)`);
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
