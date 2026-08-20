import { describe, expect, it, vi } from "vitest";
import { jsonResponse } from "../../__tests__/helpers/response-double.js";
import { rememberMemory, recallMemory, forgetMemory } from "../agent-memory.js";
import { transcribeVoice, scoreDeepfake } from "../voice.js";

const PROJECT = "00000000-0000-4000-8000-000000000001";
const OPTS = { baseUrl: "https://x.test/api/v1", apiKey: "k" };

function okFetch(data: unknown) {
  return vi.fn(
    async (_url: string, _init?: RequestInit) =>
      // Real Response: the CLI decodes bodies via `res.text()` at its shared
      // fail-closed boundary (lib/http.ts), which a `.json()`-only double lacks.
      jsonResponse({ success: true, data }),
  );
}

describe("agent-memory CLI API client", () => {
  it("remember: rejects a non-UUID project before any network call", async () => {
    const f = vi.fn();
    await expect(
      rememberMemory({ projectId: "nope", sessionKey: "s", facts: ["x"], ...OPTS, fetchImpl: f as unknown as typeof fetch }),
    ).rejects.toThrow(/UUID/);
    expect(f).not.toHaveBeenCalled();
  });

  it("remember: requires at least one fact", async () => {
    const f = vi.fn();
    await expect(
      rememberMemory({ projectId: PROJECT, sessionKey: "s", facts: [], ...OPTS, fetchImpl: f as unknown as typeof fetch }),
    ).rejects.toThrow(/fact/);
    expect(f).not.toHaveBeenCalled();
  });

  it("remember: POST /agent-memory with facts + Bearer token", async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/agent-memory");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer k");
      expect(JSON.parse(String(init?.body))).toMatchObject({ projectId: PROJECT, sessionKey: "s", facts: ["likes tea"] });
      return jsonResponse({ success: true, data: { written: ["likes tea"], skipped: [] } }, 201);
    });
    const out = (await rememberMemory({ projectId: PROJECT, sessionKey: "s", facts: ["likes tea"], ...OPTS, fetchImpl: f as unknown as typeof fetch })) as {
      data: { written: string[] };
    };
    expect(out.data.written).toEqual(["likes tea"]);
  });

  it("recall: GET /agent-memory with query params", async () => {
    const f = vi.fn(async (url: string) => {
      expect(url).toContain("/agent-memory?");
      expect(url).toContain("query=coffee");
      expect(url).toContain("limit=3");
      return jsonResponse({ success: true, data: { semantic: [] } });
    });
    await recallMemory({ projectId: PROJECT, sessionKey: "s", query: "coffee", limit: 3, ...OPTS, fetchImpl: f as unknown as typeof fetch });
    expect(f).toHaveBeenCalledOnce();
  });

  it("forget: DELETE /agent-memory", async () => {
    const f = okFetch({ forgotten: 1 });
    await forgetMemory({ projectId: PROJECT, sessionKey: "s", ...OPTS, fetchImpl: f as unknown as typeof fetch });
    expect((f.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
  });
});

describe("voice CLI API client", () => {
  it("transcribe: rejects a non-UUID project", async () => {
    const f = vi.fn();
    await expect(
      transcribeVoice({ projectId: "nope", audioBase64: "d2F2", ...OPTS, fetchImpl: f as unknown as typeof fetch }),
    ).rejects.toThrow(/UUID/);
    expect(f).not.toHaveBeenCalled();
  });

  it("transcribe: POST /voice/transcribe", async () => {
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/voice/transcribe");
      expect(JSON.parse(String(init?.body))).toMatchObject({ projectId: PROJECT, audioBase64: "d2F2", language: "en" });
      return jsonResponse({ success: true, data: { text: "hi", words: [] } });
    });
    await transcribeVoice({ projectId: PROJECT, audioBase64: "d2F2", language: "en", ...OPTS, fetchImpl: f as unknown as typeof fetch });
    expect(f).toHaveBeenCalledOnce();
  });

  it("deepfake: POST /voice/deepfake-score", async () => {
    const f = okFetch({ probability: 0.9 });
    const out = (await scoreDeepfake({ projectId: PROJECT, audioBase64: "d2F2", ...OPTS, fetchImpl: f as unknown as typeof fetch })) as {
      data: { probability: number };
    };
    expect(out.data.probability).toBe(0.9);
    expect(f.mock.calls[0][0]).toContain("/voice/deepfake-score");
  });
});
