/**
 * Named CLI profiles — the store, the migration, and the precedence chain.
 *
 * Audit 2026-08-05 (MEDIUM-HIGH): `~/.evalguard/config.json` was one flat
 * `{apiKey, baseUrl, projectId}` and `evalguard login` OVERWROTE it, so an
 * enterprise running two installs (SaaS + self-hosted, or dev/stage/prod) had
 * to re-login or hand-juggle EVALGUARD_API_KEY / EVALGUARD_BASE_URL.
 *
 * These tests use a REAL file in a temp dir (via EVALGUARD_CONFIG_FILE) rather
 * than a mocked `fs`. The whole risk of this change is what happens to bytes on
 * disk that a user already has, and a mocked filesystem cannot fail the way a
 * real one can.
 *
 * ── Why these tests pin EVALGUARD_SECRET_BACKEND=plaintext ─────────────────
 *
 * Credential at-rest protection (2026-08-06) landed AFTER this file. This suite
 * is about profile SEMANTICS — which profile a write touches, what a delete
 * falls back to, how the env vars stack — and every one of those assertions is
 * about a value, not about how the value is stored. Forcing `plaintext` keeps
 * them reading `apiKey` directly, and keeps ~30 writes from each spawning a
 * DPAPI subprocess.
 *
 * The at-rest behaviour is pinned separately, and with the REAL platform
 * backend, in `secret-store.test.ts` — including the load-bearing assertion
 * that the saved file does not contain the key.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  CONFIG_VERSION,
  DEFAULT_BASE_URL,
  DEFAULT_PROFILE,
  activeProfileName,
  configFilePath,
  deleteProfile,
  getProfile,
  isLegacyFlatConfigFile,
  isValidProfileName,
  listProfileNames,
  loadConfig,
  loadConfigFile,
  normalizeConfigFile,
  resetProfileWarnings,
  resolveApiKey,
  resolveBaseUrl,
  saveActiveProfile,
  setCurrentProfile,
  upsertProfile,
} from "../config.js";
import { activeOverrides, profileRows } from "../../commands/profile.js";

const ENV_KEYS = [
  "EVALGUARD_CONFIG_FILE",
  "EVALGUARD_PROFILE",
  "EVALGUARD_API_KEY",
  "EVALGUARD_BASE_URL",
  "EVALGUARD_SECRET_BACKEND",
] as const;

let tmpDir: string;
let configFile: string;
const saved: Record<string, string | undefined> = {};

/** The exact bytes a pre-profiles CLI (<= 3.7.4) wrote. */
const LEGACY_FLAT = {
  apiKey: "eg_live_legacyKey1234567890",
  baseUrl: "https://evalguard.ai/api/v1",
  projectId: "proj_legacy",
};

function writeRaw(value: unknown): void {
  fs.writeFileSync(configFile, JSON.stringify(value, null, 2));
}

function readRaw(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(configFile, "utf-8")) as Record<string, unknown>;
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eg-cli-profiles-"));
  configFile = path.join(tmpDir, "config.json");
  process.env.EVALGUARD_CONFIG_FILE = configFile;
  // See the module header: this suite is about profile semantics, so keys stay
  // readable as `apiKey`. At-rest protection lives in secret-store.test.ts.
  process.env.EVALGUARD_SECRET_BACKEND = "plaintext";
  resetProfileWarnings();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key] as string;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ── the mandated back-compat case ──────────────────────────────────────── */

describe("migration: an existing FLAT config keeps working, untouched", () => {
  it("adopts the flat file as the default profile with no user action", () => {
    writeRaw(LEGACY_FLAT);

    // Every subcommand reads through loadConfig(); it must see the same values
    // it saw before profiles existed.
    expect(loadConfig()).toMatchObject(LEGACY_FLAT);
    expect(resolveApiKey()).toBe(LEGACY_FLAT.apiKey);
    expect(resolveBaseUrl()).toBe(LEGACY_FLAT.baseUrl);

    const file = loadConfigFile();
    expect(listProfileNames(file)).toEqual([DEFAULT_PROFILE]);
    expect(activeProfileName(file)).toBe(DEFAULT_PROFILE);
    expect(getProfile(DEFAULT_PROFILE, file)).toMatchObject(LEGACY_FLAT);
  });

  it("READING never rewrites the file — read-only homes and CI images still work", () => {
    writeRaw(LEGACY_FLAT);
    const before = fs.readFileSync(configFile, "utf-8");

    loadConfig();
    loadConfigFile();
    resolveApiKey();
    resolveBaseUrl();
    listProfileNames();

    expect(fs.readFileSync(configFile, "utf-8")).toBe(before);
    expect(isLegacyFlatConfigFile(configFile)).toBe(true);
  });

  it("the first WRITE materializes v2 and loses nothing the flat file held", () => {
    writeRaw({ ...LEGACY_FLAT, openaiApiKey: "sk-legacy", somethingFuture: 42 });

    // What `evalguard login` does for a user who never touched profiles.
    saveActiveProfile({ apiKey: "eg_live_rotated0987654321" });

    const raw = readRaw();
    expect(raw.version).toBe(CONFIG_VERSION);
    expect(raw.currentProfile).toBe(DEFAULT_PROFILE);
    const profiles = raw.profiles as Record<string, Record<string, unknown>>;
    expect(Object.keys(profiles)).toEqual([DEFAULT_PROFILE]);
    // Rotated key, everything else preserved — including keys this version
    // does not know about.
    expect(profiles.default).toMatchObject({
      apiKey: "eg_live_rotated0987654321",
      baseUrl: LEGACY_FLAT.baseUrl,
      projectId: LEGACY_FLAT.projectId,
      openaiApiKey: "sk-legacy",
      somethingFuture: 42,
    });
    expect(isLegacyFlatConfigFile(configFile)).toBe(false);
  });

  it("a v2 file still exposes the active profile at the TOP LEVEL for older readers", () => {
    upsertProfile("prod", { apiKey: "eg_prod_key_1234567890", baseUrl: "https://evalguard.ai/api/v1" }, {
      switchTo: true,
    });

    // A pinned older @evalguard/cli does exactly this: JSON.parse + read
    // `apiKey`. Without the mirror it would read undefined and tell the user to
    // run `login`, silently stranding them.
    //
    // NOTE: this holds while the key itself is stored in plaintext (the case
    // this suite pins). Once a credential store protects it, the mirror
    // deliberately drops `apiKey` — a decrypted copy beside the ciphertext
    // would be theatre. That case is asserted in secret-store.test.ts.
    const asOldCliSeesIt = readRaw() as { apiKey?: string; baseUrl?: string };
    expect(asOldCliSeesIt.apiKey).toBe("eg_prod_key_1234567890");
    expect(asOldCliSeesIt.baseUrl).toBe("https://evalguard.ai/api/v1");
  });

  it("the mirror is derived: `profiles` wins on read even when the mirror is stale", () => {
    writeRaw({
      version: CONFIG_VERSION,
      currentProfile: "prod",
      profiles: { prod: { apiKey: "eg_authoritative_1234567890" } },
      apiKey: "eg_STALE_MIRROR_0987654321",
    });
    expect(resolveApiKey()).toBe("eg_authoritative_1234567890");
  });
});

/* ── the ergonomics the finding is about ────────────────────────────────── */

describe("named profiles", () => {
  it("writing one profile leaves every other profile untouched (the whole point)", () => {
    upsertProfile("saas", { apiKey: "eg_saas_key_1234567890", baseUrl: DEFAULT_BASE_URL }, { switchTo: true });
    upsertProfile(
      "self-hosted",
      { apiKey: "eg_selfhosted_key_09876", baseUrl: "https://eg.corp.internal/api/v1" },
      { switchTo: true },
    );

    // Re-login on self-hosted — what used to destroy the SaaS credential.
    upsertProfile("self-hosted", { apiKey: "eg_selfhosted_ROTATED_555" });

    const file = loadConfigFile();
    expect(getProfile("saas", file).apiKey).toBe("eg_saas_key_1234567890");
    expect(getProfile("self-hosted", file).apiKey).toBe("eg_selfhosted_ROTATED_555");
    expect(listProfileNames(file)).toEqual(["saas", "self-hosted"]);
  });

  it("switching changes what every subcommand resolves", () => {
    upsertProfile("dev", { apiKey: "eg_dev_key_1234567890", baseUrl: "http://localhost:3000/api/v1" });
    upsertProfile("prod", { apiKey: "eg_prod_key_1234567890", baseUrl: "https://evalguard.ai/api/v1" });

    setCurrentProfile("dev");
    expect(resolveApiKey()).toBe("eg_dev_key_1234567890");
    expect(resolveBaseUrl()).toBe("http://localhost:3000/api/v1");

    setCurrentProfile("prod");
    expect(resolveApiKey()).toBe("eg_prod_key_1234567890");
    expect(resolveBaseUrl()).toBe("https://evalguard.ai/api/v1");
  });

  it("refuses to switch to a profile that does not exist, and says what does", () => {
    upsertProfile("prod", { apiKey: "eg_prod_key_1234567890" });
    expect(() => setCurrentProfile("staging")).toThrow(/No profile named "staging"/);
    expect(() => setCurrentProfile("staging")).toThrow(/prod/);
  });

  it("deleting the CURRENT profile falls back instead of pointing at nothing", () => {
    upsertProfile("a", { apiKey: "eg_a_key_1234567890" });
    upsertProfile("b", { apiKey: "eg_b_key_1234567890" }, { switchTo: true });

    const after = deleteProfile("b");
    expect(listProfileNames(after)).toEqual(["a"]);
    expect(after.currentProfile).toBe("a");
    expect(resolveApiKey()).toBe("eg_a_key_1234567890");
  });

  it("deleting the last profile leaves a usable empty default, not a broken file", () => {
    upsertProfile("only", { apiKey: "eg_only_key_1234567890" }, { switchTo: true });
    const after = deleteProfile("only");
    expect(after.currentProfile).toBe(DEFAULT_PROFILE);
    expect(listProfileNames(after)).toEqual([DEFAULT_PROFILE]);
    expect(resolveApiKey()).toBeUndefined();
    expect(resolveBaseUrl()).toBe(DEFAULT_BASE_URL);
  });

  it("rejects profile names that would be confusing or unsafe as keys", () => {
    for (const bad of ["", " ", "../etc", "a/b", "-leading", ".hidden", "x".repeat(65), "a b"]) {
      expect(isValidProfileName(bad)).toBe(false);
      expect(() => upsertProfile(bad, { apiKey: "k" })).toThrow(/Invalid profile name/);
    }
    for (const good of ["default", "prod", "self-hosted", "eu_1", "v2.stage", "A1"]) {
      expect(isValidProfileName(good)).toBe(true);
    }
  });
});

/* ── precedence: env vars keep winning, exactly as before ───────────────── */

describe("precedence — EVALGUARD_* still overrides the profile", () => {
  beforeEach(() => {
    upsertProfile(
      "prod",
      { apiKey: "eg_prod_key_1234567890", baseUrl: "https://evalguard.ai/api/v1" },
      { switchTo: true },
    );
  });

  it("EVALGUARD_API_KEY beats the active profile's key", () => {
    process.env.EVALGUARD_API_KEY = "eg_from_env_0987654321";
    expect(resolveApiKey()).toBe("eg_from_env_0987654321");
  });

  it("EVALGUARD_BASE_URL beats the active profile's base URL (and is normalized)", () => {
    process.env.EVALGUARD_BASE_URL = "https://ci.evalguard.test/";
    expect(resolveBaseUrl()).toBe("https://ci.evalguard.test/api/v1");
  });

  it("EVALGUARD_PROFILE selects a profile without mutating the config file", () => {
    upsertProfile("stage", { apiKey: "eg_stage_key_1234567890", baseUrl: "https://stage.test/api/v1" });
    const before = fs.readFileSync(configFile, "utf-8");

    process.env.EVALGUARD_PROFILE = "stage";
    expect(activeProfileName()).toBe("stage");
    expect(resolveApiKey()).toBe("eg_stage_key_1234567890");
    expect(resolveBaseUrl()).toBe("https://stage.test/api/v1");

    // The persisted currentProfile is unchanged — the override is per-invocation.
    expect(fs.readFileSync(configFile, "utf-8")).toBe(before);
    delete process.env.EVALGUARD_PROFILE;
    expect(activeProfileName()).toBe("prod");
  });

  it("an EVALGUARD_PROFILE typo warns but never throws (env vars may supply the key)", () => {
    process.env.EVALGUARD_PROFILE = "prodd";
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg?: unknown) => void warnings.push(String(msg));
    try {
      expect(activeProfileName()).toBe("prodd");
      expect(loadConfig()).toEqual({});
      expect(resolveApiKey()).toBeUndefined();
      // One-shot: a second lookup must not spam.
      activeProfileName();
    } finally {
      console.warn = originalWarn;
    }
    // Filter to the profile warning: the secret store may also emit its own
    // one-shot plaintext notice on stderr, which is a different concern.
    const profileWarnings = warnings.filter((w) => w.includes("does not match any saved profile"));
    expect(profileWarnings).toHaveLength(1);
    expect(profileWarnings[0]).toMatch(/prod/);
  });
});

/* ── file location + shape ──────────────────────────────────────────────── */

describe("config file location and shape", () => {
  it("EVALGUARD_CONFIG_FILE relocates the config", () => {
    expect(configFilePath()).toBe(configFile);
    delete process.env.EVALGUARD_CONFIG_FILE;
    expect(configFilePath()).toBe(path.join(os.homedir(), ".evalguard", "config.json"));
  });

  it("a corrupt or absent file resolves to env-only defaults rather than throwing", () => {
    fs.writeFileSync(configFile, "{ not json");
    expect(loadConfig()).toEqual({});
    expect(resolveBaseUrl()).toBe(DEFAULT_BASE_URL);

    fs.rmSync(configFile);
    expect(loadConfig()).toEqual({});
    expect(listProfileNames()).toEqual([]);
  });

  it("normalizes a currentProfile that names a profile the file does not contain", () => {
    const normalized = normalizeConfigFile({
      version: 2,
      currentProfile: "ghost",
      profiles: { prod: { apiKey: "k" } },
    });
    expect(normalized.currentProfile).toBe(DEFAULT_PROFILE);
    // …and does NOT invent the missing profile: a read must never add a
    // profile the user would then see in `profile list` and wonder about.
    expect(Object.keys(normalized.profiles)).toEqual(["prod"]);
  });

  it("the first profile created on a fresh config becomes the active one", () => {
    upsertProfile("prod", { apiKey: "eg_prod_key_1234567890" });
    expect(activeProfileName()).toBe("prod");
    expect(resolveApiKey()).toBe("eg_prod_key_1234567890");

    // …but the SECOND does not silently steal the selection.
    upsertProfile("stage", { apiKey: "eg_stage_key_1234567890" });
    expect(activeProfileName()).toBe("prod");
  });

  it.skipIf(process.platform === "win32")("writes 0600 in a 0700 directory", () => {
    const nested = path.join(tmpDir, "nested", "config.json");
    upsertProfile("prod", { apiKey: "eg_prod_key_1234567890" }, { file: nested });
    expect(fs.statSync(nested).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(nested)).mode & 0o777).toBe(0o700);
  });
});

/* ── what `evalguard profile` renders ───────────────────────────────────── */

describe("profile command helpers", () => {
  it("rows mark the active profile, mask keys and resolve the base URL", () => {
    upsertProfile("saas", { apiKey: "eg_live_abcdef1234567890" }, { switchTo: true });
    upsertProfile("self-hosted", {
      apiKey: "eg_live_zyxwvu0987654321",
      baseUrl: "https://eg.corp.internal",
      projectId: "proj_1",
    });

    const rows = profileRows(loadConfigFile());
    expect(rows.map((r) => r.name)).toEqual(["saas", "self-hosted"]);
    // Plaintext backend (see the module header), so the row masks the stored
    // key AND flags that it is unencrypted. A protected key renders as a label
    // instead — asserted in secret-store.test.ts.
    expect(rows.find((r) => r.name === "saas")).toMatchObject({
      current: true,
      baseUrl: DEFAULT_BASE_URL,
      apiKey: "eg_live...7890 (plaintext)",
      protection: "plaintext",
    });
    // Un-versioned base URLs are normalized for display, so the row shows the
    // URL the CLI will actually call.
    expect(rows.find((r) => r.name === "self-hosted")).toMatchObject({
      current: false,
      baseUrl: "https://eg.corp.internal/api/v1",
      projectId: "proj_1",
    });
    // Never print the whole secret.
    for (const row of rows) expect(row.apiKey).not.toContain("abcdef1234567890");
  });

  it("a migrated flat config shows up as a single default profile", () => {
    writeRaw(LEGACY_FLAT);
    const rows = profileRows(loadConfigFile());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: DEFAULT_PROFILE, current: true, baseUrl: LEGACY_FLAT.baseUrl });
  });

  it("surfaces the env vars that override the selected profile", () => {
    expect(activeOverrides({} as NodeJS.ProcessEnv)).toEqual([]);
    const overrides = activeOverrides({
      EVALGUARD_PROFILE: "stage",
      EVALGUARD_API_KEY: "eg_x",
      EVALGUARD_BASE_URL: "https://x.test",
    } as NodeJS.ProcessEnv);
    expect(overrides).toEqual([
      "EVALGUARD_PROFILE=stage",
      "EVALGUARD_API_KEY (overrides the profile's apiKey)",
      "EVALGUARD_BASE_URL (overrides the profile's baseUrl)",
    ]);
  });
});
