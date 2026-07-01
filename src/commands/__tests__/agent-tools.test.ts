import { describe, expect, it, vi } from "vitest";
import {
  listAgentTools,
  createAgentTool,
  getAgentTool,
  deleteAgentTool,
  testAgentTool,
  buildAgentToolFromFlags,
  type AgentTool,
} from "../agent-tools.js";

const PROJECT = "00000000-0000-4000-8000-000000000001";
const TOOL_ID = "11111111-1111-4111-8111-111111111111";

const SAMPLE_TOOL: AgentTool = {
  name: "get_weather",
  type: "rest",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  rest: { method: "GET", url: "https://api.example.com/weather" },
};

describe("agent-tools CLI API client", () => {
  it("list: rejects a non-UUID project before hitting the network", async () => {
    const fetchImpl = vi.fn();
    await expect(
      listAgentTools({
        projectId: "not-a-uuid",
        baseUrl: "https://x.test/api/v1",
        apiKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/UUID/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("list: GET /agent-tools?projectId with Bearer token", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/agent-tools?projectId=");
      expect(url).toContain(PROJECT);
      expect(init?.method).toBe("GET");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
      return new Response(JSON.stringify({ success: true, data: { tools: [SAMPLE_TOOL] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const out = (await listAgentTools({
      projectId: PROJECT,
      baseUrl: "https://x.test/api/v1",
      apiKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) as { data: { tools: unknown[] } };
    expect(out.data.tools).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("create: POST /agent-tools with { projectId, tool } body", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain("/agent-tools");
      expect(init?.method).toBe("POST");
      const sent = JSON.parse(String(init?.body));
      expect(sent).toMatchObject({ projectId: PROJECT, tool: { name: "get_weather", type: "rest" } });
      return new Response(JSON.stringify({ success: true, data: { ...SAMPLE_TOOL, id: TOOL_ID } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    });
    const out = (await createAgentTool({
      projectId: PROJECT,
      tool: SAMPLE_TOOL,
      baseUrl: "https://x.test/api/v1",
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) as { data: AgentTool };
    expect(out.data.id).toBe(TOOL_ID);
  });

  it("get: GET /agent-tools/{id}?projectId", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain(`/agent-tools/${TOOL_ID}?projectId=`);
      expect(url).toContain(PROJECT);
      expect(init?.method).toBe("GET");
      return new Response(JSON.stringify({ success: true, data: { ...SAMPLE_TOOL, id: TOOL_ID } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const out = (await getAgentTool({
      projectId: PROJECT,
      id: TOOL_ID,
      baseUrl: "https://x.test/api/v1",
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) as { data: AgentTool };
    expect(out.data.name).toBe("get_weather");
  });

  it("delete: DELETE /agent-tools/{id}?projectId", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain(`/agent-tools/${TOOL_ID}?projectId=`);
      expect(init?.method).toBe("DELETE");
      return new Response(JSON.stringify({ success: true, data: { id: TOOL_ID, deleted: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const out = (await deleteAgentTool({
      projectId: PROJECT,
      id: TOOL_ID,
      baseUrl: "https://x.test/api/v1",
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) as { data: { deleted: boolean } };
    expect(out.data.deleted).toBe(true);
  });

  it("test: POST /agent-tools/{id}/test with { projectId, args }", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toContain(`/agent-tools/${TOOL_ID}/test`);
      expect(init?.method).toBe("POST");
      const sent = JSON.parse(String(init?.body));
      expect(sent).toMatchObject({ projectId: PROJECT, args: { city: "Paris" } });
      return new Response(JSON.stringify({ success: true, data: { ok: true, stage: "response", status: 200 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const out = (await testAgentTool({
      projectId: PROJECT,
      id: TOOL_ID,
      toolArgs: { city: "Paris" },
      baseUrl: "https://x.test/api/v1",
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) as { data: { ok: boolean; stage: string } };
    expect(out.data.ok).toBe(true);
    expect(out.data.stage).toBe("response");
  });

  it("surfaces the server error message on a non-OK response", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "Tool not found" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      getAgentTool({
        projectId: PROJECT,
        id: TOOL_ID,
        baseUrl: "https://x.test/api/v1",
        apiKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Tool not found/);
  });
});

describe("buildAgentToolFromFlags", () => {
  it("builds a REST tool from flags", () => {
    const tool = buildAgentToolFromFlags({
      name: "get_weather",
      type: "rest",
      url: "https://api.example.com/weather",
      method: "POST",
    });
    expect(tool).toMatchObject({
      name: "get_weather",
      type: "rest",
      rest: { method: "POST", url: "https://api.example.com/weather" },
    });
    expect(tool.parameters).toEqual({ type: "object", properties: {} });
  });

  it("defaults type to rest and method to GET", () => {
    const tool = buildAgentToolFromFlags({ name: "x", url: "https://h.test" });
    expect(tool.type).toBe("rest");
    expect(tool.rest?.method).toBe("GET");
  });

  it("builds a code tool", () => {
    const tool = buildAgentToolFromFlags({ name: "c", type: "code", source: "return 1;" });
    expect(tool.type).toBe("code");
    expect(tool.code?.source).toBe("return 1;");
  });

  it("builds an mcp tool with optional toolName", () => {
    const tool = buildAgentToolFromFlags({ name: "m", type: "mcp", server: "fs", toolName: "read" });
    expect(tool.mcp).toEqual({ server: "fs", toolName: "read" });
  });

  it("parses --parameters JSON into the parameters schema", () => {
    const tool = buildAgentToolFromFlags({
      name: "x",
      url: "https://h.test",
      parameters: JSON.stringify({ properties: { q: { type: "string" } }, required: ["q"] }),
    });
    expect(tool.parameters).toEqual({ type: "object", properties: { q: { type: "string" } }, required: ["q"] });
  });

  it("throws when --name is missing", () => {
    expect(() => buildAgentToolFromFlags({ type: "rest", url: "https://h.test" })).toThrow(/--name is required/);
  });

  it("throws when --url is missing for a rest tool", () => {
    expect(() => buildAgentToolFromFlags({ name: "x", type: "rest" })).toThrow(/--url is required/);
  });

  it("throws on an invalid --type", () => {
    expect(() => buildAgentToolFromFlags({ name: "x", type: "bogus" })).toThrow(/rest\|code\|mcp/);
  });
});
