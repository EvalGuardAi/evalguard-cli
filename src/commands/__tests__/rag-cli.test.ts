// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerRag } from "../rag.js";

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ data }) };
}

describe("CLI — rag ingest (E2E, fetch mocked)", () => {
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

  it("reads a documents JSON file and POSTs it to /rag/ingest", async () => {
    const f = vi.fn(async () => jsonResponse({ chunkCount: 3, embedded: false, chunks: [] }));
    globalThis.fetch = f as unknown as typeof fetch;

    const tmp = path.join(os.tmpdir(), `eg-rag-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ documents: [{ text: "hello world" }], chunking: { strategy: "recursive" } }));
    try {
      const program = new Command();
      program.exitOverride();
      registerRag(program);
      await program.parseAsync(["rag", "ingest", "--file", tmp], { from: "user" });
    } finally {
      fs.rmSync(tmp, { force: true });
    }

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/rag/ingest");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string).documents[0].text).toBe("hello world");
  });
});
