import {
  BedrockAgentClient,
  CreateKnowledgeBaseCommand,
  GetKnowledgeBaseCommand,
  DeleteKnowledgeBaseCommand,
  ListTagsForResourceCommand as BedrockListTagsForResourceCommand,
  type KnowledgeBaseConfiguration,
  type StorageConfiguration,
} from "@aws-sdk/client-bedrock-agent";
import {
  OpenSearchServerlessClient,
  CreateSecurityPolicyCommand,
  CreateAccessPolicyCommand,
  CreateCollectionCommand,
  DeleteCollectionCommand,
  BatchGetCollectionCommand,
  ListTagsForResourceCommand as OssListTagsForResourceCommand,
} from "@aws-sdk/client-opensearchserverless";
import {
  IAMClient,
  CreateRoleCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  DeleteRoleCommand,
  GetRoleCommand,
  ListRoleTagsCommand,
} from "@aws-sdk/client-iam";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { createHash } from "crypto";
import {
  ConnectorAdapter,
  ConnectorCategory,
  ConnectorSpec,
  AuthenticationMethod,
  RequiredPolicies,
  ProvisionResult,
  ConnectionTestResult,
  MetricsResult,
} from "../../adapters/base";
import {
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
} from "./errors";
import { SdkError } from "./sdk-types";
import { requireScopedCredentials } from "./credential-guard";

const DEFAULT_EMBEDDING_MODEL = "amazon.titan-embed-text-v2:0";
const SERVICE_ROLE_POLICY_NAME = "BedrockKnowledgeBaseAccess";
const VECTOR_INDEX_NAME = "bedrock-knowledge-base-default-index";
const VECTOR_FIELD = "bedrock-knowledge-base-default-vector";
const TEXT_FIELD = "AMAZON_BEDROCK_TEXT_CHUNK";
const METADATA_FIELD = "AMAZON_BEDROCK_METADATA";

export class KnowledgeBaseAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = "datastore";
  readonly spec: ConnectorSpec = {
    type: "KNOWLEDGE_BASE",
    provider: "Amazon Web Services",
    category: "datastore",
    authentication: {
      method: AuthenticationMethod.IAM_ROLE,
      fields: [],
      secretStructure: {},
    },
    configuration: {
      required: ["knowledgeBaseId"],
      optional: [],
      ssmParameters: [],
    },
  };

  /** Delay (ms) after creating a service role to allow IAM propagation. Override in tests. */
  roleCreationDelayMs = 10000;
  /** Delay (ms) between polls when waiting for AOSS collection to become ACTIVE. */
  collectionPollIntervalMs = 5000;
  /** Maximum time (ms) to wait for AOSS collection to become ACTIVE. */
  collectionMaxWaitMs = 300000;

  private makeClient(
    creds: Record<string, unknown> | undefined,
    op: string,
  ): BedrockAgentClient {
    const credentials = requireScopedCredentials(creds, {
      adapter: "KnowledgeBaseAdapter",
      op,
    });
    return new BedrockAgentClient({ credentials });
  }

  /**
   * Create an OpenSearch Serverless client using scoped credentials.
   * Data-plane OSS operations (index creation, queries) must use vended creds.
   */
  private makeOssClient(
    creds: Record<string, unknown> | undefined,
    op: string,
  ): OpenSearchServerlessClient {
    const credentials = requireScopedCredentials(creds, {
      adapter: "KnowledgeBaseAdapter",
      op,
    });
    return new OpenSearchServerlessClient({ credentials });
  }

  /**
   * Create a Bedrock Agent client using the Lambda execution role (platform
   * credentials). ONLY for control-plane provisioning: CreateKnowledgeBase.
   * Continuum C3 (PR-2): this moves bedrock:CreateKnowledgeBase off the
   * vended citadel-ds-<id> role entirely — the role is now connect-only.
   * Runs under the datastore-resolver Lambda's directly-granted, tag/
   * region-constrained grants (backend-stack.ts).
   */
  private platformBedrockProvisionClient(): BedrockAgentClient {
    return new BedrockAgentClient({});
  }

  /**
   * Create an OSS client using the Lambda execution role (platform credentials).
   * ONLY for control-plane provisioning: creating AOSS security/access/network
   * policies and collections. These operations run under the datastore-resolver
   * Lambda's direct AOSS grants in CDK — not under the scoped citadel-ds-{id}
   * role. Each call site is explicitly named so the guard test can allowlist it.
   */
  private platformOssClient(): OpenSearchServerlessClient {
    return new OpenSearchServerlessClient({});
  }

  /**
   * Create an IAM client using the Lambda execution role (platform credentials).
   * ONLY for control-plane: creating/deleting the Bedrock KB service role
   * (citadel-ds-kb-svc-*). Runs under the datastore-resolver Lambda's direct
   * IAM grants.
   */
  private platformIamClient(): IAMClient {
    return new IAMClient({});
  }

  /**
   * Create an STS client using the Lambda execution role (platform credentials).
   * Used to discover the account ID and region — a read-only control-plane query.
   */
  private platformStsClient(): STSClient {
    return new STSClient({});
  }

  /**
   * Create a Bedrock Agent client using the Lambda execution role (platform
   * credentials). ONLY for control-plane preflight ownership checks (C2):
   * reading KB tags BEFORE any scoped role is vended.
   */
  private platformBedrockClient(): BedrockAgentClient {
    return new BedrockAgentClient({});
  }

  /**
   * Deterministic, collision-resistant, AOSS-legal (3-32 chars, starts with a
   * letter, lowercase alphanumeric + hyphen) collection name derived ONLY
   * from immutable ids. NEVER from the tenant display name (C1) — a display
   * name is mutable and attacker-influenced, so deriving a shared resource
   * name from it lets two tenants collide on the same AOSS collection.
   */
  private deriveCollectionName(orgId: string, dataStoreId: string): string {
    const hash = createHash("sha256")
      .update(`${orgId}:${dataStoreId}`)
      .digest("hex");
    return `aifkb-${hash.slice(0, 26)}`; // 6 + 26 = 32 chars, starts with 'a'
  }

  /**
   * IAM role name (<=64 chars). dataStoreId is a UUID, already globally
   * unique, so no additional hashing is needed. NEVER derived from the
   * tenant display name (C1).
   */
  private deriveServiceRoleName(dataStoreId: string): string {
    return `citadel-ds-kb-svc-${dataStoreId}`; // 18 + 36 = 54 chars
  }

  /** Emit a CloudWatch EMF metric for a refused KB/collection ownership check. */
  private emitKnowledgeBaseOwnershipRefused(): void {
    try {
      console.log(
        JSON.stringify({
          _aws: {
            Timestamp: Date.now(),
            CloudWatchMetrics: [
              {
                Namespace: "Citadel/Adapters",
                Dimensions: [["Adapter"]],
                Metrics: [
                  { Name: "KnowledgeBaseOwnershipRefused", Unit: "Count" },
                ],
              },
            ],
          },
          Adapter: "KnowledgeBase",
          KnowledgeBaseOwnershipRefused: 1,
        }),
      );
    } catch {
      // metrics must never break the caller
    }
  }

  requiredPolicies(
    _config: Record<string, unknown>,
    _accountId: string,
    _region: string,
  ): RequiredPolicies {
    // Continuum C3 (PR-2): `.provision` is CDK-mirrored platform-only
    // documentation — it is NEVER minted onto the tenant-assumable
    // citadel-ds-<id> role (the resolver mints only `.connect`, from
    // concrete post-provision ARNs). The create-verb
    // bedrock:CreateKnowledgeBase/TagResource grant now lives exclusively
    // on the datastore-resolver Lambda's own role (backend-stack.ts),
    // narrowed with an aws:RequestTag condition — it is never a candidate
    // for vending to a tenant-assumable role, so there is nothing left to
    // scope here by dataStoreId/orgId as the pre-PR-2 H4 fix did.
    const dataStoreId =
      typeof _config.dataStoreId === "string" ? _config.dataStoreId : undefined;

    const provision = dataStoreId
      ? [
          {
            actions: [
              "bedrock:CreateKnowledgeBase",
              "bedrock:GetKnowledgeBase",
              "bedrock:TagResource",
            ],
            resources: ["*"],
          },
          {
            actions: ["iam:PassRole"],
            resources: [
              `arn:aws:iam::${_accountId}:role/${this.deriveServiceRoleName(dataStoreId)}`,
            ],
          },
        ]
      : [];

    // CIT-299: scope connect policies to the datastore's own knowledge base
    // and collection. Both knowledgeBaseId and collectionId are REQUIRED at
    // connect time — the caller must have set them during provision or manual
    // configuration. A wildcard fallback is never used.
    const knowledgeBaseId =
      typeof _config.knowledgeBaseId === "string"
        ? _config.knowledgeBaseId
        : undefined;
    const collectionId =
      typeof _config.collectionId === "string"
        ? _config.collectionId
        : undefined;

    if (!knowledgeBaseId || !collectionId) {
      // connect() will reject with an opaque error before any role grant.
      // We cannot throw here because requiredPolicies is a pure
      // synchronous method and the resolver calls it speculatively.
      return { provision, connect: [] };
    }

    const knowledgeBaseArn = `arn:aws:bedrock:${_region}:${_accountId}:knowledge-base/${knowledgeBaseId}`;
    const collectionArn = `arn:aws:aoss:${_region}:${_accountId}:collection/${collectionId}`;

    return {
      provision,
      connect: [
        {
          actions: ["bedrock:GetKnowledgeBase", "bedrock:Retrieve"],
          resources: [knowledgeBaseArn],
        },
        {
          actions: ["aoss:APIAccessAll"],
          resources: [collectionArn],
        },
      ],
    };
  }

  /**
   * Get the AWS account ID and region from STS.
   */
  private async getAccountContext(): Promise<{
    accountId: string;
    region: string;
  }> {
    const stsClient = this.platformStsClient();
    const identity = await stsClient.send(new GetCallerIdentityCommand({}));
    const accountId = identity.Account!;
    const region = (await stsClient.config.region()) as string;
    return {
      accountId,
      region: typeof region === "string" ? region : "us-east-1",
    };
  }

  /**
   * Create a Bedrock service role that Bedrock can assume to access resources,
   * including permissions for OpenSearch Serverless API access.
   *
   * C1: the role name is derived ONLY from `dataStoreId` (never the display
   * name), and the role is tagged with citadel:orgId + citadel:dataStoreId.
   * On EntityAlreadyExistsException, the existing role's tags are read and
   * MUST match this org/dataStoreId — a mismatch or absence throws rather
   * than silently adopting another tenant's (or an untagged legacy) role.
   */
  private async createServiceRole(
    dataStoreId: string,
    orgId: string,
    collectionArn: string,
  ): Promise<string> {
    const iamClient = this.platformIamClient();
    const { accountId } = await this.getAccountContext();
    const roleName = this.deriveServiceRoleName(dataStoreId);

    const trustPolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "bedrock.amazonaws.com" },
          Action: "sts:AssumeRole",
        },
      ],
    };

    try {
      await iamClient.send(
        new CreateRoleCommand({
          RoleName: roleName,
          AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
          Tags: [
            { Key: "ManagedBy", Value: "citadel" },
            { Key: "Purpose", Value: "bedrock-knowledge-base-service-role" },
            { Key: "citadel:orgId", Value: orgId },
            { Key: "citadel:dataStoreId", Value: dataStoreId },
          ],
        }),
      );
    } catch (error) {
      const err = error as SdkError;
      if (err.name === "EntityAlreadyExistsException") {
        await this.verifyServiceRoleOwnership(
          iamClient,
          roleName,
          dataStoreId,
          orgId,
        );
      } else {
        throw new ProvisioningError(
          `Failed to create Bedrock service role: ${err.message}`,
          err,
        );
      }
    }

    // Policy granting Bedrock access to foundation models AND OpenSearch Serverless
    const policyDocument = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: [
            "bedrock:InvokeModel",
            "bedrock:InvokeModelWithResponseStream",
          ],
          Resource: ["*"],
        },
        {
          Effect: "Allow",
          Action: ["aoss:APIAccessAll"],
          Resource: [collectionArn],
        },
      ],
    };

    try {
      await iamClient.send(
        new PutRolePolicyCommand({
          RoleName: roleName,
          PolicyName: SERVICE_ROLE_POLICY_NAME,
          PolicyDocument: JSON.stringify(policyDocument),
        }),
      );
    } catch (error) {
      const err = error as SdkError;
      throw new ProvisioningError(
        `Failed to attach policy to Bedrock service role: ${err.message}`,
        err,
      );
    }

    return `arn:aws:iam::${accountId}:role/${roleName}`;
  }

  /**
   * C1: verify an existing IAM role carries citadel:orgId and
   * citadel:dataStoreId tags matching the caller's. Throws
   * ProvisioningError (never adopts) on any mismatch, absence, or lookup
   * failure (decision 44a2bfc1 — on conflict, reuse ONLY if tags match;
   * otherwise throw).
   */
  private async verifyServiceRoleOwnership(
    iamClient: IAMClient,
    roleName: string,
    dataStoreId: string,
    orgId: string,
  ): Promise<void> {
    try {
      await iamClient.send(new GetRoleCommand({ RoleName: roleName }));
      const tagResult = await iamClient.send(
        new ListRoleTagsCommand({ RoleName: roleName }),
      );
      const tags = tagResult.Tags ?? [];
      const hasOrg = tags.some(
        (t) => t.Key === "citadel:orgId" && t.Value === orgId,
      );
      const hasDs = tags.some(
        (t) => t.Key === "citadel:dataStoreId" && t.Value === dataStoreId,
      );
      if (!hasOrg || !hasDs) {
        console.warn("KB service role ownership tag mismatch", {
          roleName,
          expectedDataStoreId: dataStoreId,
          expectedOrgId: orgId,
        });
        this.emitKnowledgeBaseOwnershipRefused();
        throw new ProvisioningError("Knowledge base service role conflict");
      }
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      this.emitKnowledgeBaseOwnershipRefused();
      throw new ProvisioningError("Knowledge base service role conflict");
    }
  }

  /**
   * C1: verify an existing AOSS collection carries citadel:orgId and
   * citadel:dataStoreId tags matching the caller's. Throws
   * ProvisioningError (never adopts) on any mismatch, absence, or lookup
   * failure (decision 44a2bfc1).
   */
  private async verifyCollectionOwnership(
    ossClient: OpenSearchServerlessClient,
    collectionArn: string,
    dataStoreId: string,
    orgId: string,
  ): Promise<void> {
    try {
      const tagResult = await ossClient.send(
        new OssListTagsForResourceCommand({ resourceArn: collectionArn }),
      );
      const tags = tagResult.tags ?? [];
      const hasOrg = tags.some(
        (t) => t.key === "citadel:orgId" && t.value === orgId,
      );
      const hasDs = tags.some(
        (t) => t.key === "citadel:dataStoreId" && t.value === dataStoreId,
      );
      if (!hasOrg || !hasDs) {
        console.warn("AOSS collection ownership tag mismatch", {
          collectionArn,
          expectedDataStoreId: dataStoreId,
          expectedOrgId: orgId,
        });
        this.emitKnowledgeBaseOwnershipRefused();
        throw new ProvisioningError(
          "Knowledge base collection ownership verification failed",
        );
      }
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      this.emitKnowledgeBaseOwnershipRefused();
      throw new ProvisioningError(
        "Knowledge base collection ownership verification failed",
      );
    }
  }

  /**
   * Delete a Bedrock service role created during provisioning.
   */
  private async deleteServiceRole(roleName: string): Promise<void> {
    const iamClient = this.platformIamClient();
    try {
      await iamClient.send(
        new DeleteRolePolicyCommand({
          RoleName: roleName,
          PolicyName: SERVICE_ROLE_POLICY_NAME,
        }),
      );
    } catch (error) {
      const err = error as SdkError;
      if (err.name !== "NoSuchEntityException") {
        console.warn(`Failed to delete service role policy: ${err.message}`);
      }
    }
    try {
      await iamClient.send(new DeleteRoleCommand({ RoleName: roleName }));
    } catch (error) {
      const err = error as SdkError;
      if (err.name !== "NoSuchEntityException") {
        console.warn(`Failed to delete service role: ${err.message}`);
      }
    }
  }

  /**
   * Provision an OpenSearch Serverless VECTORSEARCH collection with the
   * required encryption, network, and data access policies.
   *
   * C1: the collection name is derived ONLY from orgId+dataStoreId (never
   * the display name), tagged with citadel:orgId + citadel:dataStoreId on
   * create, and a ConflictException is resolved via a tag-verified
   * reuse-or-throw check rather than unconditional adoption.
   */
  private async provisionVectorStore(
    dataStoreId: string,
    orgId: string,
    serviceRoleArn: string,
    accountId: string,
    vendedRoleArn?: string,
  ): Promise<{ collectionArn: string; collectionId: string }> {
    const ossClient = this.platformOssClient();
    const collectionName = this.deriveCollectionName(orgId, dataStoreId);
    const policyName = collectionName;

    // 1. Create encryption policy (required before collection creation)
    try {
      await ossClient.send(
        new CreateSecurityPolicyCommand({
          name: policyName,
          type: "encryption",
          description: `Encryption policy for KB collection ${collectionName}`,
          policy: JSON.stringify({
            Rules: [
              {
                ResourceType: "collection",
                Resource: [`collection/${collectionName}`],
              },
            ],
            AWSOwnedKey: true,
          }),
        }),
      );
    } catch (error) {
      const err = error as SdkError;
      if (err.name !== "ConflictException") {
        throw new ProvisioningError(
          `Failed to create encryption policy: ${err.message}`,
          err,
        );
      }
    }

    // 2. Create network policy (public access for Bedrock)
    try {
      await ossClient.send(
        new CreateSecurityPolicyCommand({
          name: policyName,
          type: "network",
          description: `Network policy for KB collection ${collectionName}`,
          policy: JSON.stringify([
            {
              Description: `Public access for ${collectionName}`,
              Rules: [
                {
                  ResourceType: "dashboard",
                  Resource: [`collection/${collectionName}`],
                },
                {
                  ResourceType: "collection",
                  Resource: [`collection/${collectionName}`],
                },
              ],
              AllowFromPublic: true,
            },
          ]),
        }),
      );
    } catch (error) {
      const err = error as SdkError;
      if (err.name !== "ConflictException") {
        throw new ProvisioningError(
          `Failed to create network policy: ${err.message}`,
          err,
        );
      }
    }

    // 3. Create data access policy granting the Bedrock service role access
    try {
      await ossClient.send(
        new CreateAccessPolicyCommand({
          name: policyName,
          type: "data",
          description: `Data access policy for KB collection ${collectionName}`,
          policy: JSON.stringify([
            {
              Rules: [
                {
                  Resource: [`index/${collectionName}/*`],
                  Permission: [
                    "aoss:CreateIndex",
                    "aoss:DeleteIndex",
                    "aoss:UpdateIndex",
                    "aoss:DescribeIndex",
                    "aoss:ReadDocument",
                    "aoss:WriteDocument",
                  ],
                  ResourceType: "index",
                },
                {
                  Resource: [`collection/${collectionName}`],
                  Permission: [
                    "aoss:CreateCollectionItems",
                    "aoss:DescribeCollectionItems",
                    "aoss:UpdateCollectionItems",
                  ],
                  ResourceType: "collection",
                },
              ],
              Principal: [
                serviceRoleArn,
                ...(vendedRoleArn ? [vendedRoleArn] : []),
              ],
            },
          ]),
        }),
      );
    } catch (error) {
      const err = error as SdkError;
      if (err.name !== "ConflictException") {
        throw new ProvisioningError(
          `Failed to create data access policy: ${err.message}`,
          err,
        );
      }
    }

    // 4. Create the VECTORSEARCH collection
    let collectionId: string | undefined;
    let collectionArn: string | undefined;
    try {
      const result = await ossClient.send(
        new CreateCollectionCommand({
          name: collectionName,
          type: "VECTORSEARCH",
          description: `Vector store for Bedrock Knowledge Base (dataStoreId=${dataStoreId})`,
          tags: [
            { key: "ManagedBy", value: "citadel" },
            { key: "citadel:orgId", value: orgId },
            { key: "citadel:dataStoreId", value: dataStoreId },
          ],
        }),
      );
      collectionId = result.createCollectionDetail?.id;
      collectionArn = result.createCollectionDetail?.arn;
    } catch (error) {
      const err = error as SdkError;
      if (err.name === "ConflictException") {
        // Collection already exists — resolve its identity, then verify
        // ownership tags before reusing it (decision 44a2bfc1: reuse ONLY
        // if citadel:orgId + citadel:dataStoreId match; otherwise throw).
        const existing = await ossClient.send(
          new BatchGetCollectionCommand({ names: [collectionName] }),
        );
        const detail = existing.collectionDetails?.[0];
        collectionId = detail?.id;
        collectionArn = detail?.arn;
        if (!collectionArn || !collectionId) {
          this.emitKnowledgeBaseOwnershipRefused();
          throw new ProvisioningError(
            `AOSS collection conflict but existing collection could not be resolved for ${collectionName}`,
          );
        }
        await this.verifyCollectionOwnership(
          ossClient,
          collectionArn,
          dataStoreId,
          orgId,
        );
      } else {
        throw new ProvisioningError(
          `Failed to create AOSS collection: ${err.message}`,
          err,
        );
      }
    }

    if (!collectionArn || !collectionId) {
      throw new ProvisioningError(
        `AOSS collection created but ARN/ID not returned for ${collectionName}`,
      );
    }

    // 5. Wait for collection to become ACTIVE
    let collectionEndpoint: string | undefined;
    const startTime = Date.now();
    while (Date.now() - startTime < this.collectionMaxWaitMs) {
      const status = await ossClient.send(
        new BatchGetCollectionCommand({ ids: [collectionId] }),
      );
      const detail = status.collectionDetails?.[0];
      if (detail?.status === "ACTIVE") {
        collectionEndpoint = detail.collectionEndpoint;
        break;
      }
      if (detail?.status === "FAILED") {
        throw new ProvisioningError(
          `AOSS collection ${collectionName} failed to create`,
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, this.collectionPollIntervalMs),
      );
    }

    if (!collectionEndpoint) {
      throw new ProvisioningError(
        `Timed out waiting for AOSS collection ${collectionName} to become ACTIVE`,
      );
    }

    // 6. Create the vector index inside the collection.
    // Wait briefly for data access policies to propagate before creating the index.
    await new Promise((resolve) =>
      setTimeout(resolve, this.roleCreationDelayMs),
    );
    await this.createVectorIndex(
      collectionEndpoint,
      VECTOR_INDEX_NAME,
      VECTOR_FIELD,
    );

    return { collectionArn, collectionId };
  }

  /**
   * Create a vector index in an AOSS collection using the OpenSearch REST API.
   * Uses SigV4-signed HTTPS requests.
   */
  private async createVectorIndex(
    endpoint: string,
    indexName: string,
    vectorField: string,
  ): Promise<void> {
    const { SignatureV4 } = await import("@aws-sdk/signature-v4");
    const { Sha256 } = await import("@aws-crypto/sha256-js");
    const { HttpRequest } = await import("@smithy/protocol-http");
    const { defaultProvider } =
      await import("@aws-sdk/credential-provider-node");
    const { region } = await this.getAccountContext();
    const https = await import("https");

    const host = endpoint.replace("https://", "");
    const body = JSON.stringify({
      settings: {
        "index.knn": true,
      },
      mappings: {
        properties: {
          [vectorField]: {
            type: "knn_vector",
            dimension: 1024,
            method: { engine: "faiss", name: "hnsw", space_type: "l2" },
          },
          [TEXT_FIELD]: { type: "text" },
          [METADATA_FIELD]: { type: "text" },
        },
      },
    });

    const request = new HttpRequest({
      method: "PUT",
      protocol: "https:",
      hostname: host,
      path: `/${indexName}`,
      headers: {
        "Content-Type": "application/json",
        host,
      },
      body,
    });

    const signer = new SignatureV4({
      service: "aoss",
      region,
      credentials: defaultProvider(),
      sha256: Sha256,
    });

    const signed = await signer.sign(request);

    await new Promise<void>((resolve, reject) => {
      const req = https.request(
        {
          hostname: host,
          path: `/${indexName}`,
          method: "PUT",
          headers: signed.headers,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => {
            data += chunk;
          });
          res.on("end", () => {
            if (res.statusCode === 200 || res.statusCode === 201) {
              resolve();
            } else if (
              res.statusCode === 400 &&
              data.includes("already_exists")
            ) {
              resolve(); // Index already exists
            } else {
              reject(
                new ProvisioningError(
                  `Failed to create vector index: HTTP ${res.statusCode} - ${data}`,
                ),
              );
            }
          });
        },
      );
      req.on("error", (err: Error) =>
        reject(
          new ProvisioningError(
            `Failed to create vector index: ${err.message}`,
            err,
          ),
        ),
      );
      req.write(body);
      req.end();
    });
  }

  async provision(
    config: Record<string, unknown>,
    _credentials?: Record<string, unknown>,
  ): Promise<ProvisionResult> {
    // Continuum C3 (PR-2): CreateKnowledgeBase runs on the platform path —
    // no scoped role exists yet (it is minted connect-only AFTER provision
    // completes), so the datastore-resolver Lambda's own ambient
    // credentials are used instead of a vended tenant role.
    const client = this.platformBedrockProvisionClient();
    const name =
      (config.name as string | undefined) ??
      (config.resourceName as string | undefined) ??
      `citadel-kb-${Date.now()}`;

    // C1: dataStoreId + orgId are REQUIRED. Fail closed rather than falling
    // back to display-name-derived naming — the display name is mutable
    // and tenant-controlled, so deriving a shared AWS resource name from it
    // is the root cause of the cross-org collision this PR fixes.
    const dataStoreId = config.dataStoreId as string | undefined;
    const orgId = config.orgId as string | undefined;
    if (!dataStoreId || !orgId) {
      throw new ProvisioningError(
        "knowledge base provisioning requires dataStoreId and orgId",
      );
    }

    const { region, accountId } = await this.getAccountContext();

    // Determine embedding model ARN
    const embeddingModelArn =
      (config.embeddingModelArn as string | undefined) ??
      `arn:aws:bedrock:${region}::foundation-model/${DEFAULT_EMBEDDING_MODEL}`;

    // Resolve or provision the vector store
    let collectionArn: string;
    let storageConfiguration: StorageConfiguration;

    if (config.storageConfiguration) {
      // Caller provided explicit storage config — use as-is
      storageConfiguration =
        config.storageConfiguration as StorageConfiguration;
      collectionArn =
        (config.storageConfiguration as StorageConfiguration | undefined)
          ?.opensearchServerlessConfiguration?.collectionArn ?? "*";
    } else if (config.collectionArn) {
      // Caller provided a real collection ARN
      collectionArn = config.collectionArn as string;
      storageConfiguration = {
        type: "OPENSEARCH_SERVERLESS",
        opensearchServerlessConfiguration: {
          collectionArn,
          vectorIndexName:
            (config.vectorIndexName as string | undefined) ?? VECTOR_INDEX_NAME,
          fieldMapping: {
            vectorField:
              (config.vectorField as string | undefined) ?? VECTOR_FIELD,
            textField: (config.textField as string | undefined) ?? TEXT_FIELD,
            metadataField:
              (config.metadataField as string | undefined) ?? METADATA_FIELD,
          },
        },
      };
    } else {
      // No storage provided — provision a new AOSS VECTORSEARCH collection.
      // We need the service role ARN first for the data access policy, but
      // we also need the collection ARN for the role policy. Solve this by
      // creating the role first with a wildcard, then updating after.
      const tempCollectionArn = `arn:aws:aoss:${region}:${accountId}:collection/*`;

      let roleArn = config.roleArn as string | undefined;
      if (!roleArn) {
        roleArn = await this.createServiceRole(
          dataStoreId,
          orgId,
          tempCollectionArn,
        );
        await new Promise((resolve) =>
          setTimeout(resolve, this.roleCreationDelayMs),
        );
      }

      const vectorStore = await this.provisionVectorStore(
        dataStoreId,
        orgId,
        roleArn,
        accountId,
        `arn:aws:iam::${accountId}:role/citadel-ds-${dataStoreId}`,
      );
      collectionArn = vectorStore.collectionArn;

      // CIT-299: record collectionId into config so subsequent connect
      // operations can scope policies to this specific collection.
      config.collectionId = vectorStore.collectionId;
      // C1: record resolved identifiers for the migration script / preflight.
      config.serviceRoleArn = roleArn;
      config.serviceRoleName = this.deriveServiceRoleName(dataStoreId);
      config.collectionName = this.deriveCollectionName(orgId, dataStoreId);
      config.collectionArn = collectionArn;

      storageConfiguration = {
        type: "OPENSEARCH_SERVERLESS",
        opensearchServerlessConfiguration: {
          collectionArn,
          vectorIndexName: VECTOR_INDEX_NAME,
          fieldMapping: {
            vectorField: VECTOR_FIELD,
            textField: TEXT_FIELD,
            metadataField: METADATA_FIELD,
          },
        },
      };

      // Now create the KB with the real storage
      try {
        const result = await client.send(
          new CreateKnowledgeBaseCommand({
            name,
            roleArn,
            knowledgeBaseConfiguration: (config.knowledgeBaseConfiguration as
              KnowledgeBaseConfiguration | undefined) ?? {
              type: "VECTOR",
              vectorKnowledgeBaseConfiguration: { embeddingModelArn },
            },
            storageConfiguration,
            tags: {
              "citadel:orgId": orgId,
              "citadel:dataStoreId": dataStoreId,
              ManagedBy: "citadel",
            },
          }),
        );

        // CIT-299: record knowledgeBaseId so connect can scope policies.
        if (result.knowledgeBase?.knowledgeBaseId) {
          config.knowledgeBaseId = result.knowledgeBase.knowledgeBaseId;
        }

        return {
          resourceArn:
            result.knowledgeBase?.knowledgeBaseArn ??
            `arn:aws:bedrock:${region}:${accountId}:knowledge-base/${result.knowledgeBase?.knowledgeBaseId ?? name}`,
        };
      } catch (error) {
        const err = error as SdkError;
        if (err.name === "ConflictException") {
          return await this.resolveConflictingKnowledgeBase(
            client,
            config,
            name,
            dataStoreId,
            orgId,
          );
        }
        if (
          err.name === "AccessDenied" ||
          err.name === "AccessDeniedException"
        ) {
          throw new PermissionError(
            `Permission denied creating Bedrock knowledge base ${name}`,
            err,
          );
        }
        throw new ProvisioningError(
          `Failed to create Bedrock knowledge base ${name}: ${err.message}`,
          err,
        );
      }
    }

    // Path for caller-provided storage config or collectionArn
    let roleArn = config.roleArn as string | undefined;
    if (!roleArn) {
      roleArn = await this.createServiceRole(dataStoreId, orgId, collectionArn);
      await new Promise((resolve) =>
        setTimeout(resolve, this.roleCreationDelayMs),
      );
    }

    try {
      const result = await client.send(
        new CreateKnowledgeBaseCommand({
          name,
          roleArn,
          knowledgeBaseConfiguration: (config.knowledgeBaseConfiguration as
            KnowledgeBaseConfiguration | undefined) ?? {
            type: "VECTOR",
            vectorKnowledgeBaseConfiguration: { embeddingModelArn },
          },
          storageConfiguration,
          tags: {
            "citadel:orgId": orgId,
            "citadel:dataStoreId": dataStoreId,
            ManagedBy: "citadel",
          },
        }),
      );

      return {
        resourceArn:
          result.knowledgeBase?.knowledgeBaseArn ??
          `arn:aws:bedrock:${region}:${accountId}:knowledge-base/${result.knowledgeBase?.knowledgeBaseId ?? name}`,
      };
    } catch (error) {
      const err = error as SdkError;
      if (err.name === "ConflictException") {
        return await this.resolveConflictingKnowledgeBase(
          client,
          config,
          name,
          dataStoreId,
          orgId,
        );
      }
      if (err.name === "AccessDenied" || err.name === "AccessDeniedException") {
        throw new PermissionError(
          `Permission denied creating Bedrock knowledge base ${name}`,
          err,
        );
      }
      throw new ProvisioningError(
        `Failed to create Bedrock knowledge base ${name}: ${err.message}`,
        err,
      );
    }
  }

  /**
   * C1: resolve a ConflictException from CreateKnowledgeBaseCommand.
   *
   * Idempotent retry (decision 44a2bfc1 — reuse ONLY on tag match): if
   * `config.knowledgeBaseId` was already recorded by a prior successful
   * provision of THIS data store, look it up and verify its
   * citadel:orgId/citadel:dataStoreId tags match before reusing it.
   *
   * There is no other safe path: the Bedrock Agent API has no "get KB by
   * name" call, and ConflictException does not return the existing KB's
   * id/arn, so without a previously-recorded id there is nothing to
   * tag-verify against — fail closed rather than guess.
   */
  private async resolveConflictingKnowledgeBase(
    client: BedrockAgentClient,
    config: Record<string, unknown>,
    name: string,
    dataStoreId: string,
    orgId: string,
  ): Promise<ProvisionResult> {
    const existingKnowledgeBaseId = config.knowledgeBaseId as
      string | undefined;
    if (existingKnowledgeBaseId) {
      try {
        const getResult = await client.send(
          new GetKnowledgeBaseCommand({
            knowledgeBaseId: existingKnowledgeBaseId,
          }),
        );
        const kbArn = getResult.knowledgeBase?.knowledgeBaseArn;
        if (kbArn) {
          const tagResult = await client.send(
            new BedrockListTagsForResourceCommand({ resourceArn: kbArn }),
          );
          const tags = tagResult.tags ?? {};
          if (
            tags["citadel:orgId"] === orgId &&
            tags["citadel:dataStoreId"] === dataStoreId
          ) {
            return { resourceArn: kbArn };
          }
        }
      } catch {
        // fall through to the fail-closed throw below
      }
    }

    console.warn("Knowledge base ownership conflict on create", {
      name,
      dataStoreId,
      orgId,
    });
    this.emitKnowledgeBaseOwnershipRefused();
    throw new ProvisioningError("Knowledge base ownership verification failed");
  }

  /**
   * C2: preflight ownership check run BEFORE any IAM role is vended. Uses
   * PLATFORM clients (ambient Lambda execution-role credentials), never
   * scoped credentials — this must be able to run before a scoped role
   * exists.
   *
   * - CREATE_NEW with no caller-supplied target (no knowledgeBaseId,
   *   collectionId, collectionArn, or storageConfiguration): a no-op — the
   *   resource doesn't exist yet, so there is nothing to verify.
   * - CREATE_NEW with a caller-injected target: the caller is asking to
   *   reuse an existing resource, which is exactly the foreign-ARN
   *   injection vector this check closes — verify ownership.
   * - CONNECT_EXISTING: knowledgeBaseId + collectionId are REQUIRED and
   *   must both carry matching citadel:orgId + citadel:dataStoreId tags.
   */
  async preflight(
    config: Record<string, unknown>,
    ctx: { dataStoreId: string; orgId: string; provisionMode?: string },
  ): Promise<void> {
    const knowledgeBaseId = config.knowledgeBaseId as string | undefined;
    const collectionId = config.collectionId as string | undefined;

    if (ctx.provisionMode === "CREATE_NEW") {
      const hasInjectedTarget =
        !!knowledgeBaseId ||
        !!collectionId ||
        !!config.collectionArn ||
        !!config.storageConfiguration;
      if (!hasInjectedTarget) return;
      await this.verifyKbOwnership(knowledgeBaseId, collectionId, ctx);
    } else {
      if (!knowledgeBaseId || !collectionId) {
        throw new ConnectionError(
          "Knowledge base connection requires knowledgeBaseId and collectionId",
          false,
        );
      }
      await this.verifyKbOwnership(knowledgeBaseId, collectionId, ctx);
    }
  }

  /**
   * C2: verify that the KB AND collection both carry citadel:orgId +
   * citadel:dataStoreId tags matching ctx. Fail closed (opaque
   * ProvisioningError, no leaked details) on any mismatch, absence, or SDK
   * error. Uses platform clients only.
   */
  private async verifyKbOwnership(
    knowledgeBaseId: string | undefined,
    collectionId: string | undefined,
    ctx: { dataStoreId: string; orgId: string },
  ): Promise<void> {
    if (!knowledgeBaseId || !collectionId) {
      this.emitKnowledgeBaseOwnershipRefused();
      throw new ProvisioningError(
        "Knowledge base ownership verification failed",
      );
    }

    try {
      const bedrockClient = this.platformBedrockClient();
      const kbResult = await bedrockClient.send(
        new GetKnowledgeBaseCommand({ knowledgeBaseId }),
      );
      const kbArn = kbResult.knowledgeBase?.knowledgeBaseArn;
      if (!kbArn) {
        throw new ProvisioningError(
          "Knowledge base ownership verification failed",
        );
      }
      const kbTagResult = await bedrockClient.send(
        new BedrockListTagsForResourceCommand({ resourceArn: kbArn }),
      );
      const kbTags = kbTagResult.tags ?? {};
      const kbOwnershipOk =
        kbTags["citadel:orgId"] === ctx.orgId &&
        kbTags["citadel:dataStoreId"] === ctx.dataStoreId;

      const ossClient = this.platformOssClient();
      const collResult = await ossClient.send(
        new BatchGetCollectionCommand({ ids: [collectionId] }),
      );
      const collArn = collResult.collectionDetails?.[0]?.arn;
      if (!collArn) {
        throw new ProvisioningError(
          "Knowledge base ownership verification failed",
        );
      }
      const collTagResult = await ossClient.send(
        new OssListTagsForResourceCommand({ resourceArn: collArn }),
      );
      const collTags = collTagResult.tags ?? [];
      const collOwnershipOk =
        collTags.some(
          (t) => t.key === "citadel:orgId" && t.value === ctx.orgId,
        ) &&
        collTags.some(
          (t) => t.key === "citadel:dataStoreId" && t.value === ctx.dataStoreId,
        );

      if (!kbOwnershipOk || !collOwnershipOk) {
        console.warn("KB/collection ownership tag mismatch", {
          knowledgeBaseId,
          collectionId,
          expectedDataStoreId: ctx.dataStoreId,
          expectedOrgId: ctx.orgId,
        });
        this.emitKnowledgeBaseOwnershipRefused();
        throw new ProvisioningError(
          "Knowledge base ownership verification failed",
        );
      }
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      this.emitKnowledgeBaseOwnershipRefused();
      throw new ProvisioningError(
        "Knowledge base ownership verification failed",
      );
    }
  }

  async connect(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>,
  ): Promise<void> {
    const knowledgeBaseId = config.knowledgeBaseId as string | undefined;
    const collectionId = config.collectionId as string | undefined;

    // CIT-299: both IDs are required at connect time. Absent → opaque error,
    // no wildcard fallback, no role grant (requiredPolicies already returned
    // empty when these are missing).
    if (!knowledgeBaseId || !collectionId) {
      throw new ConnectionError(
        "Knowledge base connection requires both knowledgeBaseId and collectionId in config",
        false,
      );
    }

    const client = this.makeClient(credentials, "connect");

    try {
      const response = await client.send(
        new GetKnowledgeBaseCommand({ knowledgeBaseId }),
      );
      if (response.knowledgeBase?.status !== "ACTIVE") {
        throw new ConnectionError(
          `Bedrock knowledge base ${knowledgeBaseId} is not ready (status: ${response.knowledgeBase?.status})`,
          true,
        );
      }
    } catch (error) {
      const err = error as SdkError;
      if (err instanceof ConnectionError) throw err;
      if (err.name === "ResourceNotFoundException") {
        throw new ResourceNotFoundError(
          `Bedrock knowledge base ${knowledgeBaseId} does not exist`,
          err,
        );
      }
      if (err.name === "AccessDenied" || err.name === "AccessDeniedException") {
        throw new PermissionError(
          `Permission denied accessing Bedrock knowledge base ${knowledgeBaseId}`,
          err,
        );
      }
      throw new ConnectionError(
        `Failed to connect to Bedrock knowledge base ${knowledgeBaseId}: ${err.message}`,
        true,
        err,
      );
    }
  }

  async disconnect(
    _config: Record<string, unknown>,
    _credentials?: Record<string, unknown>,
  ): Promise<void> {}

  async deprovision(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>,
  ): Promise<void> {
    const client = this.makeClient(credentials, "deprovision");
    const knowledgeBaseId = config.knowledgeBaseId as string | undefined;

    try {
      await client.send(new DeleteKnowledgeBaseCommand({ knowledgeBaseId }));
    } catch (error) {
      const err = error as SdkError;
      if (err.name === "ResourceNotFoundException") {
        // Already gone — continue to clean up
      } else if (
        err.name === "AccessDenied" ||
        err.name === "AccessDeniedException"
      ) {
        throw new PermissionError(
          `Permission denied deleting Bedrock knowledge base ${knowledgeBaseId}`,
          err,
        );
      } else {
        throw err;
      }
    }

    // Clean up AOSS collection if one was provisioned
    if (config.collectionId) {
      try {
        const ossClient = this.platformOssClient();
        await ossClient.send(
          new DeleteCollectionCommand({ id: config.collectionId as string }),
        );
      } catch (error) {
        const err = error as SdkError;
        if (err.name !== "ResourceNotFoundException") {
          console.warn(`Failed to delete AOSS collection: ${err.message}`);
        }
      }
    }

    // Clean up the service role if one was created during provisioning
    if (config.serviceRoleName) {
      await this.deleteServiceRole(config.serviceRoleName as string);
    }
  }

  async testConnection(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>,
  ): Promise<ConnectionTestResult> {
    const client = this.makeClient(credentials, "testConnection");
    const knowledgeBaseId = config.knowledgeBaseId as string | undefined;
    try {
      const response = await client.send(
        new GetKnowledgeBaseCommand({ knowledgeBaseId }),
      );
      return {
        success: true,
        message: `Successfully connected to Bedrock knowledge base ${knowledgeBaseId}`,
        details: {
          status: response.knowledgeBase?.status,
          arn: response.knowledgeBase?.knowledgeBaseArn,
          description: response.knowledgeBase?.description,
        },
      };
    } catch (error) {
      const err = error as SdkError;
      return {
        success: false,
        message: `Failed to connect to Bedrock knowledge base ${knowledgeBaseId}: ${err.message}`,
        details: { errorName: err.name },
      };
    }
  }

  async getMetrics(
    config: Record<string, unknown>,
    _resourceArn?: string,
    credentials?: Record<string, unknown>,
  ): Promise<MetricsResult> {
    const client = this.makeClient(credentials, "getMetrics");
    const knowledgeBaseId = config.knowledgeBaseId as string | undefined;
    try {
      await client.send(new GetKnowledgeBaseCommand({ knowledgeBaseId }));
      return { size: "0 MB", records: 0 };
    } catch (error) {
      const err = error as SdkError;
      if (err.name === "AccessDenied" || err.name === "AccessDeniedException") {
        throw new PermissionError(
          `Permission denied describing Bedrock knowledge base ${knowledgeBaseId}`,
          err,
        );
      }
      throw new ConnectionError(
        `Failed to get metrics for Bedrock knowledge base ${knowledgeBaseId}: ${err.message}`,
        true,
        err,
      );
    }
  }
}
