/**
 * Tests for writeProjectionRow's handling of optional projection fields
 * (appId, sourceProjectId, etc.) that are legitimately absent on the
 * source record — e.g. fabricated agents/tools, which never carry an
 * appId.
 *
 * Bug: writeProjectionRow built its UpdateExpression from
 * `Object.entries(projectionRow)` unconditionally, so an absent optional
 * field (value === undefined) still produced a `#p_appId = :p_appId`
 * clause with `:p_appId` bound to `undefined` in ExpressionAttributeValues.
 * DynamoDB rejects UpdateItem calls that place `undefined` into
 * ExpressionAttributeValues, so --resync-projection --apply failed for
 * every fabricated agent/tool (no appId).
 */

process.env.AGENT_CONFIG_TABLE = "test-agents-table";
process.env.TOOLS_CONFIG_TABLE = "test-tools-table";
process.env.REGISTRY_ID = "test-registry-id";
process.env.DLQ_URL = "https://sqs.us-east-1.amazonaws.com/123456789/test-dlq";

import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { writeProjectionRow } from "../registry-sync";
import type { RegistryRecord } from "../../services/registry-service";

jest.mock("../../services/registry-service", () => {
  const actual = jest.requireActual("../../services/registry-service");
  return { ...actual };
});

const ddbMock = mockClient(DynamoDBDocumentClient);
const sqsMock = mockClient(SQSClient);
const cwMock = mockClient(CloudWatchClient);

beforeEach(() => {
  ddbMock.reset();
  sqsMock.reset();
  cwMock.reset();
  ddbMock.on(UpdateCommand).resolves({});
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

function baseAgentRecord(
  overrides: Partial<RegistryRecord> = {},
): RegistryRecord {
  return {
    recordId: "agent-under-test",
    name: "fabricated-agent",
    description: '{"name":"fabricated-agent"}',
    status: "APPROVED",
    customDescriptorContent: JSON.stringify({
      citadelKind: "agent",
      categories: ["worker"],
      icon: "",
      state: "APPROVED",
      orgId: "org-a",
      // appId intentionally omitted — fabricated agents never carry one.
    }),
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-23T00:00:00.000Z"),
    ...overrides,
  } as unknown as RegistryRecord;
}

describe("writeProjectionRow — optional field omission (appId)", () => {
  test("appId undefined: UpdateExpression omits #p_appId and no undefined value is bound", async () => {
    const record = baseAgentRecord();

    await writeProjectionRow(
      ddbMock as unknown as DynamoDBDocumentClient,
      "test-agents-table",
      "agent",
      "agent-under-test",
      record,
    );

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    const input = call.args[0].input;

    expect(input.UpdateExpression).not.toMatch(/#p_appId/);
    expect(input.ExpressionAttributeNames).not.toHaveProperty("#p_appId");
    expect(input.ExpressionAttributeValues).not.toHaveProperty(":p_appId");

    // No binding anywhere may be `undefined` — that's exactly what
    // DynamoDB's client rejects.
    for (const value of Object.values(input.ExpressionAttributeValues ?? {})) {
      expect(value).not.toBeUndefined();
    }
  });

  test("appId defined: behaviour is unchanged — #p_appId is SET with the real value", async () => {
    const record = baseAgentRecord({
      customDescriptorContent: JSON.stringify({
        citadelKind: "agent",
        categories: ["worker"],
        icon: "",
        state: "APPROVED",
        orgId: "org-a",
        appId: "app-123",
      }),
    });

    await writeProjectionRow(
      ddbMock as unknown as DynamoDBDocumentClient,
      "test-agents-table",
      "agent",
      "agent-under-test",
      record,
    );

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    const input = call.args[0].input;

    expect(input.UpdateExpression).toMatch(/#p_appId = :p_appId/);
    expect(input.ExpressionAttributeNames?.["#p_appId"]).toBe("appId");
    expect(input.ExpressionAttributeValues?.[":p_appId"]).toBe("app-123");
  });

  test("sourceProjectId undefined: UpdateExpression omits #p_sourceProjectId and no undefined value is bound", async () => {
    const record = baseAgentRecord();

    await writeProjectionRow(
      ddbMock as unknown as DynamoDBDocumentClient,
      "test-agents-table",
      "agent",
      "agent-under-test",
      record,
    );

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    const input = call.args[0].input;

    expect(input.UpdateExpression).not.toMatch(/#p_sourceProjectId/);
    expect(input.ExpressionAttributeNames).not.toHaveProperty(
      "#p_sourceProjectId",
    );
    expect(input.ExpressionAttributeValues).not.toHaveProperty(
      ":p_sourceProjectId",
    );
  });

  test("sourceProjectId defined: behaviour is unchanged — #p_sourceProjectId is SET with the real value", async () => {
    const record = baseAgentRecord({
      customDescriptorContent: JSON.stringify({
        citadelKind: "agent",
        categories: ["worker"],
        icon: "",
        state: "APPROVED",
        orgId: "org-a",
        sourceProjectId: "proj-456",
      }),
    });

    await writeProjectionRow(
      ddbMock as unknown as DynamoDBDocumentClient,
      "test-agents-table",
      "agent",
      "agent-under-test",
      record,
    );

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    const input = call.args[0].input;

    expect(input.UpdateExpression).toMatch(
      /#p_sourceProjectId = :p_sourceProjectId/,
    );
    expect(input.ExpressionAttributeNames?.["#p_sourceProjectId"]).toBe(
      "sourceProjectId",
    );
    expect(input.ExpressionAttributeValues?.[":p_sourceProjectId"]).toBe(
      "proj-456",
    );
  });
});
