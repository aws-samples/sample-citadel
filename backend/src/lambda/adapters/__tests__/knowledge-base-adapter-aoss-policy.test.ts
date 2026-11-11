/**
 * TDD Tests for KnowledgeBaseAdapter AOSS data access policy scoping (C7).
 *
 * Verifies:
 * 1. AOSS data access policy principals contain the service role + vended role, NEVER account root.
 * 2. Policy rules are scoped to the datastore's collection and indexes.
 * 3. requiredPolicies.connect includes aoss:APIAccessAll on the collection ARN.
 * 4. requiredPolicies.connect includes bedrock Retrieve/GetKnowledgeBase on KB ARN.
 */

import { MOCK_SCOPED_CREDENTIALS } from "./helpers/mock-credentials";

const mockSend = jest.fn();
const mockIamSend = jest.fn();
const mockStsSend = jest.fn();
const mockOssSend = jest.fn();

jest.mock("@aws-sdk/client-bedrock-agent", () => ({
  BedrockAgentClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  CreateKnowledgeBaseCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "CreateKnowledgeBase", input })),
  GetKnowledgeBaseCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "GetKnowledgeBase", input })),
  DeleteKnowledgeBaseCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "DeleteKnowledgeBase", input })),
}));

jest.mock("@aws-sdk/client-iam", () => ({
  IAMClient: jest.fn().mockImplementation(() => ({ send: mockIamSend })),
  CreateRoleCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "CreateRole", input })),
  PutRolePolicyCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "PutRolePolicy", input })),
  DeleteRolePolicyCommand: jest.fn(),
  DeleteRoleCommand: jest.fn(),
}));

jest.mock("@aws-sdk/client-sts", () => ({
  STSClient: jest.fn().mockImplementation(() => ({
    send: mockStsSend,
    config: { region: () => Promise.resolve("us-west-2") },
  })),
  GetCallerIdentityCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "GetCallerIdentity", input })),
}));

jest.mock("@aws-sdk/client-opensearchserverless", () => ({
  OpenSearchServerlessClient: jest
    .fn()
    .mockImplementation(() => ({ send: mockOssSend })),
  CreateSecurityPolicyCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "CreateSecurityPolicy", input })),
  CreateAccessPolicyCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "CreateAccessPolicy", input })),
  CreateCollectionCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "CreateCollection", input })),
  DeleteCollectionCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "DeleteCollection", input })),
  BatchGetCollectionCommand: jest
    .fn()
    .mockImplementation((input) => ({ _type: "BatchGetCollection", input })),
}));

import { KnowledgeBaseAdapter } from "../knowledge-base-adapter";
import { CreateAccessPolicyCommand } from "@aws-sdk/client-opensearchserverless";

describe("KnowledgeBaseAdapter AOSS policy scoping (C7)", () => {
  let adapter: KnowledgeBaseAdapter;

  beforeEach(() => {
    adapter = new KnowledgeBaseAdapter();
    adapter.roleCreationDelayMs = 0;
    adapter.collectionPollIntervalMs = 0;
    adapter.collectionMaxWaitMs = 5000;
    mockSend.mockReset();
    mockIamSend.mockReset();
    mockStsSend.mockReset();
    mockOssSend.mockReset();
    jest.mocked(CreateAccessPolicyCommand).mockClear();

    mockStsSend.mockResolvedValue({ Account: "123456789012" });
    mockIamSend.mockResolvedValue({});
    mockOssSend.mockImplementation((cmd: { _type: string }) => {
      if (cmd._type === "CreateSecurityPolicy")
        return Promise.resolve({ securityPolicyDetail: {} });
      if (cmd._type === "CreateAccessPolicy")
        return Promise.resolve({ accessPolicyDetail: {} });
      if (cmd._type === "CreateCollection")
        return Promise.resolve({
          createCollectionDetail: {
            id: "col-abc123",
            arn: "arn:aws:aoss:us-west-2:123456789012:collection/col-abc123",
            status: "CREATING",
          },
        });
      if (cmd._type === "BatchGetCollection")
        return Promise.resolve({
          collectionDetails: [
            {
              id: "col-abc123",
              arn: "arn:aws:aoss:us-west-2:123456789012:collection/col-abc123",
              collectionEndpoint:
                "https://col-abc123.us-west-2.aoss.amazonaws.com",
              status: "ACTIVE",
            },
          ],
        });
      return Promise.resolve({});
    });

    (adapter as unknown as { createVectorIndex: jest.Mock }).createVectorIndex =
      jest.fn().mockResolvedValue(undefined);

    mockSend.mockResolvedValue({
      knowledgeBase: {
        knowledgeBaseId: "KB123",
        knowledgeBaseArn:
          "arn:aws:bedrock:us-west-2:123456789012:knowledge-base/KB123",
        status: "CREATING",
      },
    });
  });

  describe("data access policy principals", () => {
    test("policy document has NO :root principal", async () => {
      await adapter.provision(
        { name: "test-kb", dataStoreId: "ds-abc" },
        MOCK_SCOPED_CREDENTIALS,
      );

      const accessPolicyCalls = jest.mocked(CreateAccessPolicyCommand).mock
        .calls;
      expect(accessPolicyCalls.length).toBeGreaterThanOrEqual(1);

      const policyInput = accessPolicyCalls[0][0];
      const policyDoc = JSON.parse(policyInput.policy as string);
      const principals: string[] = policyDoc[0].Principal;

      expect(principals.join(",")).not.toContain(":root");
    });

    test("principals include the KB service role ARN", async () => {
      await adapter.provision(
        { name: "test-kb", dataStoreId: "ds-abc" },
        MOCK_SCOPED_CREDENTIALS,
      );

      const accessPolicyCalls = jest.mocked(CreateAccessPolicyCommand).mock
        .calls;
      const policyDoc = JSON.parse(accessPolicyCalls[0][0].policy as string);
      const principals: string[] = policyDoc[0].Principal;

      const serviceRolePrincipal = principals.find((p) =>
        p.includes("citadel-ds-kb-svc-"),
      );
      expect(serviceRolePrincipal).toBeDefined();
    });

    test("principals include the vended datastore role ARN when dataStoreId is provided", async () => {
      await adapter.provision(
        { name: "test-kb", dataStoreId: "ds-abc" },
        MOCK_SCOPED_CREDENTIALS,
      );

      const accessPolicyCalls = jest.mocked(CreateAccessPolicyCommand).mock
        .calls;
      const policyDoc = JSON.parse(accessPolicyCalls[0][0].policy as string);
      const principals: string[] = policyDoc[0].Principal;

      expect(principals).toContain(
        "arn:aws:iam::123456789012:role/citadel-ds-ds-abc",
      );
    });

    test("principals are exactly two roles when dataStoreId is provided", async () => {
      await adapter.provision(
        { name: "test-kb", dataStoreId: "ds-abc" },
        MOCK_SCOPED_CREDENTIALS,
      );

      const accessPolicyCalls = jest.mocked(CreateAccessPolicyCommand).mock
        .calls;
      const policyDoc = JSON.parse(accessPolicyCalls[0][0].policy as string);
      const principals: string[] = policyDoc[0].Principal;

      expect(principals).toHaveLength(2);
      // First is the KB service role, second is the vended datastore role
      expect(principals[0]).toMatch(/citadel-ds-kb-svc-/);
      expect(principals[1]).toBe(
        "arn:aws:iam::123456789012:role/citadel-ds-ds-abc",
      );
    });

    test("only service role principal when dataStoreId is absent", async () => {
      await adapter.provision({ name: "test-kb" }, MOCK_SCOPED_CREDENTIALS);

      const accessPolicyCalls = jest.mocked(CreateAccessPolicyCommand).mock
        .calls;
      const policyDoc = JSON.parse(accessPolicyCalls[0][0].policy as string);
      const principals: string[] = policyDoc[0].Principal;

      expect(principals).toHaveLength(1);
      expect(principals[0]).toMatch(/citadel-ds-kb-svc-/);
    });
  });

  describe("data access policy rules scoping", () => {
    test("rules are scoped to the collection and indexes only", async () => {
      await adapter.provision(
        { name: "test-kb", dataStoreId: "ds-abc" },
        MOCK_SCOPED_CREDENTIALS,
      );

      const accessPolicyCalls = jest.mocked(CreateAccessPolicyCommand).mock
        .calls;
      const policyDoc = JSON.parse(accessPolicyCalls[0][0].policy as string);
      const rules = policyDoc[0].Rules;

      // Index rule scoped to collection/*
      const indexRule = rules.find(
        (r: { ResourceType: string }) => r.ResourceType === "index",
      );
      expect(indexRule.Resource).toEqual(
        expect.arrayContaining([expect.stringMatching(/^index\/aifkb-/)]),
      );
      // Every index resource starts with index/<collection-name>
      for (const res of indexRule.Resource) {
        expect(res).toMatch(/^index\/aifkb-/);
      }

      // Collection rule scoped to specific collection
      const collRule = rules.find(
        (r: { ResourceType: string }) => r.ResourceType === "collection",
      );
      expect(collRule.Resource).toEqual(
        expect.arrayContaining([expect.stringMatching(/^collection\/aifkb-/)]),
      );
    });
  });

  describe("requiredPolicies.connect", () => {
    test("includes aoss:APIAccessAll on specific collection ID", () => {
      const policies = adapter.requiredPolicies(
        { knowledgeBaseId: "KB123", collectionId: "col-abc123" },
        "123456789012",
        "us-west-2",
      );

      const aossStatement = policies.connect.find((s) =>
        s.actions.includes("aoss:APIAccessAll"),
      );
      expect(aossStatement).toBeDefined();
      expect(aossStatement!.resources).toEqual([
        "arn:aws:aoss:us-west-2:123456789012:collection/col-abc123",
      ]);
    });

    test("returns empty connect policies when knowledgeBaseId/collectionId absent (CIT-299)", () => {
      const policies = adapter.requiredPolicies(
        {},
        "123456789012",
        "us-west-2",
      );

      // No wildcard fallback — empty connect policies
      expect(policies.connect).toEqual([]);
    });

    test("includes bedrock:Retrieve and bedrock:GetKnowledgeBase scoped to specific KB", () => {
      const policies = adapter.requiredPolicies(
        { knowledgeBaseId: "KB123", collectionId: "col-abc123" },
        "123456789012",
        "us-west-2",
      );

      const bedrockStatement = policies.connect.find((s) =>
        s.actions.includes("bedrock:Retrieve"),
      );
      expect(bedrockStatement).toBeDefined();
      expect(bedrockStatement!.actions).toContain("bedrock:GetKnowledgeBase");
      expect(bedrockStatement!.resources).toEqual([
        "arn:aws:bedrock:us-west-2:123456789012:knowledge-base/KB123",
      ]);
    });

    test("connect with IDs has exactly 2 policy statements", () => {
      const policies = adapter.requiredPolicies(
        { knowledgeBaseId: "KB123", collectionId: "col-abc123" },
        "123456789012",
        "us-west-2",
      );
      expect(policies.connect).toHaveLength(2);
    });
  });
});
