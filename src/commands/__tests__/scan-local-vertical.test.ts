import { describe, it, expect } from "vitest";
import { selectVerticalPlugins } from "../scan-local.js";

/* `evalguard scan:local --vertical <id>` selects a consolidated vertical
 * attack pack's plugins. selectVerticalPlugins is the pure helper the .action()
 * closure calls (the closure itself calls process.exit, which would hijack the
 * runner), so we drive it directly against the REAL @evalguard/core registry. */
// Import-phase warm-up. `await import()` inside a test body is billed against
// `testTimeout`, and this file reaches `@evalguard/core` lazily, so the first
// case to touch it paid for the whole 2,173-file graph — ~5 s idle, and past
// the budget under the pre-push sweep. Loading it here moves that cost into
// the file's import phase, which vitest bills against no per-test budget.
// Must be top-level `await import`, not a static import: vitest hoists
// `vi.mock` above static imports. Full rationale: src/__tests__/cli-smoke.test.ts
await import("@evalguard/core");

describe("scan:local --vertical → selectVerticalPlugins", () => {
  it("selects the pack's plugin ids for a canonical vertical id", async () => {
    const { getVerticalPack, listVerticals, getVerticalPluginIds } = await import("@evalguard/core");
    const ids = selectVerticalPlugins("healthcare", getVerticalPack, listVerticals);
    expect(ids.length).toBeGreaterThan(0);
    // Matches the registry's own member list exactly.
    expect(ids).toEqual([...getVerticalPluginIds("healthcare")]);
    expect(ids).toContain("medical-hallucination");
  });

  it("resolves a legacy alias to the consolidated pack", async () => {
    const { getVerticalPack, listVerticals, getVerticalPluginIds } = await import("@evalguard/core");
    // `finance` is the legacy alias for `financial-services`.
    const ids = selectVerticalPlugins("finance", getVerticalPack, listVerticals);
    expect(ids).toEqual([...getVerticalPluginIds("financial-services")]);
    expect(ids).toContain("finance-money-laundering");
  });

  it("throws a clear, enumerated error for an unknown vertical", async () => {
    const { getVerticalPack, listVerticals } = await import("@evalguard/core");
    expect(() => selectVerticalPlugins("nope", getVerticalPack, listVerticals)).toThrow(
      /Unknown vertical: nope\. Available:/,
    );
  });
});
