import { describe, expect, it, vi } from "vitest";
import { moderateImage, moderateVideo, detectDeepfake } from "../moderation.js";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const PROJECT = "00000000-0000-4000-8000-000000000001";
const OPTS = { baseUrl: "https://x.test/api/v1", apiKey: "k" };

function okFetch(data: unknown) {
  return vi.fn(
    async (_url: string, _init?: RequestInit) =>
      ({ ok: true, status: 200, json: async () => ({ success: true, data }) }) as unknown as Response,
  );
}

describe("moderation CLI API client", () => {
  it("rejects a non-UUID org", async () => {
    const f = okFetch({});
    await expect(
      moderateImage({ orgId: "nope", projectId: PROJECT, imageUrl: "https://x/y.png", ...OPTS, fetchImpl: f as unknown as typeof fetch }),
    ).rejects.toThrow(/orgId/);
    expect(f).not.toHaveBeenCalled();
  });

  it("requires an image source", async () => {
    const f = okFetch({});
    await expect(
      moderateImage({ orgId: ORG, projectId: PROJECT, ...OPTS, fetchImpl: f as unknown as typeof fetch }),
    ).rejects.toThrow(/imageUrl or imageBase64/);
    expect(f).not.toHaveBeenCalled();
  });

  it("POSTs to /moderation/image and returns the result", async () => {
    const f = okFetch({ flagged: true, score: 0.92, categories: ["violence"] });
    const out = (await moderateImage({
      orgId: ORG,
      projectId: PROJECT,
      imageUrl: "https://x/y.png",
      threshold: 0.6,
      ...OPTS,
      fetchImpl: f as unknown as typeof fetch,
    })) as { data: { flagged: boolean } };
    expect(f).toHaveBeenCalledOnce();
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://x.test/api/v1/moderation/image");
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent).toMatchObject({ orgId: ORG, projectId: PROJECT, imageUrl: "https://x/y.png", threshold: 0.6 });
    expect(out.data.flagged).toBe(true);
  });

  it("surfaces a non-OK API error message", async () => {
    const f = vi.fn(
      async () =>
        ({ ok: false, status: 400, json: async () => ({ error: { message: "PROVIDER_KEY_UNAVAILABLE" } }) }) as unknown as Response,
    );
    await expect(
      moderateImage({ orgId: ORG, projectId: PROJECT, imageUrl: "https://x/y.png", ...OPTS, fetchImpl: f as unknown as typeof fetch }),
    ).rejects.toThrow(/PROVIDER_KEY_UNAVAILABLE/);
  });

  it("moderateVideo requires at least one frame + POSTs to /moderation/video", async () => {
    const f0 = okFetch({});
    await expect(
      moderateVideo({ orgId: ORG, projectId: PROJECT, frames: [], ...OPTS, fetchImpl: f0 as unknown as typeof fetch }),
    ).rejects.toThrow(/at least one frame/);

    const f = okFetch({ flagged: true, score: 0.9, categories: ["violence"], framesEvaluated: 2 });
    await moderateVideo({
      orgId: ORG,
      projectId: PROJECT,
      frames: [{ imageUrl: "https://x/0.png" }, { imageUrl: "https://x/1.png" }],
      ...OPTS,
      fetchImpl: f as unknown as typeof fetch,
    });
    expect(String(f.mock.calls[0][0])).toBe("https://x.test/api/v1/moderation/video");
  });

  it("detectDeepfake requires an image or frames + POSTs to /moderation/deepfake", async () => {
    const f0 = okFetch({});
    await expect(
      detectDeepfake({ orgId: ORG, projectId: PROJECT, ...OPTS, fetchImpl: f0 as unknown as typeof fetch }),
    ).rejects.toThrow(/image.*frames/);

    const f = okFetch({ kind: "image", synthetic: true, probability: 0.8 });
    const out = (await detectDeepfake({
      orgId: ORG,
      projectId: PROJECT,
      imageUrl: "https://x/y.png",
      ...OPTS,
      fetchImpl: f as unknown as typeof fetch,
    })) as { data: { synthetic: boolean } };
    expect(String(f.mock.calls[0][0])).toBe("https://x.test/api/v1/moderation/deepfake");
    expect(out.data.synthetic).toBe(true);
  });
});
