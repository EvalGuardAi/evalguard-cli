/**
 * E6 (2026-05-19): per-command tests for the three destructive CLI
 * commands that previously had no dedicated test coverage:
 *
 *   - `evalguard delete`        (delete eval/scan runs from local store)
 *   - `evalguard cache clear`   (drop the entire LLM-response cache)
 *   - `evalguard budget clear`  (remove the monthly spend cap on a key)
 *
 * Each gets a structural test (the registered `--dry-run` option is
 * present and reachable through commander) and a behavior test (running
 * the command with `--dry-run` does NOT trigger the underlying
 * destructive operation — disk write, cache wipe, or DELETE API call).
 *
 * These tests intentionally avoid hitting the network or the real
 * filesystem. They are the floor coverage requested in the E6 fix-list
 * entry — broader command coverage is tracked as future work.
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

// ESM namespaces aren't spy-able (see vitest #1830). Use vi.mock to
// substitute the whole `node:fs` module for the delete-command test.
const fsMocks = {
  exists: true,
  readJson: "[]",
  writeCalls: [] as unknown[][],
};
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => fsMocks.exists),
  readFileSync: vi.fn(() => fsMocks.readJson),
  writeFileSync: vi.fn((...args: unknown[]) => {
    fsMocks.writeCalls.push(args);
  }),
}));

import { registerDelete } from "../commands/delete";
import { registerCache } from "../commands/cache";
import { registerBudget } from "../commands/budget";
import { registerKeys } from "../commands/keys";
import { registerSiem } from "../commands/siem";

function findOption(cmd: Command, flag: string): boolean {
  return cmd.options.some((o) => o.long === flag || o.short === flag);
}

// ──────────────────────────────────────────────────────────────────────
// delete
// ──────────────────────────────────────────────────────────────────────

describe("delete command", () => {
  it("registers a --dry-run option", () => {
    const program = new Command();
    registerDelete(program);
    const cmd = program.commands.find((c) => c.name() === "delete");
    expect(cmd).toBeDefined();
    expect(findOption(cmd!, "--dry-run")).toBe(true);
  });

  it("registers a --confirm option (skip-prompt safety)", () => {
    const program = new Command();
    registerDelete(program);
    const cmd = program.commands.find((c) => c.name() === "delete")!;
    expect(findOption(cmd, "--confirm")).toBe(true);
  });

  it("--dry-run does NOT write to disk even with --all + --confirm", async () => {
    // Pretend the local store has two runs.
    const fakeRuns = [
      { id: "r1", name: "alpha", type: "eval", timestamp: "2026-01-01T00:00:00.000Z" },
      { id: "r2", name: "beta", type: "scan", timestamp: "2026-02-01T00:00:00.000Z" },
    ];
    fsMocks.exists = true;
    fsMocks.readJson = JSON.stringify(fakeRuns);
    fsMocks.writeCalls = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const program = new Command();
      // Disable commander's exit-on-error behaviour so a parse failure
      // surfaces as a thrown exception instead of process.exit(1).
      program.exitOverride();
      registerDelete(program);
      await program.parseAsync(
        ["node", "evalguard", "delete", "--all", "--dry-run", "--confirm"],
      );

      // The destructive disk write must NOT have happened.
      expect(fsMocks.writeCalls).toHaveLength(0);
      // And the dry-run banner should appear.
      const printed = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(printed).toMatch(/dry-run/);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// cache clear
// ──────────────────────────────────────────────────────────────────────

describe("cache clear subcommand", () => {
  it("registers a --dry-run option", () => {
    const program = new Command();
    registerCache(program);
    const cache = program.commands.find((c) => c.name() === "cache")!;
    const clear = cache.commands.find((c) => c.name() === "clear")!;
    expect(clear).toBeDefined();
    expect(findOption(clear, "--dry-run")).toBe(true);
  });

  it("--dry-run does NOT call EvalCache.clear()", async () => {
    const clearMock = vi.fn();
    const getStatsMock = vi.fn().mockReturnValue({
      entries: 7,
      sizeBytes: 1234,
      hits: 0,
      misses: 0,
      hitRate: 0,
    });
    // Use vi.fn(function ...) so `new EvalCache()` works (vitest 4
    // requires constructor mocks declared this way — see
    // `feedback_vitest4_constructor_mocks.md`).
    const EvalCacheMock = vi.fn(function MockEvalCache(this: unknown) {
      // @ts-expect-error — mock this assignment
      this.clear = clearMock;
      // @ts-expect-error — mock this assignment
      this.getStats = getStatsMock;
    });
    vi.doMock("@evalguard/core", () => ({ EvalCache: EvalCacheMock }));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      // Re-import after doMock so the action sees the mocked module.
      const { registerCache: registerCacheFresh } = await import("../commands/cache");
      const program = new Command();
      program.exitOverride();
      registerCacheFresh(program);
      await program.parseAsync(["node", "evalguard", "cache", "clear", "--dry-run"]);
      expect(clearMock).not.toHaveBeenCalled();
      expect(getStatsMock).toHaveBeenCalled();
    } finally {
      vi.doUnmock("@evalguard/core");
      logSpy.mockRestore();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// budget clear
// ──────────────────────────────────────────────────────────────────────

describe("budget clear subcommand", () => {
  it("registers a --dry-run option", () => {
    const program = new Command();
    registerBudget(program);
    const budget = program.commands.find((c) => c.name() === "budget")!;
    const clear = budget.commands.find((c) => c.name() === "clear")!;
    expect(clear).toBeDefined();
    expect(findOption(clear, "--dry-run")).toBe(true);
  });

  it("--dry-run does NOT issue a DELETE request", async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.EVALGUARD_API_KEY;
    process.env.EVALGUARD_API_KEY = "test-key-for-dry-run";

    // Capture every fetch call; return the current budget on GET, blow
    // up on anything else so a stray DELETE during dry-run is obvious.
    const fetchSpy = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init || (init.method ?? "GET").toUpperCase() === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              keyId: "00000000-0000-4000-8000-000000000001",
              monthlyBudgetUsd: 100,
              currentPeriodSpentUsd: 12.34,
              currentPeriodStartedAt: "2026-05-01T00:00:00.000Z",
              remainingUsd: 87.66,
              percentUsed: 12.34,
            },
          }),
        } as unknown as Response;
      }
      throw new Error(`unexpected ${init.method} request during dry-run`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const program = new Command();
      program.exitOverride();
      registerBudget(program);
      await program.parseAsync([
        "node",
        "evalguard",
        "budget",
        "clear",
        "00000000-0000-4000-8000-000000000001",
        "--dry-run",
      ]);

      // Only a single GET should have fired; no DELETE.
      const methods = fetchSpy.mock.calls.map(
        ([, init]: [unknown, RequestInit?]) => (init?.method ?? "GET").toUpperCase(),
      );
      expect(methods).toEqual(["GET"]);
      expect(methods).not.toContain("DELETE");
    } finally {
      globalThis.fetch = originalFetch;
      process.env.EVALGUARD_API_KEY = originalKey;
      logSpy.mockRestore();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// keys remove (T1.4b — 2026-05-20)
// ──────────────────────────────────────────────────────────────────────

describe("keys remove subcommand", () => {
  it("registers a --dry-run option", () => {
    const program = new Command();
    registerKeys(program);
    const keys = program.commands.find((c) => c.name() === "keys")!;
    const remove = keys.commands.find((c) => c.name() === "remove")!;
    expect(remove).toBeDefined();
    expect(findOption(remove, "--dry-run")).toBe(true);
  });

  it("registers a --yes confirmation option", () => {
    const program = new Command();
    registerKeys(program);
    const keys = program.commands.find((c) => c.name() === "keys")!;
    const remove = keys.commands.find((c) => c.name() === "remove")!;
    expect(findOption(remove, "--yes")).toBe(true);
  });

  it("--dry-run does NOT issue a DELETE request", async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.EVALGUARD_API_KEY;
    const originalOrg = process.env.EVALGUARD_ORG_ID;
    process.env.EVALGUARD_API_KEY = "test-key";
    process.env.EVALGUARD_ORG_ID = "00000000-0000-4000-8000-000000000099";

    const fetchSpy = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init || (init.method ?? "GET").toUpperCase() === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              key: {
                id: "k1",
                provider: "openai",
                project_id: null,
                label: "prod",
                key_last4: "abcd",
                created_at: "2026-01-01T00:00:00.000Z",
                rotated_at: null,
              },
            },
          }),
        } as unknown as Response;
      }
      throw new Error(`unexpected ${init.method} request during dry-run`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const program = new Command();
      program.exitOverride();
      registerKeys(program);
      await program.parseAsync(["node", "evalguard", "keys", "remove", "k1", "--dry-run"]);

      const methods = fetchSpy.mock.calls.map(
        ([, init]: [unknown, RequestInit?]) => (init?.method ?? "GET").toUpperCase(),
      );
      expect(methods).toEqual(["GET"]);
      expect(methods).not.toContain("DELETE");
    } finally {
      globalThis.fetch = originalFetch;
      process.env.EVALGUARD_API_KEY = originalKey;
      process.env.EVALGUARD_ORG_ID = originalOrg;
      logSpy.mockRestore();
    }
  });

  it("without --yes and without --dry-run refuses to proceed", async () => {
    // The confirm gate must fail closed: an operator typing `evalguard
    // keys remove k1` with no flags should be told off, not silently
    // delete. We rely on commander's exitOverride to surface the
    // process.exit(1) as a thrown CommanderError.
    const originalKey = process.env.EVALGUARD_API_KEY;
    const originalOrg = process.env.EVALGUARD_ORG_ID;
    process.env.EVALGUARD_API_KEY = "test-key";
    process.env.EVALGUARD_ORG_ID = "00000000-0000-4000-8000-000000000099";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    try {
      const program = new Command();
      program.exitOverride();
      registerKeys(program);
      await expect(
        program.parseAsync(["node", "evalguard", "keys", "remove", "k1"]),
      ).rejects.toThrow(/process\.exit\(1\)/);
      const errMsg = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(errMsg).toMatch(/--yes.*--dry-run/);
    } finally {
      process.env.EVALGUARD_API_KEY = originalKey;
      process.env.EVALGUARD_ORG_ID = originalOrg;
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// siem tokens revoke (T1.4b — 2026-05-20)
// ──────────────────────────────────────────────────────────────────────

describe("siem tokens revoke subcommand", () => {
  it("registers --dry-run and --yes options", () => {
    const program = new Command();
    registerSiem(program);
    const siem = program.commands.find((c) => c.name() === "siem")!;
    const tokens = siem.commands.find((c) => c.name() === "tokens")!;
    const revoke = tokens.commands.find((c) => c.name() === "revoke")!;
    expect(revoke).toBeDefined();
    expect(findOption(revoke, "--dry-run")).toBe(true);
    expect(findOption(revoke, "--yes")).toBe(true);
  });

  it("--dry-run does NOT issue a DELETE request", async () => {
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.EVALGUARD_API_KEY;
    process.env.EVALGUARD_API_KEY = "test-key";

    const fetchSpy = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init || (init.method ?? "GET").toUpperCase() === "GET") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              token: {
                id: "t1",
                source: "splunk",
                label: "prod",
                allowed_actions: ["quarantine_key"],
                revoked: false,
                last_used_at: null,
              },
            },
          }),
        } as unknown as Response;
      }
      throw new Error(`unexpected ${init.method} request during dry-run`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const program = new Command();
      program.exitOverride();
      registerSiem(program);
      await program.parseAsync([
        "node",
        "evalguard",
        "siem",
        "tokens",
        "revoke",
        "t1",
        "--project",
        "00000000-0000-4000-8000-000000000077",
        "--dry-run",
      ]);

      const methods = fetchSpy.mock.calls.map(
        ([, init]: [unknown, RequestInit?]) => (init?.method ?? "GET").toUpperCase(),
      );
      expect(methods).toEqual(["GET"]);
      expect(methods).not.toContain("DELETE");
    } finally {
      globalThis.fetch = originalFetch;
      process.env.EVALGUARD_API_KEY = originalKey;
      logSpy.mockRestore();
    }
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.restoreAllMocks();
});
