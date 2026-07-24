/**
 * AWSJSON `config` data-contract invariant tests.
 *
 * Incident: summary-fallback projections (detail GET fails in the parallel
 * list path → summaryToRecord leaves customDescriptorContent undefined)
 * built `config: meta.config ?? record.description ?? ''`, pushing PLAIN
 * TEXT (a human description like 'Fetches weather data') or '' into a
 * GraphQL AWSJSON field. AWSJSON double-encodes bare strings, so consumers
 * that parse twice crash (Agent Tools error-boundary incident).
 *
 * Invariant under test — every value this service projects into the
 * AWSJSON `config` field MUST be valid JSON representing an object:
 *  1. plain-text description fallback        → config === '{}'
 *  2. description that IS a JSON object      → passed through byte-identical
 *  3. meta.config present (valid object)     → byte-identical passthrough
 *  4. '' / undefined description             → config === '{}'
 *  5. no-double-encoding pin: the projected value parses to an object in
 *     exactly ONE JSON.parse (never a bare string, never throws)
 */
import {
  BedrockAgentCoreControlClient,
  GetRegistryRecordCommand,
  ListRegistryRecordsCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { mockClient } from "aws-sdk-client-mock";
import {
  RegistryService,
  RegistryRecord,
  RegistryRecordStatusValues,
} from "../registry-service";

const sdkMock = mockClient(BedrockAgentCoreControlClient);

function toolRecord(overrides: Partial<RegistryRecord> = {}): RegistryRecord {
  return {
    recordId: "tool-1",
    name: "WeatherTool",
    status: RegistryRecordStatusValues.APPROVED,
    ...overrides,
  };
}

function agentRecord(overrides: Partial<RegistryRecord> = {}): RegistryRecord {
  return {
    recordId: "agent-1",
    name: "WeatherAgent",
    status: RegistryRecordStatusValues.APPROVED,
    ...overrides,
  };
}

describe("RegistryService — AWSJSON config field invariant", () => {
  let service: RegistryService;

  beforeEach(() => {
    sdkMock.reset();
    service = new RegistryService({
      registryId: "test-registry",
      region: "us-east-1",
    });
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── Case 1: plain-text description falls back to '{}' ──────────────────

  describe("case 1 — plain-text description never leaks into config", () => {
    it("mapToToolConfig projects {} when description is plain text and meta.config is absent", () => {
      const record = toolRecord({ description: "Fetches weather data" });
      const result = service.mapToToolConfig(record);
      expect(result.config).toBe("{}");
      expect(JSON.parse(result.config)).toEqual({});
    });

    it("mapToAgentConfig projects {} when description is plain text", () => {
      const record = agentRecord({ description: "Answers weather questions" });
      const result = service.mapToAgentConfig(record);
      expect(result.config).toBe("{}");
      expect(JSON.parse(result.config)).toEqual({});
    });

    it("end-to-end: summary-fallback row (detail GET fails) projects config {} — the incident path", async () => {
      sdkMock.on(ListRegistryRecordsCommand).resolves({
        registryRecords: [
          {
            recordId: "tool-1",
            name: "WeatherTool",
            status: "APPROVED",
            description: "Fetches weather data",
          },
        ],
        nextToken: undefined,
      });
      sdkMock
        .on(GetRegistryRecordCommand)
        .rejects(
          Object.assign(new Error("boom"), { name: "ValidationException" }),
        );

      const records = await service.listResources("tool");
      expect(records).toHaveLength(1);
      // The fallback row carries no descriptor content (summaryToRecord).
      expect(records[0].customDescriptorContent).toBeUndefined();

      const projected = service.mapToToolConfig(records[0]);
      expect(projected.config).toBe("{}");
      // Description is NOT lost — it stays out of config only.
      expect(records[0].description).toBe("Fetches weather data");
    });
  });

  // ── Case 2: description that IS a valid JSON object passes through ─────

  describe("case 2 — JSON-object description passes through unchanged", () => {
    it("mapToToolConfig passes a JSON-object description through byte-identical (legacy records)", () => {
      const desc =
        '{"name":"WeatherTool","filename":"weather.py","schema":"{}"}';
      const record = toolRecord({ description: desc });
      expect(service.mapToToolConfig(record).config).toBe(desc);
    });

    it("mapToAgentConfig passes a JSON-object description through byte-identical", () => {
      const desc = '{"name":"WeatherAgent","filename":"agent.py"}';
      const record = agentRecord({ description: desc });
      expect(service.mapToAgentConfig(record).config).toBe(desc);
    });
  });

  // ── Case 3: meta.config present → byte-identical passthrough ───────────

  describe("case 3 — meta.config present wins, byte-identical", () => {
    it("mapToToolConfig passes meta.config through byte-identical, ignoring the description", () => {
      const metaConfig =
        '{"name":"WeatherTool","endpoint":"https://api.example.com","retries":3}';
      const record = toolRecord({
        description: "Fetches weather data",
        customDescriptorContent: JSON.stringify({
          categories: ["data"],
          icon: "",
          state: "active",
          config: metaConfig,
        }),
      });
      expect(service.mapToToolConfig(record).config).toBe(metaConfig);
    });
  });

  // ── Case 4: ''/undefined description → '{}' ────────────────────────────

  describe("case 4 — ''/undefined description falls back to '{}'", () => {
    it("mapToToolConfig projects {} when description is ''", () => {
      const record = toolRecord({ description: "" });
      expect(service.mapToToolConfig(record).config).toBe("{}");
    });

    it("mapToToolConfig projects {} when description is undefined", () => {
      const record = toolRecord({ description: undefined });
      expect(service.mapToToolConfig(record).config).toBe("{}");
    });

    it("mapToAgentConfig projects {} when description is ''", () => {
      const record = agentRecord({ description: "" });
      expect(service.mapToAgentConfig(record).config).toBe("{}");
    });

    it("mapToAgentConfig projects {} when description is undefined", () => {
      const record = agentRecord({ description: undefined });
      expect(service.mapToAgentConfig(record).config).toBe("{}");
    });
  });

  // ── Case 5: no-double-encoding pin — ONE JSON.parse yields an object ───

  describe("case 5 — projected config always parses to an object in a single JSON.parse", () => {
    const descriptions: Array<string | undefined> = [
      "Fetches weather data", // plain text (the incident poison)
      "", // empty string
      undefined, // absent
      '"already a JSON string"', // JSON, but a bare string — still not an object
      "null", // JSON null — not an object
      "[1,2,3]", // JSON array — not an object per the invariant
      '{"name":"WeatherTool"}', // valid object — passthrough
    ];

    it.each(
      descriptions.map(
        (d) => [d === undefined ? "<undefined>" : d || "''", d] as const,
      ),
    )(
      "mapToToolConfig(description=%s): single parse yields a non-null, non-array object",
      (_label, description) => {
        const config = service.mapToToolConfig(
          toolRecord({ description }),
        ).config;
        const parsed: unknown = JSON.parse(config); // must NOT throw
        expect(typeof parsed).toBe("object");
        expect(parsed).not.toBeNull();
        expect(Array.isArray(parsed)).toBe(false);
      },
    );

    it.each(
      descriptions.map(
        (d) => [d === undefined ? "<undefined>" : d || "''", d] as const,
      ),
    )(
      "mapToAgentConfig(description=%s): single parse yields a non-null, non-array object",
      (_label, description) => {
        const config = service.mapToAgentConfig(
          agentRecord({ description }),
        ).config;
        const parsed: unknown = JSON.parse(config); // must NOT throw
        expect(typeof parsed).toBe("object");
        expect(parsed).not.toBeNull();
        expect(Array.isArray(parsed)).toBe(false);
      },
    );

    it("mapToToolConfig ignores a meta.config that is valid JSON but NOT an object (bare string)", () => {
      const record = toolRecord({
        description: undefined,
        customDescriptorContent: JSON.stringify({
          categories: [],
          icon: "",
          state: "active",
          config: '"just a string"',
        }),
      });
      const config = service.mapToToolConfig(record).config;
      const parsed: unknown = JSON.parse(config);
      expect(typeof parsed).toBe("object");
      expect(parsed).not.toBeNull();
    });
  });
});
