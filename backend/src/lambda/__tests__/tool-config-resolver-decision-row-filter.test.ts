/**
 * Tests for decision-row filtering in listToolConfigs and getToolConfig (#342).
 *
 * Issue: approval decisions are stored as DynamoDB rows with
 * toolId='decision#<id>' in the TOOLS_CONFIG_TABLE. listToolConfigs scanned
 * the table without excluding them, mapped them to ToolConfig objects with
 * config=undefined, and AppSync nulled the element (config: AWSJSON! is
 * non-nullable), crashing the Agent Tools page.
 *
 * Fix: (1) FilterExpression excludes decision rows from the scan,
 *       (2) mapper drops any row whose config is unparsable (defensive),
 *       (3) getToolConfig rejects decision-prefix lookups.
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const dynamoMock = mockClient(DynamoDBDocumentClient);

import { handler } from "../tool-config-resolver";

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

describe("listToolConfigs decision-row filtering (#342)", () => {
  beforeEach(() => {
    dynamoMock.reset();
    process.env.TOOLS_CONFIG_TABLE = "test-tools-config";
  });

  afterEach(() => {
    delete process.env.TOOLS_CONFIG_TABLE;
  });

  test("list excludes decision rows and returns only valid tools", async () => {
    dynamoMock.on(ScanCommand).resolves({
      Items: [
        {
          toolId: "real-tool-1",
          orgId: "test-org-a",
          config: JSON.stringify({ name: "Real Tool", description: "valid" }),
          state: "active",
          categories: ["utility"],
        },
        // This row should be excluded by the FilterExpression, but even if
        // DynamoDB returns it (e.g. in test), the mapper should drop it.
        {
          toolId: "decision#real-tool-1",
          decidedBy: "admin-user",
          decidedAt: "2026-01-01T00:00:00Z",
          status: "APPROVED",
        },
      ],
    });

    const result = await handler(makeEvent("listToolConfigs", {}));

    // Only the real tool survives
    expect(result).toHaveLength(1);
    expect(result[0].toolId).toBe("real-tool-1");
    expect(result[0].config).toBeDefined();

    // No element has an undefined/null config
    for (const item of result) {
      expect(item.config).toBeDefined();
      expect(item.config).not.toBeNull();
    }
  });

  test("list uses FilterExpression to exclude decision# prefix", async () => {
    dynamoMock.on(ScanCommand).resolves({ Items: [] });

    await handler(makeEvent("listToolConfigs", {}));

    const scanCalls = dynamoMock.commandCalls(ScanCommand);
    expect(scanCalls.length).toBeGreaterThanOrEqual(1);
    const scanInput = scanCalls[0].args[0].input;
    expect(scanInput.FilterExpression).toContain("begins_with");
    expect(scanInput.FilterExpression).toContain(":p");
    expect(scanInput.ExpressionAttributeValues).toEqual(
      expect.objectContaining({ ":p": "decision#" }),
    );
  });

  test("list drops rows with undefined config (defensive mapper)", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    dynamoMock.on(ScanCommand).resolves({
      Items: [
        {
          toolId: "good-tool",
          orgId: "test-org-a",
          config: JSON.stringify({ name: "Good" }),
          state: "active",
        },
        {
          toolId: "corrupt-row",
          orgId: "test-org-a",
          // config is missing entirely
          state: "active",
        },
      ],
    });

    const result = await handler(makeEvent("listToolConfigs", {}));

    expect(result).toHaveLength(1);
    expect(result[0].toolId).toBe("good-tool");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("dropping row with unparsable config"),
    );

    warnSpy.mockRestore();
  });
});

describe("getToolConfig decision-prefix rejection (#342)", () => {
  beforeEach(() => {
    dynamoMock.reset();
    process.env.TOOLS_CONFIG_TABLE = "test-tools-config";
  });

  afterEach(() => {
    delete process.env.TOOLS_CONFIG_TABLE;
  });

  test("getToolConfig returns null for decision-prefix toolId", async () => {
    const result = await handler(
      makeEvent("getToolConfig", { toolId: "decision#tool-1" }),
    );

    expect(result).toBeNull();
    // Should NOT have issued a DynamoDB GetCommand
    expect(dynamoMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  test("getToolConfig returns normal tool as before", async () => {
    dynamoMock.on(GetCommand).resolves({
      Item: {
        toolId: "tool-1",
        orgId: "test-org-a",
        config: JSON.stringify({ name: "Tool One" }),
        state: "active",
      },
    });

    const result = await handler(
      makeEvent("getToolConfig", { toolId: "tool-1" }),
    );

    expect(result).not.toBeNull();
    expect(result!.toolId).toBe("tool-1");
  });
});
