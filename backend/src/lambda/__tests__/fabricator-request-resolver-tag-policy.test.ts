/**
 * CIT-042 PR2: tag-policy enforcement for fabrication requests
 * (fabricator-request-resolver.ts).
 *
 * 4 cases per function (requestAgentCreation / requestToolCreation):
 *   1. strict + missing required key → TAG_POLICY_VIOLATION, no SQS send
 *   2. shadow → proceeds with warn
 *   3. no policy → proceeds
 *   4. request without tags → enforcement NOT called
 */
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const sqsMock = mockClient(SQSClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

process.env.FABRICATOR_QUEUE_URL = "https://sqs.test/queue";
process.env.FABRICATION_JOBS_TABLE = "citadel-fabrication-jobs-test";
process.env.ORGANIZATIONS_TABLE = "orgs-table";

// ── mocks: tag-policy-check (enforcement adapter) ──────────────────────
const mockEnforceTagPolicy = jest.fn();

class TagPolicyViolationError extends Error {
  readonly code = "TAG_POLICY_VIOLATION" as const;
  constructor(
    public readonly violations: Array<{ type: string; key: string }>,
    public readonly action: string,
    public readonly orgId: string,
  ) {
    super(
      `tag_policy_violation: missing required keys: ${violations.map((v) => v.key).join(", ")}`,
    );
    this.name = "TagPolicyViolationError";
  }
}

jest.mock("../tag-policy-check", () => ({
  __esModule: true,
  enforceTagPolicy: mockEnforceTagPolicy,
  TagPolicyViolationError,
}));

import { handler } from "../fabricator-request-resolver";

// ── helpers ────────────────────────────────────────────────────────────
const TEST_ORG = "org-caller";

const makeEvent = (
  fieldName: string,
  input: Record<string, unknown>,
  identity: Record<string, unknown> = {
    sub: "user-123",
    "custom:organization": TEST_ORG,
    "cognito:groups": ["architect"],
  },
) => ({
  info: { fieldName },
  arguments: { input },
  identity,
});

// ── tests ──────────────────────────────────────────────────────────────
describe("fabricator-request-resolver tag-policy enforcement", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    sqsMock.reset();
    ddbMock.reset();
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "m1" });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(GetCommand).resolves({ Item: undefined });
  });

  // ─── requestAgentCreation ─────────────────────────────────────────
  describe("requestAgentCreation", () => {
    it("strict + missing required key → TAG_POLICY_VIOLATION, no SQS send", async () => {
      mockEnforceTagPolicy.mockRejectedValueOnce(
        new TagPolicyViolationError(
          [{ type: "MISSING_KEY", key: "env" }],
          "fabricateAgent",
          TEST_ORG,
        ),
      );

      await expect(
        handler(
          makeEvent("requestAgentCreation", {
            agentName: "TestAgent",
            taskDescription: "desc",
            tags: { team: "platform" },
          }),
        ),
      ).rejects.toThrow(TagPolicyViolationError);

      expect(mockEnforceTagPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: TEST_ORG,
          action: "fabricateAgent",
          tags: { team: "platform" },
        }),
      );
      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    });

    it("shadow → proceeds with warn", async () => {
      mockEnforceTagPolicy.mockResolvedValueOnce({
        ok: false,
        violations: [{ type: "MISSING_KEY", key: "env" }],
      });

      const result = await handler(
        makeEvent("requestAgentCreation", {
          agentName: "TestAgent",
          taskDescription: "desc",
          tags: { team: "platform" },
        }),
      );

      expect(mockEnforceTagPolicy).toHaveBeenCalled();
      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
      expect(result).toMatchObject({ success: true });
    });

    it("no policy → proceeds", async () => {
      mockEnforceTagPolicy.mockResolvedValueOnce({
        ok: true,
        violations: [],
      });

      const result = await handler(
        makeEvent("requestAgentCreation", {
          agentName: "TestAgent",
          taskDescription: "desc",
          tags: { env: "prod" },
        }),
      );

      expect(mockEnforceTagPolicy).toHaveBeenCalled();
      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
      expect(result).toMatchObject({ success: true });
    });

    it("request without tags → enforcement NOT called", async () => {
      const result = await handler(
        makeEvent("requestAgentCreation", {
          agentName: "TestAgent",
          taskDescription: "desc",
        }),
      );

      expect(mockEnforceTagPolicy).not.toHaveBeenCalled();
      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
      expect(result).toMatchObject({ success: true });
    });
  });

  // ─── requestToolCreation ──────────────────────────────────────────
  describe("requestToolCreation", () => {
    it("strict + missing required key → TAG_POLICY_VIOLATION, no SQS send", async () => {
      mockEnforceTagPolicy.mockRejectedValueOnce(
        new TagPolicyViolationError(
          [{ type: "MISSING_KEY", key: "env" }],
          "fabricateTool",
          TEST_ORG,
        ),
      );

      await expect(
        handler(
          makeEvent("requestToolCreation", {
            toolName: "TestTool",
            toolDescription: "desc",
            tags: { team: "platform" },
          }),
        ),
      ).rejects.toThrow(TagPolicyViolationError);

      expect(mockEnforceTagPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          orgId: TEST_ORG,
          action: "fabricateTool",
          tags: { team: "platform" },
        }),
      );
      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
    });

    it("shadow → proceeds with warn", async () => {
      mockEnforceTagPolicy.mockResolvedValueOnce({
        ok: false,
        violations: [{ type: "MISSING_KEY", key: "env" }],
      });

      const result = await handler(
        makeEvent("requestToolCreation", {
          toolName: "TestTool",
          toolDescription: "desc",
          tags: { team: "platform" },
        }),
      );

      expect(mockEnforceTagPolicy).toHaveBeenCalled();
      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
      expect(result).toMatchObject({ success: true });
    });

    it("no policy → proceeds", async () => {
      mockEnforceTagPolicy.mockResolvedValueOnce({
        ok: true,
        violations: [],
      });

      const result = await handler(
        makeEvent("requestToolCreation", {
          toolName: "TestTool",
          toolDescription: "desc",
          tags: { env: "prod" },
        }),
      );

      expect(mockEnforceTagPolicy).toHaveBeenCalled();
      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
      expect(result).toMatchObject({ success: true });
    });

    it("request without tags → enforcement NOT called", async () => {
      const result = await handler(
        makeEvent("requestToolCreation", {
          toolName: "TestTool",
          toolDescription: "desc",
        }),
      );

      expect(mockEnforceTagPolicy).not.toHaveBeenCalled();
      expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(1);
      expect(result).toMatchObject({ success: true });
    });
  });
});
