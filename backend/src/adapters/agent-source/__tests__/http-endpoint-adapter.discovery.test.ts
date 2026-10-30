/**
 * Discovery / describe / healthCheck tests for the HTTP endpoint adapter
 * (US-IMP-011). Discovery is by PASTED ENDPOINT; global fetch is injected as a
 * fake — no live network.
 */
import { HttpEndpointAdapter } from "../http-endpoint-adapter";
import type { AgentInvocationBlock } from "../base";
import type {
  SafeResponse,
  SafeFetchTransport,
} from "../../../utils/url-safety";

const URL_ = "https://api.example.com/agent";

function makeTransport(
  handler?: (url: string) => SafeResponse,
): SafeFetchTransport {
  const defaultResponse: SafeResponse = {
    status: 200,
    headers: { "content-type": "application/json" },
    body: Buffer.from("{}"),
  };
  return async (url) => (handler ? handler(url) : defaultResponse);
}

describe("HttpEndpointAdapter.discover (US-IMP-011)", () => {
  it("returns a single candidate for a pasted endpoint (substrate http, no sourceArn)", async () => {
    const adapter = new HttpEndpointAdapter({ transport: makeTransport() });
    const candidates = await adapter.discover({
      endpoint: URL_,
      name: "Orders",
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      reference: URL_,
      displayName: "Orders",
      origin: { substrate: "http", ownership: "external" },
    });
    expect(candidates[0].origin.sourceArn).toBeUndefined();
    expect(typeof candidates[0].origin.discoveredAt).toBe("string");
  });

  it("returns [] when no endpoint is present in scope", async () => {
    const adapter = new HttpEndpointAdapter({ transport: makeTransport() });
    await expect(adapter.discover({})).resolves.toEqual([]);
    await expect(adapter.discover(undefined)).resolves.toEqual([]);
  });
});

describe("HttpEndpointAdapter.describe (US-IMP-011)", () => {
  const reqSchema = {
    type: "object",
    properties: { sku: { type: "string" } },
    required: ["sku"],
  };
  const resSchema = {
    type: "object",
    properties: { orderId: { type: "string" } },
  };
  const openApiDoc = {
    openapi: "3.0.0",
    info: {
      title: "Orders API",
      description: "Order operations",
      version: "2.1.0",
    },
    paths: {
      "/orders": {
        post: {
          operationId: "createOrder",
          requestBody: {
            content: { "application/json": { schema: reqSchema } },
          },
          responses: {
            "200": { content: { "application/json": { schema: resSchema } } },
          },
        },
      },
    },
  };

  it("maps an available OpenAPI document into schemas at high confidence", async () => {
    const calls: string[] = [];
    const transport: SafeFetchTransport = async (url) => {
      calls.push(url);
      if (url.endsWith("/openapi.json")) {
        return {
          status: 200,
          headers: {},
          body: Buffer.from(JSON.stringify(openApiDoc)),
        };
      }
      return { status: 404, headers: {}, body: Buffer.from("nf") };
    };
    const adapter = new HttpEndpointAdapter({ transport });

    const d = await adapter.describe(URL_);

    expect(calls[0]).toBe("https://api.example.com/agent/openapi.json");
    expect(d.name).toBe("Orders API");
    expect(d.description).toBe("Order operations");
    expect(d.version).toBe("2.1.0");
    expect(d.skills).toContain("createOrder");
    expect(d.inputSchema).toEqual({
      type: "object",
      properties: { createOrder: reqSchema },
    });
    expect(d.outputSchema).toEqual({
      type: "object",
      properties: { createOrder: resSchema },
    });
    expect(d.fieldConfidence?.inputSchema).toBe("high");
    expect(d.invocation).toMatchObject({
      protocol: "HTTP_ENDPOINT",
      target: URL_,
      auth: { mode: "SIGV4" },
      mode: "sync",
    });
    expect(d.origin.substrate).toBe("http");
  });

  it("returns a minimal low-confidence descriptor when no OpenAPI is available", async () => {
    const transport: SafeFetchTransport = async () => ({
      status: 404,
      headers: {},
      body: Buffer.from("nf"),
    });
    const adapter = new HttpEndpointAdapter({ transport });

    const d = await adapter.describe(URL_);

    expect(d.name).toBe("api.example.com");
    expect(d.inputSchema).toEqual({});
    expect(d.outputSchema).toEqual({});
    expect(d.skills).toEqual([]);
    expect(d.fieldConfidence?.inputSchema).toBe("low");
    expect(d.invocation.target).toBe(URL_);
  });

  it("reflects scope auth (API_KEY + secretRef) in the invocation block", async () => {
    const transport: SafeFetchTransport = async () => ({
      status: 404,
      headers: {},
      body: Buffer.from(""),
    });
    const adapter = new HttpEndpointAdapter({
      transport,
      auth: { mode: "API_KEY", secretRef: "secret/http-key" },
    });

    const d = await adapter.describe(URL_);

    expect(d.invocation.auth).toEqual({
      mode: "API_KEY",
      secretRef: "secret/http-key",
    });
  });
});

describe("HttpEndpointAdapter.healthCheck (US-IMP-011)", () => {
  it("returns reachable:true on a 2xx", async () => {
    const transport: SafeFetchTransport = async () => ({
      status: 200,
      headers: {},
      body: Buffer.from(""),
    });
    const adapter = new HttpEndpointAdapter({ transport });
    await expect(adapter.healthCheck(URL_)).resolves.toEqual({
      reachable: true,
    });
  });

  it("returns reachable:false (with detail) on a non-2xx WITHOUT throwing", async () => {
    const transport: SafeFetchTransport = async () => ({
      status: 503,
      headers: {},
      body: Buffer.from(""),
    });
    const adapter = new HttpEndpointAdapter({ transport });
    const res = await adapter.healthCheck(URL_);
    expect(res.reachable).toBe(false);
    expect(res.detail).toContain("503");
  });

  it("returns reachable:false on a network error WITHOUT throwing", async () => {
    const transport: SafeFetchTransport = async () => {
      throw new Error("ECONNREFUSED");
    };
    const adapter = new HttpEndpointAdapter({ transport });
    const res = await adapter.healthCheck(URL_);
    expect(res.reachable).toBe(false);
    expect(res.detail).toContain("ECONNREFUSED");
  });
});

describe("HttpEndpointAdapter.vendCredentials", () => {
  it("returns minimal credentials (no roleArn ⇒ no assume) instead of throwing", async () => {
    const adapter = new HttpEndpointAdapter();
    const invocation: AgentInvocationBlock = {
      protocol: "HTTP_ENDPOINT",
      target: URL_,
      auth: { mode: "NONE" },
      mode: "sync",
    };
    await expect(adapter.vendCredentials(invocation)).resolves.toEqual({});
  });
});
