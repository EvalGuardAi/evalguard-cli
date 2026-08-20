import { describe, expect, it, vi } from "vitest";
import { fetchAiBom, collectScanInputs, runSbomScan, severityGateFails } from "../ai-bom.js";
import type { SbomScanResult } from "../ai-bom.js";

const PROJECT = "00000000-0000-4000-8000-000000000001";

// The AI-BOM route emits THREE DOCUMENTS, one per standard — it used to emit
// one shape and vary `bomFormat` on it, which was conformant to neither
// (`45f06d350`, apps/web/src/app/api/v1/ai-sbom/_formats.ts). SPDX 2.3's root
// is `additionalProperties: false`, so an SPDX document cannot carry
// `bomFormat`/`specVersion`/`components` at all; these fixtures are the shapes
// `buildCycloneDx16` / `buildSpdx23` / `buildNativeAiBom` actually produce.
const CDX_DOC = JSON.stringify({
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  version: 1,
  metadata: { timestamp: "2026-08-09T12:00:00.000Z" },
  components: [{ "bom-ref": "evalguard:model:0", type: "machine-learning-model", name: "llama" }],
  dependencies: [{ ref: "evalguard:root" }],
});
const SPDX_DOC = JSON.stringify({
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: "evalguard-ai-bom-00000000",
  documentNamespace: "https://evalguard.ai/spdx/ai-bom/00000000/1111",
  creationInfo: { created: "2026-08-09T12:00:00Z", creators: ["Organization: EvalGuard"] },
  packages: [{ SPDXID: "SPDXRef-Package-Project", name: "project-00000000", filesAnalyzed: false }],
  relationships: [],
});
const DOC_FOR = { cyclonedx: CDX_DOC, spdx: SPDX_DOC } as const;

function mockResponse(body: string, opts: { status?: number; cd?: string; ct?: string } = {}): Response {
  // A 204 carries a NULL body by spec; `new Response("", {status:204})` throws.
  return new Response(opts.status === 204 ? null : body, {
    status: opts.status ?? 200,
    headers: {
      ...(opts.cd ? { "content-disposition": opts.cd } : {}),
      "content-type": opts.ct ?? "application/json",
    },
  });
}

describe("fetchAiBom", () => {
  it("rejects non-UUID projectId before hitting the network", async () => {
    await expect(
      fetchAiBom({
        projectId: "not-a-uuid",
        format: "cyclonedx",
        baseUrl: "https://x.test",
        apiKey: "k",
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/valid v4 UUID/);
  });

  it("calls GET /ai-sbom with projectId + format + Bearer token", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit | undefined) => {
      expect(url).toContain("/ai-sbom?projectId=");
      expect(url).toContain(PROJECT);
      expect(url).toContain("format=cyclonedx");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-key");
      return mockResponse(CDX_DOC, {
        cd: 'attachment; filename="ai-bom-from-server.cdx.json"',
      });
    }) as unknown as typeof fetch;

    const out = await fetchAiBom({
      projectId: PROJECT,
      format: "cyclonedx",
      baseUrl: "https://x.test/api/v1",
      apiKey: "test-key",
      fetchImpl,
    });

    expect(out.body).toBe(CDX_DOC);
    expect(out.suggestedFilename).toBe("ai-bom-from-server.cdx.json");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to a sensible filename when server omits Content-Disposition", async () => {
    // The fixture here used to be `"{}"`. That PINNED the defect: it asserted
    // that an empty object is an acceptable SPDX export — and "accept anything"
    // is exactly how an nginx 502 page and a 0-byte file reached disk as SBOMs
    // (audit 2026-08-09). The body is now what the route actually emits for
    // `--format spdx`: one document shape carrying the SPDX marker
    // (apps/web/src/app/api/v1/ai-sbom/route.ts:69).
    const fetchImpl = vi.fn(async () => mockResponse(SPDX_DOC, {})) as unknown as typeof fetch;
    const out = await fetchAiBom({
      projectId: PROJECT,
      format: "spdx",
      baseUrl: "https://x.test/api/v1",
      apiKey: "k",
      fetchImpl,
    });
    expect(out.suggestedFilename).toMatch(/^evalguard-ai-bom-00000000\.spdx\.json$/);
  });

  it("REFUSES every measured fault body instead of writing it as an SBOM", async () => {
    // The 11 fault modes the pre-fix CLI wrote to disk and reported as
    // `✓ Wrote N bytes to …`, exit 0. Driven through the real code path, not a
    // mock of the validator.
    const faults: Array<[string, string, number?]> = [
      ["invalid JSON", "this is not JSON at all {{{"],
      ["an empty body", ""],
      ["a 204", "", 204],
      ["a JSON null", "null"],
      ["a bare string", '"ok"'],
      ["an unrelated object", '{"hello":"world"}'],
      ["a success envelope with data:null", '{"success":true,"data":null}'],
      ["an empty success envelope", '{"success":true,"data":{}}'],
      ["a 200 carrying an error envelope", '{"success":false,"error":{"message":"boom"}}'],
      ["an nginx 502 page", "<html>\n<head><title>502 Bad Gateway</title></head>\n</html>"],
      ["2 MB of filler", "x".repeat(2 * 1024 * 1024)],
    ];
    for (const [what, body, status] of faults) {
      const fetchImpl = vi.fn(async () =>
        mockResponse(body, { status: status ?? 200 }),
      ) as unknown as typeof fetch;
      await expect(
        fetchAiBom({
          projectId: PROJECT,
          format: "cyclonedx",
          baseUrl: "https://x.test/api/v1",
          apiKey: "k",
          fetchImpl,
        }),
        `${what} must never become an SBOM`,
      ).rejects.toThrow(/was NOT written/);
    }
  });

  it.each(["cyclonedx", "spdx"] as const)("accepts a real --format %s document (control)", async (format) => {
    const doc = DOC_FOR[format];
    const fetchImpl = vi.fn(async () => mockResponse(doc, {})) as unknown as typeof fetch;
    const out = await fetchAiBom({
      projectId: PROJECT,
      format,
      baseUrl: "https://x.test/api/v1",
      apiKey: "k",
      fetchImpl,
    });
    expect(out.body).toBe(doc);
  });

  it("accepts --format json inside the apiSuccess envelope the route uses (control)", async () => {
    // The route returns a BARE document for cyclonedx/spdx and `apiSuccess(sbom)`
    // for json (route.ts:117-130). Refusing the envelope for json would reject
    // the server's own output.
    const enveloped = JSON.stringify({
      success: true,
      data: { bomFormat: "EvalGuard-AIBOM", specVersion: "1.0.0", components: { models: [] } },
    });
    const fetchImpl = vi.fn(async () => mockResponse(enveloped, {})) as unknown as typeof fetch;
    const out = await fetchAiBom({
      projectId: PROJECT,
      format: "json",
      baseUrl: "https://x.test/api/v1",
      apiKey: "k",
      fetchImpl,
    });
    expect(out.body).toBe(enveloped);
  });

  it("refuses a CycloneDX document when SPDX was requested", async () => {
    // The two standards no longer share a field, so a CycloneDX export offered
    // as SPDX fails on SPDX's own marker rather than on a mismatched value —
    // but the outcome that matters is unchanged: it is not filed as an SPDX
    // artifact. Asserted on the SPECIFIC reason, not just "some refusal", so a
    // future loosening cannot pass this row by refusing for an unrelated cause.
    const fetchImpl = vi.fn(async () => mockResponse(CDX_DOC, {})) as unknown as typeof fetch;
    await expect(
      fetchAiBom({
        projectId: PROJECT,
        format: "spdx",
        baseUrl: "https://x.test/api/v1",
        apiKey: "k",
        fetchImpl,
      }),
    ).rejects.toThrow(/declares no `spdxVersion`.*`--format spdx` asked for/);
    // ...and the reverse: an SPDX-shaped document is refused for cyclonedx.
    const back = vi.fn(async () => mockResponse(SPDX_DOC, {})) as unknown as typeof fetch;
    await expect(
      fetchAiBom({ projectId: PROJECT, format: "cyclonedx", baseUrl: "https://x.test/api/v1", apiKey: "k", fetchImpl: back }),
    ).rejects.toThrow(/declares no `bomFormat`/);
  });

  it("refuses a document claiming the WRONG SPDX version — value, not mere presence", async () => {
    // The marker rule is a VALUE check. An SPDX 2.2 document is structurally
    // an SPDX document, so only the value distinguishes it, and archiving it
    // as the 2.3 export we advertise would misstate what the auditor holds.
    const doc = JSON.stringify({ ...(JSON.parse(SPDX_DOC) as object), spdxVersion: "SPDX-2.2" });
    const fetchImpl = vi.fn(async () => mockResponse(doc, {})) as unknown as typeof fetch;
    await expect(
      fetchAiBom({ projectId: PROJECT, format: "spdx", baseUrl: "https://x.test/api/v1", apiKey: "k", fetchImpl }),
    ).rejects.toThrow(/"SPDX-2.2" but "SPDX-2.3" was requested/);
    // control: the same document with the right version is accepted.
    const ok = vi.fn(async () => mockResponse(SPDX_DOC, {})) as unknown as typeof fetch;
    await expect(
      fetchAiBom({ projectId: PROJECT, format: "spdx", baseUrl: "https://x.test/api/v1", apiKey: "k", fetchImpl: ok }),
    ).resolves.toBeTruthy();
  });

  it("surfaces structured error body when server returns 4xx", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse(JSON.stringify({ error: { code: "FORBIDDEN", message: "not your project" } }), {
        status: 403,
      }),
    ) as unknown as typeof fetch;
    await expect(
      fetchAiBom({
        projectId: PROJECT,
        format: "cyclonedx",
        baseUrl: "https://x.test/api/v1",
        apiKey: "k",
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTP 403.*FORBIDDEN.*not your project/);
  });

  it("falls back to text error capture when server returns plain-text 5xx", async () => {
    const fetchImpl = vi.fn(async () => mockResponse("internal: boom", { status: 500, ct: "text/plain" })) as unknown as typeof fetch;
    await expect(
      fetchAiBom({
        projectId: PROJECT,
        format: "json",
        baseUrl: "https://x.test/api/v1",
        apiKey: "k",
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("collectScanInputs", () => {
  function mockFs(files: Record<string, string>) {
    return {
      existsSync: vi.fn((p: string) => Object.keys(files).some((f) => String(p).endsWith(f))),
      readFileSync: vi.fn((p: string) => {
        const hit = Object.entries(files).find(([f]) => String(p).endsWith(f));
        if (!hit) throw new Error("ENOENT");
        return hit[1];
      }),
    } as unknown as Pick<typeof import("fs"), "existsSync" | "readFileSync">;
  }

  it("collects every supported manifest/lockfile that exists", () => {
    const { inputs, found, warnings } = collectScanInputs("/proj", mockFs({
      "package.json": '{"dependencies":{"openai":"^4.0.0"}}',
      "package-lock.json": '{"lockfileVersion":3,"packages":{}}',
      "requirements.txt": "requests==2.31.0",
      "poetry.lock": '[[package]]\nname = "requests"\nversion = "2.31.0"',
    }));
    expect(found.sort()).toEqual(["package-lock.json", "package.json", "poetry.lock", "requirements.txt"]);
    expect(inputs.packageJson).toEqual({ dependencies: { openai: "^4.0.0" } });
    expect(inputs.packageLockJson).toEqual({ lockfileVersion: 3, packages: {} });
    expect(inputs.pythonRequirements).toBe("requests==2.31.0");
    expect(inputs.poetryLock).toContain("requests");
    expect(warnings).toEqual([]);
  });

  it("skips malformed JSON with a warning instead of aborting", () => {
    const { inputs, found, warnings } = collectScanInputs("/proj", mockFs({
      "package.json": "{not json",
      "requirements.txt": "requests==2.31.0",
    }));
    expect(inputs.packageJson).toBeUndefined();
    expect(found).toEqual(["requirements.txt"]);
    expect(warnings[0]).toMatch(/package\.json: invalid JSON/);
  });
});

describe("runSbomScan", () => {
  const SCAN_DATA = {
    data: {
      bom: { vulnerabilities: [{ cveId: "CVE-2024-1", affectedPackage: "torch", severity: "high", cvssScore: 8.1, description: "x" }] },
      supplyChain: {
        typosquats: [{ packageName: "reqeusts", similarTo: "requests", severity: "high", reason: "r" }],
        scan: { mode: "live", liveStatus: "ok", packagesQueried: 2, truncatedAdvisoryCount: 0 },
        dependencyResolution: { resolved: 2, truncated: 0 },
      },
    },
  };

  it("POSTs inputs with liveCveScan + Bearer token and unwraps the result", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit | undefined) => {
      expect(url).toBe("https://x.test/api/v1/ai-sbom/generate");
      const body = JSON.parse(String(init?.body));
      expect(body.liveCveScan).toBe(false);
      expect(body.projectName).toBe("demo");
      expect(body.pythonRequirements).toBe("torch==2.0.0");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer k");
      return mockResponse(JSON.stringify(SCAN_DATA));
    }) as unknown as typeof fetch;

    const result = await runSbomScan({
      projectName: "demo",
      inputs: { pythonRequirements: "torch==2.0.0" },
      live: false,
      baseUrl: "https://x.test/api/v1",
      apiKey: "k",
      fetchImpl,
    });
    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.typosquats[0].packageName).toBe("reqeusts");
    expect(result.scan.liveStatus).toBe("ok");
  });

  it("throws a structured error on 4xx", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "bad key" } }), { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(
      runSbomScan({ projectName: "d", inputs: {}, live: true, baseUrl: "https://x.test/api/v1", apiKey: "k", fetchImpl }),
    ).rejects.toThrow(/HTTP 401.*UNAUTHORIZED/);
  });

  it("throws on a response missing the supplyChain block", async () => {
    const fetchImpl = vi.fn(async () => mockResponse(JSON.stringify({ data: { bom: {} } }))) as unknown as typeof fetch;
    await expect(
      runSbomScan({ projectName: "d", inputs: {}, live: true, baseUrl: "https://x.test/api/v1", apiKey: "k", fetchImpl }),
    ).rejects.toThrow(/missing supplyChain/);
  });
});

describe("severityGateFails", () => {
  const base: SbomScanResult = {
    vulnerabilities: [],
    typosquats: [],
    scan: { mode: "live", liveStatus: "ok", packagesQueried: 0, truncatedAdvisoryCount: 0 },
    dependencyResolution: { resolved: 0, truncated: 0 },
  };
  const vuln = (severity: string) => ({ cveId: "C", affectedPackage: "p", severity, cvssScore: 5, description: "d" });

  it("passes a clean scan at any threshold", () => {
    expect(severityGateFails(base, "low")).toBe(false);
  });

  it("fails when a vulnerability reaches the threshold", () => {
    expect(severityGateFails({ ...base, vulnerabilities: [vuln("high")] }, "high")).toBe(true);
    expect(severityGateFails({ ...base, vulnerabilities: [vuln("high")] }, "critical")).toBe(false);
    expect(severityGateFails({ ...base, vulnerabilities: [vuln("medium")] }, "low")).toBe(true);
  });

  it("typosquats count toward the gate", () => {
    const squat = { packageName: "lodahs", similarTo: "lodash", severity: "high", reason: "r" };
    expect(severityGateFails({ ...base, typosquats: [squat] }, "high")).toBe(true);
    expect(severityGateFails({ ...base, typosquats: [squat] }, "critical")).toBe(false);
  });
});
