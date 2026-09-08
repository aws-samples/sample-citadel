/**
 * Authorization tests for agent-code-resolver.ts (finding 1a9181a4).
 *
 * BEFORE this fix: getAgentCode/updateAgentCode read/wrote S3+DynamoDB with
 * NO identity read and NO org reconciliation — any authenticated caller of
 * any org could read or OVERWRITE any tenant's agent Python source
 * (RCE-adjacent, since the code executes with that agent's scoped creds).
 *
 * AFTER this fix: both ops load the agent's Registry record via
 * RegistryService.getResource("agent", agentId) — the SAME lookup
 * agent-config-resolver.ts uses for agent registry records (flat
 * `orgId`, no per-record ACL map, unlike the AgentApp `manifest.access`
 * shape guarded by assertManifestAccess in registry-agent-record-resolver.ts,
 * which does not fit this resource type) — then reconcile the record's
 * orgId against the SERVER-DERIVED caller org via the shared
 * `assertRowOrg` gate (backend/src/utils/auth-event.ts), reused unchanged
 * because RegistryService.mapToAgentConfig(record) already projects a
 * `{orgId}`-shaped object. The write additionally requires the caller hold
 * the `architect` platform role (or admin) — see the resolver file's
 * top-of-write comment for the role justification.
 *
 * Acceptance (per task):
 *  - cross-org caller refused on BOTH ops, with ZERO S3 get, ZERO S3 put,
 *    ZERO DynamoDB access (mocks assert no calls at all)
 *  - same-org caller lacking the architect/admin role refused on the WRITE
 *    (read has no role requirement, mirroring getAgentConfigRegistry)
 *  - legitimate (same-org, correctly-roled) caller succeeds on both ops
 *  - fail closed on: absent identity, unresolvable org, missing registry
 *    record
 */
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  BedrockAgentCoreControlClient,
  GetRegistryRecordCommand,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { mockClient } from "aws-sdk-client-mock";

const dynamoMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const registryMock = mockClient(BedrockAgentCoreControlClient);

import { handler } from "../agent-code-resolver";

type HandlerEvent = Parameters<typeof handler>[0];

function makeEvent(
  fieldName: string,
  args: Record<string, unknown>,
  identity?: Record<string, unknown>,
): HandlerEvent {
  return {
    info: { fieldName },
    arguments: args,
    identity,
  } as unknown as HandlerEvent;
}

/** Agent registry record custom metadata matching AgentCustomMetadata shape. */
function agentDescriptor(orgId: string): string {
  return JSON.stringify({
    categories: [],
    icon: "",
    state: "active",
    manifest: { note: "presence of `manifest` marks this record type=agent" },
    orgId,
  });
}

function mockRegistryRecord(recordId: string, orgId: string | null): void {
  registryMock.on(GetRegistryRecordCommand).resolves({
    recordId,
    name: recordId,
    status: "APPROVED",
    descriptors:
      orgId === null
        ? undefined
        : { custom: { inlineContent: agentDescriptor(orgId) } },
  });
}

describe("agent-code-resolver — authorization (finding 1a9181a4)", () => {
  beforeEach(() => {
    dynamoMock.reset();
    s3Mock.reset();
    registryMock.reset();
    process.env.AGENT_BUCKET_NAME = "test-bucket";
    process.env.AGENT_CONFIG_TABLE = "test-agent-config";
    process.env.REGISTRY_ID = "test-registry-id";
  });

  afterEach(() => {
    delete process.env.AGENT_BUCKET_NAME;
    delete process.env.AGENT_CONFIG_TABLE;
    delete process.env.REGISTRY_ID;
  });

  const ORG_A = "org-a";
  const ORG_B = "org-b";

  const orgACaller = { sub: "user-a", "custom:organization": ORG_A };
  const orgAArchitect = {
    sub: "architect-a",
    "custom:organization": ORG_A,
    "custom:role": "architect",
  };
  const orgBCaller = { sub: "user-b", "custom:organization": ORG_B };
  const adminCaller = {
    sub: "admin-1",
    "custom:organization": ORG_B,
    "custom:role": "admin",
  };

  function expectZeroDataAccess() {
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(dynamoMock.commandCalls(GetCommand)).toHaveLength(0);
  }

  describe("cross-org caller refused on both operations, zero data access", () => {
    test("getAgentCode: org-B caller reading org-A's agent is refused before any S3/DynamoDB call", async () => {
      mockRegistryRecord("agent-1", ORG_A);

      await expect(
        handler(makeEvent("getAgentCode", { agentId: "agent-1" }, orgBCaller)),
      ).rejects.toThrow();

      expectZeroDataAccess();
    });

    test("updateAgentCode: org-B caller overwriting org-A's agent is refused before any S3/DynamoDB call", async () => {
      mockRegistryRecord("agent-1", ORG_A);

      await expect(
        handler(
          makeEvent(
            "updateAgentCode",
            { input: { agentId: "agent-1", code: "os.system('rm -rf /')" } },
            orgBCaller,
          ),
        ),
      ).rejects.toThrow();

      expectZeroDataAccess();
    });
  });

  describe("same-org caller lacking the required role is refused on the write only", () => {
    test("updateAgentCode: same-org caller with no architect/admin role is refused, zero data access", async () => {
      mockRegistryRecord("agent-1", ORG_A);

      await expect(
        handler(
          makeEvent(
            "updateAgentCode",
            { input: { agentId: "agent-1", code: "print(1)" } },
            orgACaller,
          ),
        ),
      ).rejects.toThrow();

      expectZeroDataAccess();
    });
  });

  describe("legitimate caller succeeds", () => {
    test("getAgentCode: same-org caller (no role required for read) succeeds", async () => {
      mockRegistryRecord("agent-1", ORG_A);
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: "agent-1", config: { filename: "agent-1.py" } },
      });
      s3Mock.on(GetObjectCommand).resolves({
        Body: undefined,
        VersionId: "v1",
      });

      const result = (await handler(
        makeEvent("getAgentCode", { agentId: "agent-1" }, orgACaller),
      )) as { agentId: string };

      expect(result.agentId).toBe("agent-1");
    });

    test("updateAgentCode: same-org architect succeeds and writes to S3", async () => {
      mockRegistryRecord("agent-1", ORG_A);
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: "agent-1", config: { filename: "agent-1.py" } },
      });
      s3Mock.on(PutObjectCommand).resolves({ VersionId: "v2" });

      const result = (await handler(
        makeEvent(
          "updateAgentCode",
          { input: { agentId: "agent-1", code: "print('ok')" } },
          orgAArchitect,
        ),
      )) as { agentId: string; code: string };

      expect(result.agentId).toBe("agent-1");
      expect(result.code).toBe("print('ok')");
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
    });

    test("updateAgentCode: admin succeeds regardless of org", async () => {
      mockRegistryRecord("agent-1", ORG_A);
      dynamoMock.on(GetCommand).resolves({
        Item: { agentId: "agent-1", config: { filename: "agent-1.py" } },
      });
      s3Mock.on(PutObjectCommand).resolves({ VersionId: "v3" });

      const result = (await handler(
        makeEvent(
          "updateAgentCode",
          { input: { agentId: "agent-1", code: "print('admin')" } },
          adminCaller,
        ),
      )) as { agentId: string };

      expect(result.agentId).toBe("agent-1");
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
    });
  });

  describe("fail closed", () => {
    test("getAgentCode: absent identity is refused, zero data access", async () => {
      mockRegistryRecord("agent-1", ORG_A);

      await expect(
        handler(makeEvent("getAgentCode", { agentId: "agent-1" }, undefined)),
      ).rejects.toThrow();

      expectZeroDataAccess();
    });

    test("updateAgentCode: absent identity is refused, zero data access", async () => {
      mockRegistryRecord("agent-1", ORG_A);

      await expect(
        handler(
          makeEvent(
            "updateAgentCode",
            { input: { agentId: "agent-1", code: "x" } },
            undefined,
          ),
        ),
      ).rejects.toThrow();

      expectZeroDataAccess();
    });

    test("getAgentCode: caller with unresolvable org (no custom:organization claim) is refused", async () => {
      mockRegistryRecord("agent-1", ORG_A);

      await expect(
        handler(
          makeEvent(
            "getAgentCode",
            { agentId: "agent-1" },
            { sub: "no-org-user" },
          ),
        ),
      ).rejects.toThrow();

      expectZeroDataAccess();
    });

    test("updateAgentCode: caller with unresolvable org is refused", async () => {
      mockRegistryRecord("agent-1", ORG_A);

      await expect(
        handler(
          makeEvent(
            "updateAgentCode",
            { input: { agentId: "agent-1", code: "x" } },
            { sub: "no-org-user" },
          ),
        ),
      ).rejects.toThrow();

      expectZeroDataAccess();
    });

    test("getAgentCode: missing registry record is refused (not silently treated as public)", async () => {
      registryMock.on(GetRegistryRecordCommand).rejects(
        Object.assign(new Error("not found"), {
          name: "ResourceNotFoundException",
        }),
      );

      await expect(
        handler(
          makeEvent("getAgentCode", { agentId: "ghost-agent" }, orgACaller),
        ),
      ).rejects.toThrow();

      expectZeroDataAccess();
    });

    test("updateAgentCode: missing registry record is refused", async () => {
      registryMock.on(GetRegistryRecordCommand).rejects(
        Object.assign(new Error("not found"), {
          name: "ResourceNotFoundException",
        }),
      );

      await expect(
        handler(
          makeEvent(
            "updateAgentCode",
            { input: { agentId: "ghost-agent", code: "x" } },
            orgAArchitect,
          ),
        ),
      ).rejects.toThrow();

      expectZeroDataAccess();
    });

    test("getAgentCode: registry record with no orgId (malformed/legacy) is refused for a non-admin caller", async () => {
      mockRegistryRecord("agent-1", null);

      await expect(
        handler(makeEvent("getAgentCode", { agentId: "agent-1" }, orgACaller)),
      ).rejects.toThrow();

      expectZeroDataAccess();
    });
  });
});
