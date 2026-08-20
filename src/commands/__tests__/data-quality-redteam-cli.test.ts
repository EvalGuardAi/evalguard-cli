// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { jsonResponse } from "../../__tests__/helpers/response-double.js";
import { registerRedTeam } from "../red-team.js";
import { registerDatasets } from "../datasets.js";

// Real Response — the CLI reads bodies with `res.text()` at its shared
// fail-closed decode boundary (lib/http.ts); a `.json()`-only double does not
// exercise the path the shipped CLI takes.
function envelope(data: unknown): Response {
  return jsonResponse({ data });
}

describe("CLI — red-team-plan + datasets health (E2E, fetch mocked)", () => {
  const origFetch = globalThis.fetch;
  const origKey = process.env.EVALGUARD_API_KEY;

  beforeEach(() => {
    process.env.EVALGUARD_API_KEY = "eg_test";
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origKey === undefined) delete process.env.EVALGUARD_API_KEY;
    else process.env.EVALGUARD_API_KEY = origKey;
    vi.restoreAllMocks();
  });

  it("red-team-plan: POSTs capability flags to /security/red-team-plan", async () => {
    const f = vi.fn(async () =>
      envelope({ plan: { categories: [{ id: "mcp-attack", name: "MCP", pluginCount: 3 }], plugins: [], totalPlugins: 3 } }),
    );
    globalThis.fetch = f as unknown as typeof fetch;

    const program = new Command();
    program.exitOverride();
    registerRedTeam(program);
    await program.parseAsync(["red-team-plan", "--mcp", "--code"], { from: "user" });

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/security/red-team-plan");
    expect(init.method).toBe("POST");
    const caps = JSON.parse(init.body as string);
    expect(caps.usesMcp).toBe(true);
    expect(caps.executesCode).toBe(true);
    expect(caps.usesTools).toBe(false);
  });

  it("datasets health: reads a JSON file and POSTs it to /datasets/health", async () => {
    const f = vi.fn(async () =>
      envelope({ health: { rowCount: 4, nonIid: { score: 0.2, nonIid: true } }, labelQuality: { issueCount: 1, estimatedNoiseRate: 0.25 } }),
    );
    globalThis.fetch = f as unknown as typeof fetch;

    const tmp = path.join(os.tmpdir(), `eg-health-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ labels: [0, 0, 0, 1], embeddings: [[1, 0], [0.99, 0.01], [0.98, 0], [0, 1]] }));
    try {
      const program = new Command();
      program.exitOverride();
      registerDatasets(program);
      await program.parseAsync(["datasets", "health", "--file", tmp], { from: "user" });
    } finally {
      fs.rmSync(tmp, { force: true });
    }

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/datasets/health");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string).labels).toEqual([0, 0, 0, 1]);
  });
});
