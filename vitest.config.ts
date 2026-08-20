import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    exclude: ["dist/**", "node_modules/**"],
    // Same root-cause fix as worker/vitest.config.ts (#155): CLI test
    // files use vi.mock("node:fs") + register Commander commands on
    // shared program state + spawn child processes. Under vitest's
    // default `threads` pool these mocks leak across files and break
    // E2E tests that exec the real CLI surface. `forks` gives each
    // file its own Node process — process.argv / process.cwd / fs
    // mock state are all private.
    //
    // Cost: ~150ms total fork-startup overhead on a 14-file suite
    // (measured: 9.7s → 14.6s) — worth it for determinism.
    pool: "forks",
    // The CLI smoke/import + scan tests transpile + load the whole command
    // graph (and spawn child processes / walk dirs) inside a fresh fork. On a
    // slow box, or under the pre-push hook running every package suite in
    // parallel, the cold-transform import alone lands at ~30s — right on
    // vitest's default per-test timeout, so it flakes locally even though it
    // passes comfortably in CI. Give these import-heavy tests real headroom;
    // it does not slow the green path (fast tests still finish in ms).
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
