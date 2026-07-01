/**
 * Local SQLite storage for CLI eval/scan results.
 * Enables offline workflow: eval → store → compare → gate
 * No Supabase required.
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const DB_DIR = path.join(os.homedir(), ".evalguard");
const DB_FILE = path.join(DB_DIR, "results.json");

export interface StoredRun {
  id: string;
  type: "eval" | "scan";
  name: string;
  model: string;
  provider: string;
  timestamp: string;
  passRate: number;
  score: number;
  maxScore: number;
  passed: number;
  failed: number;
  total: number;
  latencyMs: number;
  config?: string; // path to config file
  results?: any[]; // full case results
}

function ensureDir(): void {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true, mode: 0o700 });
  }
}

function loadDb(): StoredRun[] {
  ensureDir();
  if (!fs.existsSync(DB_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveDb(runs: StoredRun[]): void {
  ensureDir();
  // Keep last 1000 runs max
  const trimmed = runs.slice(-1000);
  fs.writeFileSync(DB_FILE, JSON.stringify(trimmed, null, 2), { mode: 0o600 });
}

export function storeRun(run: StoredRun): void {
  const runs = loadDb();
  runs.push(run);
  saveDb(runs);
}

export function listRuns(type?: "eval" | "scan", limit = 20): StoredRun[] {
  const runs = loadDb();
  const filtered = type ? runs.filter((r) => r.type === type) : runs;
  return filtered.slice(-limit).reverse();
}

export function getRun(id: string): StoredRun | undefined {
  return loadDb().find((r) => r.id === id);
}

export function getLatestRun(type?: "eval" | "scan"): StoredRun | undefined {
  const runs = loadDb();
  const filtered = type ? runs.filter((r) => r.type === type) : runs;
  return filtered[filtered.length - 1];
}

export function generateId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
