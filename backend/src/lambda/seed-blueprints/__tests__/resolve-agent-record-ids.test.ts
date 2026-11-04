/**
 * Unit tests for resolveAgentRecordIds — in a separate file from the handler
 * tests because the handler tests mock 'https' (for CFN response), which
 * breaks the smithy HTTP handler used by DynamoDBClient.
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

const ddbMock = mockClient(DynamoDBDocumentClient);

// Import WITHOUT the handler (which pulls in https-dependent CFN response code)
// by importing the individual exported functions directly.
import { resolveAgentRecordIds } from "../index";

describe("resolveAgentRecordIds", () => {
  beforeAll(() => {
    process.env.AGENT_CONFIG_TABLE = "citadel-agents-test";
  });

  beforeEach(() => {
    ddbMock.reset();
  });

  afterAll(() => {
    delete process.env.AGENT_CONFIG_TABLE;
  });

  test("resolves via thin pointer _canonicalRecordId", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        agentId: "demo-echo-agent",
        _canonicalRecordId: "mjaKkVyqoFGN",
        registryRecordId: "mjaKkVyqoFGN",
      },
    });

    const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const result = await resolveAgentRecordIds(["demo-echo-agent"], client);

    expect(result.get("demo-echo-agent")).toBe("mjaKkVyqoFGN");
  });

  test("falls back to registryRecordId when _canonicalRecordId is absent", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        agentId: "demo-echo-agent",
        registryRecordId: "mjaKkVyqoFGN",
      },
    });

    const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const result = await resolveAgentRecordIds(["demo-echo-agent"], client);

    expect(result.get("demo-echo-agent")).toBe("mjaKkVyqoFGN");
  });

  test("falls back to scan when GetItem fails", async () => {
    ddbMock.on(GetCommand).rejects(new Error("GetItem failed"));
    ddbMock.on(ScanCommand).resolves({
      Items: [{ agentId: "mjaKkVyqoFGN" }],
    });

    const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const result = await resolveAgentRecordIds(["demo-echo-agent"], client);

    expect(result.get("demo-echo-agent")).toBe("mjaKkVyqoFGN");
  });

  test("returns empty map when AGENT_CONFIG_TABLE is unset", async () => {
    const saved = process.env.AGENT_CONFIG_TABLE;
    delete process.env.AGENT_CONFIG_TABLE;

    const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const result = await resolveAgentRecordIds(["demo-echo-agent"], client);

    expect(result.size).toBe(0);
    process.env.AGENT_CONFIG_TABLE = saved;
  });

  test("deduplicates input names", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        agentId: "demo-echo-agent",
        _canonicalRecordId: "mjaKkVyqoFGN",
      },
    });

    const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    await resolveAgentRecordIds(["demo-echo-agent", "demo-echo-agent"], client);

    // Should only make 1 GetCommand call even though the name appears twice
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
  });

  test("resolves multiple agents independently", async () => {
    ddbMock.on(GetCommand).callsFake((input) => {
      const key = input.Key?.agentId;
      if (key === "demo-echo-agent") {
        return {
          Item: {
            _canonicalRecordId: "mjaKkVyqoFGN",
            registryRecordId: "mjaKkVyqoFGN",
          },
        };
      }
      if (key === "smoke-idempotency-agent") {
        return {
          Item: {
            _canonicalRecordId: "obEoj56JCATf",
            registryRecordId: "obEoj56JCATf",
          },
        };
      }
      return { Item: undefined };
    });

    const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const result = await resolveAgentRecordIds(
      ["demo-echo-agent", "smoke-idempotency-agent"],
      client,
    );

    expect(result.get("demo-echo-agent")).toBe("mjaKkVyqoFGN");
    expect(result.get("smoke-idempotency-agent")).toBe("obEoj56JCATf");
    expect(result.size).toBe(2);
  });
});
