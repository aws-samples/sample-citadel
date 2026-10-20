/**
 * Contract test: every ToolConfig the resolver returns satisfies the
 * schema's non-null fields (#342).
 *
 * Parses backend/src/schema/schema.graphql for `type ToolConfig` and
 * extracts all non-nullable fields (those ending with `!`). Asserts that
 * every object the legacy DynamoDB listToolConfigs/getToolConfig returns has
 * a defined, non-null value for each of those fields.
 *
 * This is generic enough to catch the next occurrence: if a new non-null
 * field is added to the ToolConfig schema and the resolver fails to
 * populate it, this test will fail.
 */
import * as fs from "fs";
import * as path from "path";
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const dynamoMock = mockClient(DynamoDBDocumentClient);

import { handler } from "../tool-config-resolver";

// ---------------------------------------------------------------------------
// Schema parsing: extract non-nullable fields from type ToolConfig
// ---------------------------------------------------------------------------

function parseToolConfigNonNullFields(): string[] {
  const schemaPath = path.resolve(__dirname, "../../schema/schema.graphql");
  const schema = fs.readFileSync(schemaPath, "utf-8");

  // Extract the ToolConfig type body
  const typeMatch = schema.match(/type\s+ToolConfig\s*\{([^}]+)\}/);
  if (!typeMatch) {
    throw new Error("Could not find type ToolConfig in schema.graphql");
  }

  const body = typeMatch[1];
  const nonNullFields: string[] = [];

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Match field definitions: `fieldName: Type!` (non-null)
    const fieldMatch = trimmed.match(/^(\w+)\s*:\s*\S+!\s*$/);
    if (fieldMatch) {
      nonNullFields.push(fieldMatch[1]);
    }
  }

  return nonNullFields;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeEvent = (
  fieldName: string,
  args: Record<string, unknown>,
  identity?: Record<string, unknown>,
) => ({
  info: { fieldName },
  arguments: args,
  identity: identity ?? {
    sub: "test-user",
    claims: { "custom:organization": "test-org-a" },
  },
});

const validToolRow = {
  toolId: "tool-contract-1",
  orgId: "test-org-a",
  config: JSON.stringify({ name: "Contract Tool", description: "test" }),
  state: "active",
  categories: ["utility"],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ToolConfig schema contract: non-null field enforcement", () => {
  let nonNullFields: string[];

  beforeAll(() => {
    nonNullFields = parseToolConfigNonNullFields();
    // Sanity: ToolConfig must have at least toolId, config, state as non-null
    expect(nonNullFields).toEqual(
      expect.arrayContaining(["toolId", "config", "state"]),
    );
  });

  beforeEach(() => {
    dynamoMock.reset();
    process.env.TOOLS_CONFIG_TABLE = "test-tools-config";
  });

  afterEach(() => {
    delete process.env.TOOLS_CONFIG_TABLE;
  });

  test("schema parser finds ToolConfig non-null fields", () => {
    expect(nonNullFields.length).toBeGreaterThanOrEqual(3);
    // These must always be non-null per the schema
    expect(nonNullFields).toContain("toolId");
    expect(nonNullFields).toContain("orgId");
    expect(nonNullFields).toContain("config");
    expect(nonNullFields).toContain("state");
  });

  test("listToolConfigs: every returned ToolConfig satisfies non-null fields", async () => {
    dynamoMock.on(ScanCommand).resolves({
      Items: [
        validToolRow,
        {
          toolId: "tool-contract-2",
          orgId: "test-org-a",
          config: { name: "Inline Config" },
          state: "inactive",
        },
      ],
    });

    const result = await handler(makeEvent("listToolConfigs", {}));

    expect(result.length).toBeGreaterThanOrEqual(1);
    for (const item of result) {
      for (const field of nonNullFields) {
        expect(item).toHaveProperty(field);
        expect((item as Record<string, unknown>)[field]).not.toBeNull();
        expect((item as Record<string, unknown>)[field]).not.toBeUndefined();
      }
    }
  });

  test("getToolConfig: returned ToolConfig satisfies non-null fields", async () => {
    dynamoMock.on(GetCommand).resolves({ Item: validToolRow });

    const result = await handler(
      makeEvent("getToolConfig", { toolId: "tool-contract-1" }),
    );

    expect(result).not.toBeNull();
    for (const field of nonNullFields) {
      expect(result).toHaveProperty(field);
      expect((result as Record<string, unknown>)[field]).not.toBeNull();
      expect((result as Record<string, unknown>)[field]).not.toBeUndefined();
    }
  });

  test("listToolConfigs: decision rows do not leak as ToolConfig objects missing non-null fields", async () => {
    dynamoMock.on(ScanCommand).resolves({
      Items: [
        validToolRow,
        {
          toolId: "decision#tool-contract-1",
          decidedBy: "admin",
          decidedAt: "2026-01-01T00:00:00Z",
          status: "APPROVED",
          // No config, no orgId, no state — would violate non-null contract
        },
      ],
    });

    const result = await handler(makeEvent("listToolConfigs", {}));

    // Only the valid tool should be returned
    expect(result).toHaveLength(1);
    expect(result[0].toolId).toBe("tool-contract-1");

    // And it satisfies the contract
    for (const field of nonNullFields) {
      expect(result[0]).toHaveProperty(field);
      expect((result[0] as Record<string, unknown>)[field]).not.toBeNull();
      expect((result[0] as Record<string, unknown>)[field]).not.toBeUndefined();
    }
  });
});
