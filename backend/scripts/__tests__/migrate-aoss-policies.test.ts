/**
 * Tests for migrate-aoss-policies.ts
 *
 * Covers:
 *   - dry-run reads policies but writes nothing (no UpdateAccessPolicy)
 *   - apply mode calls UpdateAccessPolicy with cleaned principals
 *   - root principal is removed from policy
 *   - vended datastore role is added as principal
 *   - already-clean policies are skipped
 *   - missing policies are skipped gracefully
 *   - rows with no name are skipped
 *   - pagination via LastEvaluatedKey
 *   - idempotent: running twice produces same result
 */
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import {
  OpenSearchServerlessClient,
  GetAccessPolicyCommand,
  UpdateAccessPolicyCommand,
} from "@aws-sdk/client-opensearchserverless";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

import { runMigration, type MigrateClients } from "../migrate-aoss-policies";

const dynamoMock = mockClient(DynamoDBDocumentClient);
const ossMock = mockClient(OpenSearchServerlessClient);
const stsMock = mockClient(STSClient);

function makeClients(): MigrateClients {
  return {
    dynamodb: dynamoMock as unknown as DynamoDBDocumentClient,
    oss: ossMock as unknown as OpenSearchServerlessClient,
    sts: stsMock as unknown as STSClient,
  };
}

const ACCOUNT_ID = "123456789012";
const ROOT_PRINCIPAL = `arn:aws:iam::${ACCOUNT_ID}:root`;
const SERVICE_ROLE = `arn:aws:iam::${ACCOUNT_ID}:role/citadel-ds-kb-svc-og-test-kb`;
const DS_ID = "abc-123";
const VENDED_ROLE = `arn:aws:iam::${ACCOUNT_ID}:role/citadel-ds-${DS_ID}`;

function makePolicyDoc(principals: string[]) {
  return JSON.stringify([
    {
      Rules: [
        {
          Resource: ["index/aifkb-og-test-kb/*"],
          Permission: ["aoss:ReadDocument", "aoss:WriteDocument"],
          ResourceType: "index",
        },
        {
          Resource: ["collection/aifkb-og-test-kb"],
          Permission: ["aoss:CreateCollectionItems"],
          ResourceType: "collection",
        },
      ],
      Principal: principals,
    },
  ]);
}

describe("migrate-aoss-policies", () => {
  beforeEach(() => {
    dynamoMock.reset();
    ossMock.reset();
    stsMock.reset();

    stsMock.on(GetCallerIdentityCommand).resolves({ Account: ACCOUNT_ID });
  });

  function setupKbRow(overrides?: Partial<{ dataStoreId: string; name: string; config: string }>) {
    dynamoMock.on(ScanCommand).resolves({
      Items: [
        {
          dataStoreId: DS_ID,
          type: "KNOWLEDGE_BASE",
          name: "og-test-kb",
          config: JSON.stringify({ name: "og-test-kb" }),
          ...overrides,
        },
      ],
    });
  }

  describe("dry-run mode", () => {
    test("reads policies but does NOT call UpdateAccessPolicy", async () => {
      setupKbRow();
      ossMock.on(GetAccessPolicyCommand).resolves({
        accessPolicyDetail: {
          policyVersion: "v1",
          policy: makePolicyDoc([SERVICE_ROLE, ROOT_PRINCIPAL]),
        },
      });

      const result = await runMigration(
        { table: "test-table", dryRun: true },
        makeClients(),
      );

      expect(result.updated).toBe(1);
      expect(ossMock.commandCalls(UpdateAccessPolicyCommand)).toHaveLength(0);
    });
  });

  describe("apply mode", () => {
    test("calls UpdateAccessPolicy removing root and adding vended role", async () => {
      setupKbRow();
      ossMock.on(GetAccessPolicyCommand).resolves({
        accessPolicyDetail: {
          policyVersion: "v1",
          policy: makePolicyDoc([SERVICE_ROLE, ROOT_PRINCIPAL]),
        },
      });
      ossMock.on(UpdateAccessPolicyCommand).resolves({});

      const result = await runMigration(
        { table: "test-table", dryRun: false },
        makeClients(),
      );

      expect(result.updated).toBe(1);
      const updateCalls = ossMock.commandCalls(UpdateAccessPolicyCommand);
      expect(updateCalls).toHaveLength(1);

      const input = updateCalls[0].args[0].input;
      expect(input.policyVersion).toBe("v1");

      const updatedPolicy = JSON.parse(input.policy as string);
      const principals: string[] = updatedPolicy[0].Principal;

      // No root
      expect(principals.join(",")).not.toContain(":root");
      // Has service role
      expect(principals).toContain(SERVICE_ROLE);
      // Has vended role
      expect(principals).toContain(VENDED_ROLE);
    });
  });

  describe("already clean", () => {
    test("skips policies that have no root and already have vended role", async () => {
      setupKbRow();
      ossMock.on(GetAccessPolicyCommand).resolves({
        accessPolicyDetail: {
          policyVersion: "v2",
          policy: makePolicyDoc([SERVICE_ROLE, VENDED_ROLE]),
        },
      });

      const result = await runMigration(
        { table: "test-table", dryRun: false },
        makeClients(),
      );

      expect(result.alreadyClean).toBe(1);
      expect(result.updated).toBe(0);
      expect(ossMock.commandCalls(UpdateAccessPolicyCommand)).toHaveLength(0);
    });
  });

  describe("missing policy", () => {
    test("skips gracefully when policy is not found", async () => {
      setupKbRow();
      const notFound = new Error("Policy not found");
      notFound.name = "ResourceNotFoundException";
      ossMock.on(GetAccessPolicyCommand).rejects(notFound);

      const result = await runMigration(
        { table: "test-table", dryRun: false },
        makeClients(),
      );

      expect(result.skipped).toBe(1);
      expect(result.failed).toBe(0);
    });
  });

  describe("row with no name", () => {
    test("skips rows where name cannot be derived", async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [
          {
            dataStoreId: DS_ID,
            type: "KNOWLEDGE_BASE",
            name: "",
            config: "{}",
          },
        ],
      });

      const result = await runMigration(
        { table: "test-table", dryRun: true },
        makeClients(),
      );

      expect(result.skipped).toBe(1);
    });
  });

  describe("pagination", () => {
    test("handles paginated scan results", async () => {
      dynamoMock
        .on(ScanCommand)
        .resolvesOnce({
          Items: [
            {
              dataStoreId: "ds-1",
              type: "KNOWLEDGE_BASE",
              name: "kb-one",
              config: JSON.stringify({ name: "kb-one" }),
            },
          ],
          LastEvaluatedKey: { dataStoreId: "ds-1" },
        })
        .resolvesOnce({
          Items: [
            {
              dataStoreId: "ds-2",
              type: "KNOWLEDGE_BASE",
              name: "kb-two",
              config: JSON.stringify({ name: "kb-two" }),
            },
          ],
        });

      // Both return clean policies
      ossMock.on(GetAccessPolicyCommand).resolves({
        accessPolicyDetail: {
          policyVersion: "v1",
          policy: makePolicyDoc([SERVICE_ROLE, ROOT_PRINCIPAL]),
        },
      });

      const result = await runMigration(
        { table: "test-table", dryRun: true },
        makeClients(),
      );

      expect(result.scanned).toBe(2);
      expect(result.updated).toBe(2);
    });
  });

  describe("error handling", () => {
    test("tracks failures without aborting", async () => {
      setupKbRow();
      const error = new Error("Access denied");
      error.name = "AccessDeniedException";
      ossMock.on(GetAccessPolicyCommand).rejects(error);

      const result = await runMigration(
        { table: "test-table", dryRun: false },
        makeClients(),
      );

      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].policyName).toContain("aifkb-");
    });
  });

  describe("idempotent", () => {
    test("running apply twice produces same result (second run sees clean state)", async () => {
      setupKbRow();

      // First run: root present → update
      ossMock
        .on(GetAccessPolicyCommand)
        .resolvesOnce({
          accessPolicyDetail: {
            policyVersion: "v1",
            policy: makePolicyDoc([SERVICE_ROLE, ROOT_PRINCIPAL]),
          },
        })
        // Second run: root gone, vended present → already clean
        .resolvesOnce({
          accessPolicyDetail: {
            policyVersion: "v2",
            policy: makePolicyDoc([SERVICE_ROLE, VENDED_ROLE]),
          },
        });
      ossMock.on(UpdateAccessPolicyCommand).resolves({});

      const result1 = await runMigration(
        { table: "test-table", dryRun: false },
        makeClients(),
      );
      expect(result1.updated).toBe(1);

      const result2 = await runMigration(
        { table: "test-table", dryRun: false },
        makeClients(),
      );
      expect(result2.alreadyClean).toBe(1);
      expect(result2.updated).toBe(0);
    });
  });
});
