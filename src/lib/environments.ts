/**
 * Shared persistence for named deployment environments + the artifact
 * deployment log used by `evalguard env`, `evalguard tool deploy` and
 * `evalguard prompt deploy`.
 *
 * The in-memory `EnvironmentRegistry` / `PromptDeploymentManager` /
 * `ToolDeploymentManager` primitives live in `@evalguard/core` (the deployment
 * workflow layer). This module adds ONLY the thin, local file-backed persistence a CLI
 * needs — it does not reinvent any environment or deployment logic. Every
 * invariant (workspace-unique names, a single `default` environment, "reject
 * deploys to unknown environments") is delegated to the core registry by
 * rebuilding it from the serialized list.
 *
 * Files (owner-private under `~/.evalguard`):
 *   - environments.json  — the workspace's named environments
 *   - deployments.json   — append-only prompt/tool → environment deployment log
 *
 * SECURITY: environments carry only a name + tag; the deployment log carries
 * only artifact name + version + environment + author. No secrets, no tool
 * environment-variable VALUES are ever persisted here.
 */
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  EnvironmentRegistry,
  SEEDED_ENVIRONMENTS,
  type EnvironmentTag,
} from "@evalguard/core";

/* ─── On-disk shapes ──────────────────────────────────────────────────*/

/** A persisted environment: the core `Environment` minus its generated id. */
export interface SerializedEnvironment {
  name: string;
  tag: EnvironmentTag;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
}

/** One append-only deployment event for a prompt or tool. */
export interface DeployLogEntry {
  artifact: "prompt" | "tool";
  name: string;
  env: string;
  version: number;
  deployedBy: string;
  /** ISO-8601 deployment timestamp. */
  deployedAt: string;
}

/* ─── File locations ──────────────────────────────────────────────────*/

export function defaultEnvironmentsFile(): string {
  return path.join(os.homedir(), ".evalguard", "environments.json");
}

export function defaultDeploymentsFile(): string {
  return path.join(os.homedir(), ".evalguard", "deployments.json");
}

async function ensureParentDir(file: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
}

/* ─── Environment store ───────────────────────────────────────────────*/

/** The seed set written on first use — the old hardcoded staging/production. */
export function seededEnvironments(): SerializedEnvironment[] {
  const now = new Date().toISOString();
  return SEEDED_ENVIRONMENTS.map((s) => ({ name: s.name, tag: s.tag, createdAt: now }));
}

/**
 * Load the persisted environments. When the file is absent the seeded
 * staging/production defaults are returned (NOT written) so a fresh workspace
 * behaves exactly like the seeded core registry — back-compat for every
 * existing `--env staging|production` caller.
 */
export async function loadEnvironments(
  file: string = defaultEnvironmentsFile(),
): Promise<SerializedEnvironment[]> {
  if (!fs.existsSync(file)) return seededEnvironments();
  const raw = await fsp.readFile(file, "utf-8");
  const parsed = JSON.parse(raw) as SerializedEnvironment[];
  if (!Array.isArray(parsed)) {
    throw new Error(`Malformed environments file: ${file}`);
  }
  return parsed;
}

/** Persist the environments list (creating `~/.evalguard` if needed). */
export async function saveEnvironments(
  list: SerializedEnvironment[],
  file: string = defaultEnvironmentsFile(),
): Promise<void> {
  await ensureParentDir(file);
  await fsp.writeFile(file, JSON.stringify(list, null, 2), "utf-8");
}

/**
 * Build a core `EnvironmentRegistry` from a serialized list. Replaying each
 * environment through `createEnvironment` re-applies every core invariant
 * (unique names, at most one `default`); a malformed persisted list therefore
 * throws exactly as the core registry would.
 */
export function buildEnvironmentRegistry(list: SerializedEnvironment[]): EnvironmentRegistry {
  const reg = new EnvironmentRegistry(false);
  for (const e of list) reg.createEnvironment(e.name, e.tag);
  return reg;
}

/**
 * Add a named environment to the list. Delegates uniqueness + single-default
 * validation to a rebuilt core registry (throws on violation), then appends.
 * Pure — returns a NEW list; the caller persists it.
 */
export function addEnvironment(
  list: SerializedEnvironment[],
  name: string,
  tag: EnvironmentTag = "other",
): SerializedEnvironment[] {
  const reg = buildEnvironmentRegistry(list);
  reg.createEnvironment(name, tag); // throws on duplicate name / duplicate default
  return [...list, { name, tag, createdAt: new Date().toISOString() }];
}

/**
 * Remove a named environment from the list. Pure — returns the new list and
 * whether anything was removed. Deployments targeting a removed environment are
 * left in the log but become unreachable (matching the core registry, which
 * keeps deployments keyed by env name).
 */
export function removeEnvironment(
  list: SerializedEnvironment[],
  name: string,
): { list: SerializedEnvironment[]; removed: boolean } {
  const next = list.filter((e) => e.name !== name);
  return { list: next, removed: next.length !== list.length };
}

/* ─── Deployment log store ────────────────────────────────────────────*/

/**
 * Append-only, file-backed deployment log. `getCurrent()` and the deployment
 * managers derive "what is deployed where" by replaying this log through the
 * core managers, so the CLI's view of a deployment is computed by the SAME code
 * the server would use — no duplicated deployment semantics.
 */
export class DeployLog {
  constructor(private readonly file: string = defaultDeploymentsFile()) {}

  async load(): Promise<DeployLogEntry[]> {
    if (!fs.existsSync(this.file)) return [];
    const raw = await fsp.readFile(this.file, "utf-8");
    const parsed = JSON.parse(raw) as DeployLogEntry[];
    if (!Array.isArray(parsed)) {
      throw new Error(`Malformed deployments file: ${this.file}`);
    }
    return parsed;
  }

  /** All log entries for one artifact kind + name, in chronological order. */
  async entriesFor(artifact: "prompt" | "tool", name: string): Promise<DeployLogEntry[]> {
    const all = await this.load();
    return all.filter((e) => e.artifact === artifact && e.name === name);
  }

  async append(entry: DeployLogEntry): Promise<void> {
    const all = await this.load();
    all.push(entry);
    await ensureParentDir(this.file);
    await fsp.writeFile(this.file, JSON.stringify(all, null, 2), "utf-8");
  }
}
