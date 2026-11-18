/**
 * Citadel PR-1 — C2: KnowledgeBaseAdapter.preflight ownership verification.
 *
 * Verifies:
 * 1. preflight exists on KnowledgeBaseAdapter.
 * 2. CREATE_NEW with no caller-supplied KB/collection target: preflight is a
 *    no-op (nothing to verify yet).
 * 3. CREATE_NEW with a caller-injected knowledgeBaseId/collectionId/
 *    collectionArn/storageConfiguration: preflight verifies ownership before
 *    allowing reuse.
 * 4. CONNECT_EXISTING requires both knowledgeBaseId and collectionId; absent
 *    -> throws without any platform call.
 * 5. CONNECT_EXISTING with tags matching ctx.orgId/dataStoreId passes.
 * 6. CONNECT_EXISTING with mismatched or absent tags throws (fail closed).
 * 7. preflight uses PLATFORM clients (ambient Lambda creds), never scoped
 *    credentials — it must run before any role is vended.
 */
import {
  BedrockAgentClient,
  GetKnowledgeBaseCommand,
  ListTagsForResourceCommand as BedrockListTagsForResourceCommand,
} from "@aws-sdk/client-bedrock-agent";
import {
  OpenSearchServerlessClient,
  BatchGetCollectionCommand,
  ListTagsForResourceCommand as OssListTagsForResourceCommand,
} from "@aws-sdk/client-opensearchserverless";
import { mockClient } from "aws-sdk-client-mock";

jest.mock("@aws-sdk/client-sts", () => ({
  STSClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({ Account: "123456789012" }),
    config: { region: () => Promise.resolve("us-east-1") },
  })),
  GetCallerIdentityCommand: jest.fn(),
}));

const bedrockMock = mockClient(BedrockAgentClient);
const ossMock = mockClient(OpenSearchServerlessClient);

import { KnowledgeBaseAdapter } from "../knowledge-base-adapter";
import { ConnectionError, ProvisioningError } from "../errors";

describe("KnowledgeBaseAdapter.preflight (C2)", () => {
  const adapter = new KnowledgeBaseAdapter();

  beforeEach(() => {
    bedrockMock.reset();
    ossMock.reset();
  });

  it("exists as a function on the adapter", () => {
    expect(typeof adapter.preflight).toBe("function");
  });

  it("CREATE_NEW with no caller-supplied target is a no-op (nothing to verify yet)", async () => {
    await expect(
      adapter.preflight!(
        { name: "my-kb" },
        { dataStoreId: "ds-1", orgId: "org-1", provisionMode: "CREATE_NEW" },
      ),
    ).resolves.toBeUndefined();
    expect(bedrockMock.calls()).toHaveLength(0);
    expect(ossMock.calls()).toHaveLength(0);
  });

  it("CREATE_NEW with a caller-injected knowledgeBaseId verifies ownership", async () => {
    bedrockMock.on(GetKnowledgeBaseCommand).resolves({
      knowledgeBase: {
        knowledgeBaseId: "KB-1",
        knowledgeBaseArn:
          "arn:aws:bedrock:us-east-1:123456789012:knowledge-base/KB-1",
      },
    });
    bedrockMock.on(BedrockListTagsForResourceCommand).resolves({
      tags: { "citadel:orgId": "org-1", "citadel:dataStoreId": "ds-1" },
    });
    ossMock.on(BatchGetCollectionCommand).resolves({
      collectionDetails: [
        {
          id: "col-1",
          arn: "arn:aws:aoss:us-east-1:123456789012:collection/col-1",
        },
      ],
    });
    ossMock.on(OssListTagsForResourceCommand).resolves({
      tags: [
        { key: "citadel:orgId", value: "org-1" },
        { key: "citadel:dataStoreId", value: "ds-1" },
      ],
    });

    await expect(
      adapter.preflight!(
        {
          name: "my-kb",
          knowledgeBaseId: "KB-1",
          collectionId: "col-1",
        },
        { dataStoreId: "ds-1", orgId: "org-1", provisionMode: "CREATE_NEW" },
      ),
    ).resolves.toBeUndefined();
  });

  it("CREATE_NEW with a caller-injected target owned by another org throws", async () => {
    bedrockMock.on(GetKnowledgeBaseCommand).resolves({
      knowledgeBase: {
        knowledgeBaseId: "KB-1",
        knowledgeBaseArn:
          "arn:aws:bedrock:us-east-1:123456789012:knowledge-base/KB-1",
      },
    });
    bedrockMock.on(BedrockListTagsForResourceCommand).resolves({
      tags: {
        "citadel:orgId": "org-ATTACKER",
        "citadel:dataStoreId": "ds-OTHER",
      },
    });
    ossMock.on(BatchGetCollectionCommand).resolves({
      collectionDetails: [
        {
          id: "col-1",
          arn: "arn:aws:aoss:us-east-1:123456789012:collection/col-1",
        },
      ],
    });
    ossMock.on(OssListTagsForResourceCommand).resolves({
      tags: [
        { key: "citadel:orgId", value: "org-ATTACKER" },
        { key: "citadel:dataStoreId", value: "ds-OTHER" },
      ],
    });

    await expect(
      adapter.preflight!(
        { name: "my-kb", knowledgeBaseId: "KB-1", collectionId: "col-1" },
        {
          dataStoreId: "ds-1",
          orgId: "org-victim",
          provisionMode: "CREATE_NEW",
        },
      ),
    ).rejects.toThrow(ProvisioningError);
  });

  it("CONNECT_EXISTING without knowledgeBaseId/collectionId throws without any platform call", async () => {
    await expect(
      adapter.preflight!(
        { name: "my-kb" },
        {
          dataStoreId: "ds-1",
          orgId: "org-1",
          provisionMode: "CONNECT_EXISTING",
        },
      ),
    ).rejects.toThrow(ConnectionError);
    expect(bedrockMock.calls()).toHaveLength(0);
    expect(ossMock.calls()).toHaveLength(0);
  });

  it("CONNECT_EXISTING with matching tags resolves", async () => {
    bedrockMock.on(GetKnowledgeBaseCommand).resolves({
      knowledgeBase: {
        knowledgeBaseId: "KB-1",
        knowledgeBaseArn:
          "arn:aws:bedrock:us-east-1:123456789012:knowledge-base/KB-1",
      },
    });
    bedrockMock.on(BedrockListTagsForResourceCommand).resolves({
      tags: { "citadel:orgId": "org-1", "citadel:dataStoreId": "ds-1" },
    });
    ossMock.on(BatchGetCollectionCommand).resolves({
      collectionDetails: [
        {
          id: "col-1",
          arn: "arn:aws:aoss:us-east-1:123456789012:collection/col-1",
        },
      ],
    });
    ossMock.on(OssListTagsForResourceCommand).resolves({
      tags: [
        { key: "citadel:orgId", value: "org-1" },
        { key: "citadel:dataStoreId", value: "ds-1" },
      ],
    });

    await expect(
      adapter.preflight!(
        { knowledgeBaseId: "KB-1", collectionId: "col-1" },
        {
          dataStoreId: "ds-1",
          orgId: "org-1",
          provisionMode: "CONNECT_EXISTING",
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("CONNECT_EXISTING with mismatched KB tags throws", async () => {
    bedrockMock.on(GetKnowledgeBaseCommand).resolves({
      knowledgeBase: {
        knowledgeBaseId: "KB-1",
        knowledgeBaseArn:
          "arn:aws:bedrock:us-east-1:123456789012:knowledge-base/KB-1",
      },
    });
    bedrockMock.on(BedrockListTagsForResourceCommand).resolves({
      tags: {
        "citadel:orgId": "org-ATTACKER",
        "citadel:dataStoreId": "ds-OTHER",
      },
    });
    ossMock.on(BatchGetCollectionCommand).resolves({
      collectionDetails: [
        {
          id: "col-1",
          arn: "arn:aws:aoss:us-east-1:123456789012:collection/col-1",
        },
      ],
    });
    ossMock.on(OssListTagsForResourceCommand).resolves({
      tags: [
        { key: "citadel:orgId", value: "org-1" },
        { key: "citadel:dataStoreId", value: "ds-1" },
      ],
    });

    await expect(
      adapter.preflight!(
        { knowledgeBaseId: "KB-1", collectionId: "col-1" },
        {
          dataStoreId: "ds-1",
          orgId: "org-1",
          provisionMode: "CONNECT_EXISTING",
        },
      ),
    ).rejects.toThrow(ProvisioningError);
  });

  it("CONNECT_EXISTING with mismatched collection tags throws", async () => {
    bedrockMock.on(GetKnowledgeBaseCommand).resolves({
      knowledgeBase: {
        knowledgeBaseId: "KB-1",
        knowledgeBaseArn:
          "arn:aws:bedrock:us-east-1:123456789012:knowledge-base/KB-1",
      },
    });
    bedrockMock.on(BedrockListTagsForResourceCommand).resolves({
      tags: { "citadel:orgId": "org-1", "citadel:dataStoreId": "ds-1" },
    });
    ossMock.on(BatchGetCollectionCommand).resolves({
      collectionDetails: [
        {
          id: "col-1",
          arn: "arn:aws:aoss:us-east-1:123456789012:collection/col-1",
        },
      ],
    });
    ossMock.on(OssListTagsForResourceCommand).resolves({
      tags: [
        { key: "citadel:orgId", value: "org-ATTACKER" },
        { key: "citadel:dataStoreId", value: "ds-OTHER" },
      ],
    });

    await expect(
      adapter.preflight!(
        { knowledgeBaseId: "KB-1", collectionId: "col-1" },
        {
          dataStoreId: "ds-1",
          orgId: "org-1",
          provisionMode: "CONNECT_EXISTING",
        },
      ),
    ).rejects.toThrow(ProvisioningError);
  });

  it("preflight uses platform clients, not scoped credentials (no credentials param)", () => {
    // Structural assertion: preflight's signature takes (config, ctx) only —
    // no credentials parameter — so it can never be handed scoped creds.
    expect(adapter.preflight!.length).toBeLessThanOrEqual(2);
  });
});
