/**
 * Tests for fabricator-request-resolver Lambda.
 *
 * The resolver enqueues a fabrication request onto SQS and then writes a
 * PENDING row to the durable fabrication-jobs table so the queue UI shows
 * real per-agent status instead of peeking SQS. The status write is
 * best-effort: a failure must NOT fail the enqueue (the caller already got a
 * queued request).
 */
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const sqsMock = mockClient(SQSClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

process.env.FABRICATOR_QUEUE_URL = "https://sqs.test/queue";
process.env.FABRICATION_JOBS_TABLE = "citadel-fabrication-jobs-test";

import { handler } from "../fabricator-request-resolver";

const makeEvent = (
  fieldName: string,
  input: Record<string, unknown>,
  identity: Record<string, unknown> = {
    sub: "user-123",
    "custom:organization": "org-caller",
    "custom:role": "architect",
  },
) => ({
  info: { fieldName },
  arguments: { input },
  identity,
});

describe("fabricator-request-resolver", () => {
  beforeEach(() => {
    sqsMock.reset();
    ddbMock.reset();
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "m1" });
    ddbMock.on(PutCommand).resolves({});
    process.env.FABRICATION_JOBS_TABLE = "citadel-fabrication-jobs-test";
  });

  describe("org tenancy (fail-closed)", () => {
    test("requestAgentCreation throws and sends zero SQS messages when caller has no organization", async () => {
      await expect(
        handler(
          makeEvent(
            "requestAgentCreation",
            { agentName: "NoOrgAgent", taskDescription: "desc" },
            { sub: "user-no-org" },
          ),
        ),
      ).rejects.toThrow("Access denied: no organization is provisioned");

      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test("requestToolCreation throws and sends zero SQS messages when caller has no organization", async () => {
      await expect(
        handler(
          makeEvent(
            "requestToolCreation",
            { toolName: "NoOrgTool", toolDescription: "desc" },
            { sub: "user-no-org" },
          ),
        ),
      ).rejects.toThrow("Access denied: no organization is provisioned");

      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test("stamps the server-derived orgId (never null) on the SQS message body", async () => {
      await handler(
        makeEvent("requestAgentCreation", {
          agentName: "OrgAgent",
          taskDescription: "desc",
        }),
      );

      const call = sqsMock.commandCalls(SendMessageCommand)[0];
      const body = JSON.parse(call.args[0].input.MessageBody as string);
      expect(body.org_id).toBe("org-caller");
    });

    test("stamps the server-derived orgId on the PENDING status row", async () => {
      await handler(
        makeEvent("requestToolCreation", {
          toolName: "OrgTool",
          toolDescription: "desc",
        }),
      );

      const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!;
      expect(item.orgId).toBe("org-caller");
    });

    test("ignores a client-smuggled orgId on the input and uses the server-derived org instead", async () => {
      await handler(
        makeEvent("requestAgentCreation", {
          agentName: "SmuggledOrgAgent",
          taskDescription: "desc",
          orgId: "attacker-org",
        }),
      );

      const call = sqsMock.commandCalls(SendMessageCommand)[0];
      const body = JSON.parse(call.args[0].input.MessageBody as string);
      expect(body.org_id).toBe("org-caller");
      expect(body.org_id).not.toBe("attacker-org");

      const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!;
      expect(item.orgId).toBe("org-caller");
    });
  });

  describe("role gate (decision 2763e85f — architect or admin, after the org check)", () => {
    test("requestAgentCreation rejects a non-architect non-admin caller with a valid org, before any SQS send", async () => {
      await expect(
        handler(
          makeEvent(
            "requestAgentCreation",
            { agentName: "DeveloperAgent", taskDescription: "desc" },
            {
              sub: "user-dev",
              "custom:organization": "org-caller",
              "custom:role": "developer",
            },
          ),
        ),
      ).rejects.toThrow(
        "Access denied: requires architect or admin role to request agent creation",
      );

      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test("requestToolCreation rejects a non-architect non-admin caller with a valid org, before any SQS send", async () => {
      await expect(
        handler(
          makeEvent(
            "requestToolCreation",
            { toolName: "DeveloperTool", toolDescription: "desc" },
            {
              sub: "user-dev",
              "custom:organization": "org-caller",
              "custom:role": "developer",
            },
          ),
        ),
      ).rejects.toThrow(
        "Access denied: requires architect or admin role to request tool creation",
      );

      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test("requestAgentCreation still rejects a role-less caller missing an org (org check runs first)", async () => {
      await expect(
        handler(
          makeEvent(
            "requestAgentCreation",
            { agentName: "NoOrgAgent", taskDescription: "desc" },
            { sub: "user-no-org", "custom:role": "developer" },
          ),
        ),
      ).rejects.toThrow("Access denied: no organization is provisioned");

      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    });

    test("architect caller (custom:role) passes for requestAgentCreation", async () => {
      const result = await handler(
        makeEvent(
          "requestAgentCreation",
          { agentName: "ArchitectAgent", taskDescription: "desc" },
          {
            sub: "user-arch",
            "custom:organization": "org-caller",
            "custom:role": "architect",
          },
        ),
      );

      expect(result.success).toBe(true);
      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
    });

    test("admin caller (cognito:groups) passes for requestToolCreation", async () => {
      const result = await handler(
        makeEvent(
          "requestToolCreation",
          { toolName: "AdminTool", toolDescription: "desc" },
          {
            sub: "user-admin",
            "custom:organization": "org-caller",
            "cognito:groups": ["admin"],
          },
        ),
      );

      expect(result.success).toBe(true);
      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
    });
  });

  test("writes a PENDING row after the SQS send for agent creation", async () => {
    const result = await handler(
      makeEvent("requestAgentCreation", {
        agentName: "InvoiceParser",
        taskDescription: "Parse invoices from PDFs",
      }),
    );

    expect(result.success).toBe(true);
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);

    const puts = ddbMock.commandCalls(PutCommand);
    expect(puts).toHaveLength(1);
    const item = puts[0].args[0].input.Item!;
    expect(puts[0].args[0].input.TableName).toBe(
      "citadel-fabrication-jobs-test",
    );
    expect(item.orchestrationId).toBe("0");
    expect(item.agentUseId).toBe(result.requestId);
    expect(item.status).toBe("PENDING");
    expect(item.agentName).toBe("InvoiceParser");
    expect(item.requestType).toBe("agent-creation");
    expect(item.requestedBy).toBe("user-123");
    expect(typeof item.submittedAt).toBe("string");
    expect(typeof item.updatedAt).toBe("string");
    expect(typeof item.ttl).toBe("number");
    expect(item.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test("truncates taskDescription to ~500 chars", async () => {
    const longDesc = "x".repeat(2000);
    await handler(
      makeEvent("requestAgentCreation", {
        agentName: "BigAgent",
        taskDescription: longDesc,
      }),
    );
    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect((item.taskDescription as string).length).toBeLessThanOrEqual(500);
  });

  test("does NOT fail the enqueue when the status write throws", async () => {
    ddbMock.on(PutCommand).rejects(new Error("ddb down"));

    const result = await handler(
      makeEvent("requestToolCreation", {
        toolName: "CsvExporter",
        toolDescription: "Export rows to CSV",
      }),
    );

    expect(result.success).toBe(true);
    expect(result.requestId).toBeDefined();
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
  });

  test("skips the status write when FABRICATION_JOBS_TABLE is unset", async () => {
    delete process.env.FABRICATION_JOBS_TABLE;

    const result = await handler(
      makeEvent("requestAgentCreation", {
        agentName: "NoTableAgent",
        taskDescription: "No table configured",
      }),
    );

    expect(result.success).toBe(true);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });
});
