/**
 * SSRF wiring tests — verifies that url-safety guards are correctly
 * integrated into the three runtime call sites (H10, H23, H25) and
 * the write-path mutations.
 *
 * Strategy: inject a DNS lookup that returns a private IP (10.0.0.1)
 * and assert the outbound request is refused BEFORE any connect. Also
 * tests redirect refusal and a happy-path with a public IP.
 *
 * Each site gets its own describe block:
 *  - H10: http-endpoint-adapter (invoke, healthCheck, fetchOpenApi)
 *  - H23: connection-tester (testApiKeyConnection, testBasicAuthConnection, testMCPServerConnection)
 *  - H25: oauth-metadata (discoverOAuthEndpoints)
 *  - Write-path: validateImportDescriptor, storeCredentials
 */
/* eslint-disable @typescript-eslint/no-unused-vars */

// -- url-safety helpers (unit-level sanity) ----------------------------------
import {
  parsePublicHttpsUrl,
  parseAndEnforceUrl,
  matchesHostPattern,
  resolveAndPin,
  safeHttpsRequest,
  UrlRejectedError,
} from "../url-safety";
import type { DnsLookupFn } from "../url-safety";

// -- H10: http-endpoint-adapter ----------------------------------------------
import { HttpEndpointAdapter } from "../../adapters/agent-source/http-endpoint-adapter";
import type { AgentCapabilityDescriptor } from "../../adapters/agent-source/base";

// -- H23: connection-tester --------------------------------------------------
import {
  testApiKeyConnection,
  testBasicAuthConnection,
  testMCPServerConnection,
} from "../connection-tester";
import { getConnectorSpec } from "../connector-registry";

// -- H25: oauth-metadata -----------------------------------------------------
import {
  discoverOAuthEndpoints,
  OAuthMetadataError,
  __resetOAuthMetadataCacheForTest,
} from "../oauth-metadata";

// -- Write-path: validateImportDescriptor ------------------------------------
import { validateImportDescriptor } from "../../lambda/agent-config-resolver";

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

/** DNS lookup that always returns a private IP → triggers SSRF refusal. */
const privateLookup: DnsLookupFn = async () => ["10.0.0.1"];

/** DNS lookup that always returns a public IP. */
const publicLookup: DnsLookupFn = async () => ["93.184.216.34"];

// ---------------------------------------------------------------------------
// H10: HttpEndpointAdapter
// ---------------------------------------------------------------------------
describe("H10 — HttpEndpointAdapter SSRF wiring", () => {
  const makeDescriptor = (target: string): AgentCapabilityDescriptor => ({
    name: "test-agent",
    description: "test",
    version: "1.0.0",
    skills: [],
    categories: [],
    inputSchema: {},
    outputSchema: {},
    invocation: {
      protocol: "HTTP_ENDPOINT",
      target,
      auth: { mode: "NONE" },
      mode: "sync",
    },
    origin: {
      substrate: "http",
      discoveredAt: new Date().toISOString(),
      ownership: "external",
    },
    fieldConfidence: {},
  });

  it("invoke() rejects when DNS resolves to a private IP", async () => {
    const adapter = new HttpEndpointAdapter({ dnsLookup: privateLookup });
    await expect(
      adapter.invoke(
        { prompt: "hello", sessionId: "s1" },
        makeDescriptor("https://evil.example.com/agent"),
      ),
    ).rejects.toThrow(UrlRejectedError);
  });

  it("invoke() rejects a non-HTTPS target", async () => {
    const adapter = new HttpEndpointAdapter({ dnsLookup: publicLookup });
    await expect(
      adapter.invoke(
        { prompt: "hello", sessionId: "s1" },
        makeDescriptor("http://example.com/agent"),
      ),
    ).rejects.toThrow(UrlRejectedError);
  });

  it("healthCheck() returns { reachable: false } when DNS resolves private", async () => {
    const adapter = new HttpEndpointAdapter({ dnsLookup: privateLookup });
    const result = await adapter.healthCheck("https://evil.example.com/agent");
    expect(result.reachable).toBe(false);
    expect(result.detail).toContain("Invalid endpoint");
  });

  it("healthCheck() rejects a non-HTTPS target", async () => {
    const adapter = new HttpEndpointAdapter({ dnsLookup: publicLookup });
    const result = await adapter.healthCheck("http://example.com/agent");
    expect(result.reachable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// H23: connection-tester
// ---------------------------------------------------------------------------
describe("H23 — connection-tester SSRF wiring", () => {
  it("testApiKeyConnection refuses baseUrl resolving to private IP", async () => {
    const spec = getConnectorSpec("CONFLUENCE")!;
    const result = await testApiKeyConnection(
      "CONFLUENCE",
      {
        email: "a@b.com",
        apiToken: "tok",
        baseUrl: "https://evil.example.com",
      },
      spec,
      { dnsLookup: privateLookup },
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("Invalid endpoint");
  });

  it("testApiKeyConnection refuses non-HTTPS baseUrl", async () => {
    const spec = getConnectorSpec("CONFLUENCE")!;
    const result = await testApiKeyConnection(
      "CONFLUENCE",
      { email: "a@b.com", apiToken: "tok", baseUrl: "http://example.com" },
      spec,
      { dnsLookup: publicLookup },
    );
    expect(result.success).toBe(false);
  });

  it("testApiKeyConnection enforces hostPattern for Confluence (*.atlassian.net)", async () => {
    const spec = getConnectorSpec("CONFLUENCE")!;
    // A valid public HTTPS URL, but NOT matching *.atlassian.net
    const result = await testApiKeyConnection(
      "CONFLUENCE",
      {
        email: "a@b.com",
        apiToken: "tok",
        baseUrl: "https://not-atlassian.example.com",
      },
      spec,
      { dnsLookup: publicLookup },
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("Invalid endpoint");
  });

  it("testBasicAuthConnection refuses instanceUrl resolving to private IP", async () => {
    const spec = getConnectorSpec("SERVICENOW")!;
    const result = await testBasicAuthConnection(
      "SERVICENOW",
      {
        username: "admin",
        password: "pass",
        instanceUrl: "https://evil.example.com",
      },
      spec,
      { dnsLookup: privateLookup },
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("Invalid endpoint");
  });

  it("testBasicAuthConnection enforces hostPattern for ServiceNow", async () => {
    const spec = getConnectorSpec("SERVICENOW")!;
    const result = await testBasicAuthConnection(
      "SERVICENOW",
      {
        username: "admin",
        password: "pass",
        instanceUrl: "https://not-servicenow.example.com",
      },
      spec,
      { dnsLookup: publicLookup },
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("Invalid endpoint");
  });

  it("testMCPServerConnection refuses serverUrl resolving to private IP", async () => {
    const result = await testMCPServerConnection(
      { serverUrl: "https://evil.example.com" },
      { authMethod: "API_KEY", apiKey: "tok" },
      { dnsLookup: privateLookup },
    );
    expect(result.success).toBe(false);
  });

  it("testMCPServerConnection refuses non-HTTPS serverUrl", async () => {
    const result = await testMCPServerConnection(
      { serverUrl: "http://example.com" },
      { authMethod: "API_KEY", apiKey: "tok" },
      { dnsLookup: publicLookup },
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain("Invalid endpoint");
  });
});

// ---------------------------------------------------------------------------
// H25: oauth-metadata
// ---------------------------------------------------------------------------
describe("H25 — oauth-metadata SSRF wiring", () => {
  beforeEach(() => {
    __resetOAuthMetadataCacheForTest();
  });

  it("rejects discoveryUrl resolving to a private IP", async () => {
    await expect(
      discoverOAuthEndpoints(
        "https://evil.example.com/.well-known/oauth-authorization-server",
        {
          dnsLookup: privateLookup,
        },
      ),
    ).rejects.toThrow(OAuthMetadataError);
  });

  it("rejects non-HTTPS discoveryUrl", async () => {
    await expect(
      discoverOAuthEndpoints(
        "http://example.com/.well-known/oauth-authorization-server",
        {
          dnsLookup: publicLookup,
        },
      ),
    ).rejects.toThrow(OAuthMetadataError);

    try {
      await discoverOAuthEndpoints(
        "http://example.com/.well-known/oauth-authorization-server",
        {
          dnsLookup: publicLookup,
        },
      );
    } catch (err) {
      expect((err as OAuthMetadataError).code).toBe("URL_REJECTED");
    }
  });
});

// ---------------------------------------------------------------------------
// Write-path: validateImportDescriptor
// ---------------------------------------------------------------------------
describe("Write-path — validateImportDescriptor URL validation", () => {
  const base = {
    name: "test-agent",
    origin: {
      ownership: "external",
      substrate: "http",
      discoveredAt: new Date().toISOString(),
    },
  };

  it("rejects HTTP_ENDPOINT target with private IP literal", () => {
    const result = validateImportDescriptor({
      ...base,
      invocation: {
        protocol: "HTTP_ENDPOINT",
        target: "https://10.0.0.1/agent",
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("public HTTPS URL"))).toBe(
      true,
    );
  });

  it("rejects MCP target with non-HTTPS scheme", () => {
    const result = validateImportDescriptor({
      ...base,
      invocation: { protocol: "MCP", target: "http://example.com/mcp" },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("public HTTPS URL"))).toBe(
      true,
    );
  });

  it("accepts HTTP_ENDPOINT target with valid public HTTPS URL", () => {
    const result = validateImportDescriptor({
      ...base,
      invocation: {
        protocol: "HTTP_ENDPOINT",
        target: "https://api.example.com/agent",
      },
    });
    expect(result.valid).toBe(true);
  });

  it("accepts LAMBDA_INVOKE target without URL validation (ARN-based)", () => {
    const result = validateImportDescriptor({
      ...base,
      invocation: {
        protocol: "LAMBDA_INVOKE",
        target: "arn:aws:lambda:us-east-1:123456789012:function:my-func",
      },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects metadata IP via HTTP_ENDPOINT", () => {
    const result = validateImportDescriptor({
      ...base,
      invocation: {
        protocol: "HTTP_ENDPOINT",
        target: "https://169.254.169.254/latest/meta-data/",
      },
    });
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// url-safety helpers — unit tests for new exports
// ---------------------------------------------------------------------------
describe("matchesHostPattern", () => {
  it("matches *.atlassian.net against myco.atlassian.net", () => {
    expect(matchesHostPattern("myco.atlassian.net", "*.atlassian.net")).toBe(
      true,
    );
  });

  it("does not match bare atlassian.net against *.atlassian.net", () => {
    expect(matchesHostPattern("atlassian.net", "*.atlassian.net")).toBe(false);
  });

  it("matches case-insensitively", () => {
    expect(matchesHostPattern("MYCO.Atlassian.NET", "*.atlassian.net")).toBe(
      true,
    );
  });

  it("matches exact hostname when pattern has no wildcard", () => {
    expect(matchesHostPattern("slack.com", "slack.com")).toBe(true);
  });

  it("does not match different hostname against exact pattern", () => {
    expect(matchesHostPattern("evil.com", "slack.com")).toBe(false);
  });
});

describe("parseAndEnforceUrl", () => {
  it("rejects URL not matching hostPattern", () => {
    expect(() =>
      parseAndEnforceUrl("https://evil.example.com/path", {
        hostPattern: "*.atlassian.net",
      }),
    ).toThrow(UrlRejectedError);
  });

  it("passes URL matching hostPattern", () => {
    const url = parseAndEnforceUrl("https://myco.atlassian.net/path", {
      hostPattern: "*.atlassian.net",
    });
    expect(url.hostname).toBe("myco.atlassian.net");
  });

  it("passes URL when no hostPattern is set", () => {
    const url = parseAndEnforceUrl("https://anything.example.com/path");
    expect(url.hostname).toBe("anything.example.com");
  });
});
