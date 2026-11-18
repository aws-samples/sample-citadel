/**
 * Citadel PR-1 — C1: KnowledgeBaseAdapter naming + ownership tests.
 *
 * Verifies:
 * 1. Service role name and AOSS collection name are derived ONLY from
 *    immutable ids (dataStoreId/orgId), never from the tenant display name.
 * 2. Two data stores with the identical display name produce distinct
 *    role/collection names.
 * 3. Derived collection name is AOSS-legal (<=32 chars, starts with a
 *    letter, lowercase alphanumeric + hyphen).
 * 4. Role/collection/KB creation requests carry citadel:orgId and
 *    citadel:dataStoreId tags.
 * 5. EntityAlreadyExists / ConflictException with MISMATCHED tags throws
 *    (never adopts another tenant's resource).
 * 6. EntityAlreadyExists / ConflictException with MATCHING tags is treated
 *    as an idempotent reuse (no throw).
 * 7. provision() throws if dataStoreId/orgId are absent from config
 *    (fail closed — never falls back to display-name naming).
 */
import {
  IAMClient,
  CreateRoleCommand,
  GetRoleCommand,
  ListRoleTagsCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import {
  OpenSearchServerlessClient,
  CreateCollectionCommand,
  CreateSecurityPolicyCommand,
  CreateAccessPolicyCommand,
  BatchGetCollectionCommand,
  ListTagsForResourceCommand,
} from "@aws-sdk/client-opensearchserverless";
import { mockClient } from "aws-sdk-client-mock";

jest.mock("@aws-sdk/client-sts", () => ({
  STSClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({ Account: "123456789012" }),
    config: { region: () => Promise.resolve("us-east-1") },
  })),
  GetCallerIdentityCommand: jest.fn(),
}));

const iamMock = mockClient(IAMClient);
const ossMock = mockClient(OpenSearchServerlessClient);

import { KnowledgeBaseAdapter } from "../knowledge-base-adapter";
import { ProvisioningError } from "../errors";

import { markScopedCredentials } from "../credential-guard";
describe("KnowledgeBaseAdapter ownership (C1)", () => {
  const adapter = new KnowledgeBaseAdapter();
  adapter.roleCreationDelayMs = 0;
  adapter.collectionPollIntervalMs = 0;
  adapter.collectionMaxWaitMs = 1000;

  beforeEach(() => {
    iamMock.reset();
    ossMock.reset();
    iamMock.on(CreateRoleCommand).resolves({});
    iamMock.on(PutRolePolicyCommand).resolves({});
    ossMock.on(CreateSecurityPolicyCommand).resolves({});
    ossMock.on(CreateAccessPolicyCommand).resolves({});
  });

  describe("deriveServiceRoleName / deriveCollectionName", () => {
    test("two data stores with identical display names derive distinct role names", () => {
      const nameA = (
        adapter as unknown as {
          deriveServiceRoleName: (dataStoreId: string) => string;
        }
      ).deriveServiceRoleName("ds-aaaa");
      const nameB = (
        adapter as unknown as {
          deriveServiceRoleName: (dataStoreId: string) => string;
        }
      ).deriveServiceRoleName("ds-bbbb");
      expect(nameA).not.toBe(nameB);
      expect(nameA.length).toBeLessThanOrEqual(64);
    });

    test("two data stores with identical display names derive distinct collection names", () => {
      const deriveCollectionName = (
        adapter as unknown as {
          deriveCollectionName: (orgId: string, dataStoreId: string) => string;
        }
      ).deriveCollectionName.bind(adapter);
      const nameA = deriveCollectionName("org-1", "ds-aaaa");
      const nameB = deriveCollectionName("org-1", "ds-bbbb");
      expect(nameA).not.toBe(nameB);
    });

    test("collection name is AOSS-legal: <=32 chars, starts with a letter, lowercase alnum+hyphen", () => {
      const deriveCollectionName = (
        adapter as unknown as {
          deriveCollectionName: (orgId: string, dataStoreId: string) => string;
        }
      ).deriveCollectionName.bind(adapter);
      const name = deriveCollectionName("org-1", "ds-aaaa");
      expect(name.length).toBeLessThanOrEqual(32);
      expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
    });

    test("collection name never derives from the display name", () => {
      const deriveCollectionName = (
        adapter as unknown as {
          deriveCollectionName: (orgId: string, dataStoreId: string) => string;
        }
      ).deriveCollectionName.bind(adapter);
      const name = deriveCollectionName("org-1", "ds-aaaa");
      expect(name).not.toContain("attacker");
      expect(name).not.toContain("display");
    });
  });

  describe("provision fail-closed on missing ids", () => {
    test("throws when config.dataStoreId is absent", async () => {
      await expect(
        adapter.provision(
          { name: "my-kb", orgId: "org-1" },
          markScopedCredentials({
            accessKeyId: "AK",
            secretAccessKey: "SK",
            sessionToken: "ST",
          }),
        ),
      ).rejects.toThrow(ProvisioningError);
    });

    test("throws when config.orgId is absent", async () => {
      await expect(
        adapter.provision(
          { name: "my-kb", dataStoreId: "ds-1" },
          markScopedCredentials({
            accessKeyId: "AK",
            secretAccessKey: "SK",
            sessionToken: "ST",
          }),
        ),
      ).rejects.toThrow(ProvisioningError);
    });
  });

  describe("createServiceRole tagging + conflict handling", () => {
    test("CreateRoleCommand includes citadel:orgId and citadel:dataStoreId tags", async () => {
      const createServiceRole = (
        adapter as unknown as {
          createServiceRole: (
            dataStoreId: string,
            orgId: string,
            collectionArn: string,
          ) => Promise<string>;
        }
      ).createServiceRole.bind(adapter);

      await createServiceRole(
        "ds-1",
        "org-1",
        "arn:aws:aoss:us-east-1:123456789012:collection/abc",
      );

      const calls = iamMock.commandCalls(CreateRoleCommand);
      expect(calls).toHaveLength(1);
      const tags = calls[0].args[0].input.Tags!;
      expect(tags).toEqual(
        expect.arrayContaining([
          { Key: "citadel:orgId", Value: "org-1" },
          { Key: "citadel:dataStoreId", Value: "ds-1" },
        ]),
      );
    });

    test("EntityAlreadyExists with MATCHING tags does not throw", async () => {
      const err = new Error("EntityAlreadyExists");
      err.name = "EntityAlreadyExistsException";
      iamMock.on(CreateRoleCommand).rejects(err);
      iamMock.on(GetRoleCommand).resolves({
        Role: {
          RoleName: "r",
          Arn: "arn:aws:iam::123456789012:role/r",
        } as never,
      });
      iamMock.on(ListRoleTagsCommand).resolves({
        Tags: [
          { Key: "citadel:orgId", Value: "org-1" },
          { Key: "citadel:dataStoreId", Value: "ds-1" },
        ],
      });

      const createServiceRole = (
        adapter as unknown as {
          createServiceRole: (
            dataStoreId: string,
            orgId: string,
            collectionArn: string,
          ) => Promise<string>;
        }
      ).createServiceRole.bind(adapter);

      await expect(
        createServiceRole(
          "ds-1",
          "org-1",
          "arn:aws:aoss:us-east-1:123456789012:collection/abc",
        ),
      ).resolves.toBeDefined();
    });

    test("EntityAlreadyExists with MISMATCHED tags throws (never adopts)", async () => {
      const err = new Error("EntityAlreadyExists");
      err.name = "EntityAlreadyExistsException";
      iamMock.on(CreateRoleCommand).rejects(err);
      iamMock.on(GetRoleCommand).resolves({
        Role: {
          RoleName: "r",
          Arn: "arn:aws:iam::123456789012:role/r",
        } as never,
      });
      iamMock.on(ListRoleTagsCommand).resolves({
        Tags: [
          { Key: "citadel:orgId", Value: "org-ATTACKER" },
          { Key: "citadel:dataStoreId", Value: "ds-OTHER" },
        ],
      });

      const createServiceRole = (
        adapter as unknown as {
          createServiceRole: (
            dataStoreId: string,
            orgId: string,
            collectionArn: string,
          ) => Promise<string>;
        }
      ).createServiceRole.bind(adapter);

      await expect(
        createServiceRole(
          "ds-1",
          "org-victim",
          "arn:aws:aoss:us-east-1:123456789012:collection/abc",
        ),
      ).rejects.toThrow(ProvisioningError);
    });

    test("EntityAlreadyExists with NO tags throws (never adopts untagged legacy role)", async () => {
      const err = new Error("EntityAlreadyExists");
      err.name = "EntityAlreadyExistsException";
      iamMock.on(CreateRoleCommand).rejects(err);
      iamMock.on(GetRoleCommand).resolves({
        Role: {
          RoleName: "r",
          Arn: "arn:aws:iam::123456789012:role/r",
        } as never,
      });
      iamMock.on(ListRoleTagsCommand).resolves({ Tags: [] });

      const createServiceRole = (
        adapter as unknown as {
          createServiceRole: (
            dataStoreId: string,
            orgId: string,
            collectionArn: string,
          ) => Promise<string>;
        }
      ).createServiceRole.bind(adapter);

      await expect(
        createServiceRole(
          "ds-1",
          "org-victim",
          "arn:aws:aoss:us-east-1:123456789012:collection/abc",
        ),
      ).rejects.toThrow(ProvisioningError);
    });
  });

  describe("provisionVectorStore tagging + conflict handling", () => {
    test("CreateCollectionCommand includes citadel:orgId and citadel:dataStoreId tags", async () => {
      ossMock.on(CreateCollectionCommand).resolves({
        createCollectionDetail: {
          id: "col-1",
          arn: "arn:aws:aoss:us-east-1:123456789012:collection/col-1",
        },
      });
      ossMock.on(BatchGetCollectionCommand).resolves({
        collectionDetails: [
          {
            id: "col-1",
            status: "ACTIVE",
            collectionEndpoint: "https://col-1.us-east-1.aoss.amazonaws.com",
          },
        ],
      });
      // avoid the real HTTPS index-create call
      const createIndexSpy = jest
        .spyOn(
          adapter as unknown as {
            createVectorIndex: (...a: unknown[]) => Promise<void>;
          },
          "createVectorIndex",
        )
        .mockResolvedValue(undefined);

      const provisionVectorStore = (
        adapter as unknown as {
          provisionVectorStore: (
            dataStoreId: string,
            orgId: string,
            serviceRoleArn: string,
            accountId: string,
            vendedRoleArn?: string,
          ) => Promise<{ collectionArn: string; collectionId: string }>;
        }
      ).provisionVectorStore.bind(adapter);

      await provisionVectorStore(
        "ds-1",
        "org-1",
        "arn:aws:iam::123456789012:role/svc",
        "123456789012",
      );

      const calls = ossMock.commandCalls(CreateCollectionCommand);
      expect(calls).toHaveLength(1);
      const tags = calls[0].args[0].input.tags;
      expect(tags).toEqual(
        expect.arrayContaining([
          { key: "citadel:orgId", value: "org-1" },
          { key: "citadel:dataStoreId", value: "ds-1" },
        ]),
      );
      createIndexSpy.mockRestore();
    });

    test("ConflictException with MISMATCHED collection tags throws (never adopts)", async () => {
      const conflict = new Error("ConflictException");
      conflict.name = "ConflictException";
      ossMock.on(CreateCollectionCommand).rejects(conflict);
      ossMock.on(BatchGetCollectionCommand).resolves({
        collectionDetails: [
          {
            id: "col-OTHER",
            arn: "arn:aws:aoss:us-east-1:123456789012:collection/col-OTHER",
            status: "ACTIVE",
            collectionEndpoint: "https://x.aoss.amazonaws.com",
          },
        ],
      });
      ossMock.on(ListTagsForResourceCommand).resolves({
        tags: [
          { key: "citadel:orgId", value: "org-ATTACKER" },
          { key: "citadel:dataStoreId", value: "ds-OTHER" },
        ],
      });

      const provisionVectorStore = (
        adapter as unknown as {
          provisionVectorStore: (
            dataStoreId: string,
            orgId: string,
            serviceRoleArn: string,
            accountId: string,
            vendedRoleArn?: string,
          ) => Promise<{ collectionArn: string; collectionId: string }>;
        }
      ).provisionVectorStore.bind(adapter);

      await expect(
        provisionVectorStore(
          "ds-1",
          "org-victim",
          "arn:aws:iam::123456789012:role/svc",
          "123456789012",
        ),
      ).rejects.toThrow(ProvisioningError);
    });
  });
});
