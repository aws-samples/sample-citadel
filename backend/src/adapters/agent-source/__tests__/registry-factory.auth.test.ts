/**
 * buildDefaultAgentSourceRegistry must thread an optional `resolveSecret` dep
 * into the HTTP + MCP adapters so the invoke path can apply auth headers. When
 * omitted, those adapters invoke without an auth header (back-compat). The
 * factory builds adapters with the DEFAULT fetch (MCP adapter) or the default
 * safeFetch transport (HTTP adapter). For the HTTP adapter tests we mock
 * safeFetch at the module level; for MCP adapter tests we stub global fetch.
 */
import { buildDefaultAgentSourceRegistry } from "../registry-factory";
import type {
  AgentCapabilityDescriptor,
  AgentInvocationBlock,
  InvokeRequest,
} from "../base";

// Mock safeFetch so HTTP adapter doesn't attempt real HTTPS connections.
const safeFetchMock = jest.fn();
jest.mock("../../../utils/url-safety", () => {
  const actual = jest.requireActual("../../../utils/url-safety");
  return {
    ...actual,
    safeFetch: (...args: unknown[]) => safeFetchMock(...args),
  };
});

const HTTP_TARGET = "https://api.example.com/agent";
const MCP_TARGET = "https://mcp.example.com/rpc";
const SECRET_VALUE = "factory-threaded-secret-DO-NOT-LOG";

function descriptorFor(
  invocation: AgentInvocationBlock,
): AgentCapabilityDescriptor {
  return {
    name: "agent-under-test",
    description: "",
    version: "1.0.0",
    skills: [],
    categories: [],
    inputSchema: {},
    outputSchema: {},
    invocation,
    origin: {
      substrate: invocation.protocol,
      discoveredAt: "2026-06-28T00:00:00.000Z",
      ownership: "external",
    },
  };
}

const baseReq: InvokeRequest = {
  prompt: "hello",
  sessionId: "s1",
  attributes: {},
};

const realFetch = global.fetch;

function stubGlobalFetch(body: string): jest.Mock {
  const fn = jest.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => body,
  }));
  (global as unknown as { fetch: jest.Mock }).fetch = fn;
  return fn;
}

afterEach(() => {
  (global as unknown as { fetch: typeof realFetch }).fetch = realFetch;
  safeFetchMock.mockReset();
});

function stubSafeFetch(body: string): void {
  safeFetchMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    statusText: "200",
    headers: {},
    text: async () => body,
    json: async () => JSON.parse(body),
  }));
}

function safeFetchHeadersOf(): Record<string, string> {
  const call = safeFetchMock.mock.calls[0];
  return call?.[1]?.headers ?? {};
}

describe("buildDefaultAgentSourceRegistry — resolveSecret threading", () => {
  it("threads resolveSecret into the HTTP adapter (Bearer applied via the factory)", async () => {
    const resolveSecret = jest.fn(async () => SECRET_VALUE);
    stubSafeFetch(JSON.stringify({ output: "ok" }));
    const registry = buildDefaultAgentSourceRegistry({ resolveSecret });

    await registry.resolve("HTTP_ENDPOINT").invoke(
      baseReq,
      descriptorFor({
        protocol: "HTTP_ENDPOINT",
        target: HTTP_TARGET,
        auth: { mode: "OAUTH2", secretRef: "secret/http" },
        mode: "sync",
      }),
    );

    expect(resolveSecret).toHaveBeenCalledWith("secret/http");
    expect(safeFetchHeadersOf().authorization).toBe(`Bearer ${SECRET_VALUE}`);
  });

  it("threads resolveSecret into the MCP adapter", async () => {
    const resolveSecret = jest.fn(async () => SECRET_VALUE);
    const fetchFn = stubGlobalFetch(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "mcp-out" }] },
      }),
    );
    const registry = buildDefaultAgentSourceRegistry({ resolveSecret });

    await registry.resolve("MCP").invoke(
      baseReq,
      descriptorFor({
        protocol: "MCP",
        target: MCP_TARGET,
        auth: { mode: "OAUTH2", secretRef: "secret/mcp" },
        mode: "sync",
      }),
    );

    expect(resolveSecret).toHaveBeenCalledWith("secret/mcp");
    const headers =
      (fetchFn.mock.calls[0][1] as { headers?: Record<string, string> })
        .headers ?? {};
    expect(headers.authorization).toBe(`Bearer ${SECRET_VALUE}`);
  });

  it("builds without resolveSecret (back-compat): no auth header, still invokes + registers 5 protocols", async () => {
    stubSafeFetch(JSON.stringify({ output: "ok" }));
    const registry = buildDefaultAgentSourceRegistry();

    for (const protocol of [
      "AGENTCORE_RUNTIME",
      "LAMBDA_INVOKE",
      "HTTP_ENDPOINT",
      "BEDROCK_AGENT",
      "MCP",
    ] as const) {
      expect(registry.has(protocol)).toBe(true);
    }

    await registry.resolve("HTTP_ENDPOINT").invoke(
      baseReq,
      descriptorFor({
        protocol: "HTTP_ENDPOINT",
        target: HTTP_TARGET,
        auth: { mode: "API_KEY", secretRef: "secret/http" },
        mode: "sync",
      }),
    );

    expect(safeFetchHeadersOf().authorization).toBeUndefined();
  });
});
