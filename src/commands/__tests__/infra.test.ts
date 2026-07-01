import { describe, expect, it } from "vitest";
import { parseInfraTargets, infraGateFails } from "../infra.js";
import type { InfraScanFinding } from "@evalguard/core";

describe("parseInfraTargets", () => {
  it("parses bare hosts, host:port and scheme URLs", () => {
    expect(parseInfraTargets(["10.0.0.5", "ml-box:8265", "https://gpu-host:8000", "http://ollama.internal"])).toEqual([
      { host: "10.0.0.5", port: undefined, scheme: undefined },
      { host: "ml-box", port: 8265, scheme: undefined },
      { host: "gpu-host", port: 8000, scheme: "https" },
      { host: "ollama.internal", port: undefined, scheme: "http" },
    ]);
  });

  it("rejects CIDR ranges and wildcards (explicit hosts only, by design)", () => {
    expect(() => parseInfraTargets(["10.0.0.0/24"])).toThrow(/CIDR/);
    expect(() => parseInfraTargets(["*.internal"])).toThrow(/Wildcard/);
  });

  it("rejects URLs with paths, bad ports and malformed hosts", () => {
    expect(() => parseInfraTargets(["http://host/admin"])).toThrow(/path/);
    expect(() => parseInfraTargets(["host:99999"])).toThrow(/Invalid port/);
    expect(() => parseInfraTargets(["bad_host!"])).toThrow(/Invalid host/);
  });
});

describe("infraGateFails", () => {
  function finding(overrides: Partial<InfraScanFinding>): InfraScanFinding {
    return {
      host: "h", port: 1, scheme: "http", service: "s", displayName: "S",
      evidence: "GET /", unauthenticated: false, exposureSeverity: "info",
      exposureNote: "", osvPackage: null, vulnerabilities: [], cveSource: "none",
      ...overrides,
    } as InfraScanFinding;
  }
  const vuln = (severity: string) =>
    ({ id: "i", cveId: "CVE-X", affectedPackage: "p", affectedVersions: "<1", severity, cvssScore: 5, description: "", publishedAt: "", references: [] });

  it("passes when nothing is exposed and no CVEs", () => {
    expect(infraGateFails([finding({})], "low")).toBe(false);
  });

  it("an unauthenticated service alone trips the high gate", () => {
    const f = finding({ unauthenticated: true, exposureSeverity: "high" });
    expect(infraGateFails([f], "high")).toBe(true);
    expect(infraGateFails([f], "critical")).toBe(false);
  });

  it("CVE severities trip the gate independently of exposure", () => {
    const f = finding({ vulnerabilities: [vuln("critical") as InfraScanFinding["vulnerabilities"][number]] });
    expect(infraGateFails([f], "critical")).toBe(true);
    expect(infraGateFails([finding({ vulnerabilities: [vuln("medium") as InfraScanFinding["vulnerabilities"][number]] })], "high")).toBe(false);
  });
});
