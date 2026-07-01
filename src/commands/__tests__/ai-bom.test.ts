import { describe, expect, it, vi } from "vitest";
import { fetchAiBom, collectScanInputs, runSbomScan, severityGateFails } from "../ai-bom.js";
import type { SbomScanResult } from "../ai-bom.js";

const PROJECT = "00000000-0000-4000-8000-000000000001";

function mockResponse(body: string, opts: { status?: number; cd?: string; ct?: string } = {}): Response {
  return new Response(body, {
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
      return mockResponse('{"bomFormat":"CycloneDX"}', {
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

    expect(out.body).toBe('{"bomFormat":"CycloneDX"}');
    expect(out.suggestedFilename).toBe("ai-bom-from-server.cdx.json");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to a sensible filename when server omits Content-Disposition", async () => {
    const fetchImpl = vi.fn(async () => mockResponse("{}", {})) as unknown as typeof fetch;
    const out = await fetchAiBom({
      projectId: PROJECT,
      format: "spdx",
      baseUrl: "https://x.test/api/v1",
      apiKey: "k",
      fetchImpl,
    });
    expect(out.suggestedFilename).toMatch(/^evalguard-ai-bom-00000000\.spdx\.json$/);
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
