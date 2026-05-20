import {
  BedrockAgentClient,
  CreateKnowledgeBaseCommand,
  GetKnowledgeBaseCommand,
  DeleteKnowledgeBaseCommand,
} from '@aws-sdk/client-bedrock-agent';
import {
  OpenSearchServerlessClient,
  CreateSecurityPolicyCommand,
  CreateAccessPolicyCommand,
  CreateCollectionCommand,
  DeleteCollectionCommand,
  BatchGetCollectionCommand,
} from '@aws-sdk/client-opensearchserverless';
import {
  IAMClient,
  CreateRoleCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  DeleteRoleCommand,
} from '@aws-sdk/client-iam';
import {
  STSClient,
  GetCallerIdentityCommand,
} from '@aws-sdk/client-sts';
import { ConnectorAdapter, ConnectorCategory, ConnectorSpec, AuthenticationMethod, RequiredPolicies, ProvisionResult, ConnectionTestResult, MetricsResult } from '../../adapters/base';
import { ProvisioningError, ConnectionError, PermissionError, ResourceNotFoundError } from './errors';

const DEFAULT_EMBEDDING_MODEL = 'amazon.titan-embed-text-v2:0';
const SERVICE_ROLE_POLICY_NAME = 'BedrockKnowledgeBaseAccess';
const VECTOR_INDEX_NAME = 'bedrock-knowledge-base-default-index';
const VECTOR_FIELD = 'bedrock-knowledge-base-default-vector';
const TEXT_FIELD = 'AMAZON_BEDROCK_TEXT_CHUNK';
const METADATA_FIELD = 'AMAZON_BEDROCK_METADATA';

export class KnowledgeBaseAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec = { type: 'KNOWLEDGE_BASE', provider: 'Amazon Web Services', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['knowledgeBaseId'], optional: [], ssmParameters: [] } };

  /** Delay (ms) after creating a service role to allow IAM propagation. Override in tests. */
  roleCreationDelayMs = 10000;
  /** Delay (ms) between polls when waiting for AOSS collection to become ACTIVE. */
  collectionPollIntervalMs = 5000;
  /** Maximum time (ms) to wait for AOSS collection to become ACTIVE. */
  collectionMaxWaitMs = 300000;

  private makeClient(creds?: Record<string, any>): BedrockAgentClient {
    if (creds?.accessKeyId && creds?.secretAccessKey && creds?.sessionToken) {
      return new BedrockAgentClient({
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        },
      });
    }
    return new BedrockAgentClient({});
  }

  private makeOssClient(): OpenSearchServerlessClient {
    return new OpenSearchServerlessClient({});
  }

  requiredPolicies(
    _config: Record<string, any>,
    _accountId: string,
    _region: string
  ): RequiredPolicies {
    const knowledgeBaseArn = `arn:aws:bedrock:${_region}:${_accountId}:knowledge-base/*`;
    return {
      provision: [],
      connect: [
        {
          actions: ['bedrock:GetKnowledgeBase', 'bedrock:Retrieve'],
          resources: [knowledgeBaseArn],
        },
      ],
    };
  }

  /**
   * Get the AWS account ID and region from STS.
   */
  private async getAccountContext(): Promise<{ accountId: string; region: string }> {
    const stsClient = new STSClient({});
    const identity = await stsClient.send(new GetCallerIdentityCommand({}));
    const accountId = identity.Account!;
    const region = (await stsClient.config.region()) as string;
    return { accountId, region: typeof region === 'string' ? region : 'us-east-1' };
  }

  /**
   * Create a Bedrock service role that Bedrock can assume to access resources,
   * including permissions for OpenSearch Serverless API access.
   */
  private async createServiceRole(name: string, collectionArn: string): Promise<string> {
    const iamClient = new IAMClient({});
    const { accountId } = await this.getAccountContext();
    const roleName = `citadel-ds-kb-svc-${name.replace(/[^a-zA-Z0-9-]/g, '-').substring(0, 30)}`;

    const trustPolicy = {
      Version: '2012-10-17',
      Statement: [{
        Effect: 'Allow',
        Principal: { Service: 'bedrock.amazonaws.com' },
        Action: 'sts:AssumeRole',
      }],
    };

    try {
      await iamClient.send(new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
        Tags: [
          { Key: 'ManagedBy', Value: 'citadel' },
          { Key: 'Purpose', Value: 'bedrock-knowledge-base-service-role' },
        ],
      }));
    } catch (error: any) {
      if (error.name !== 'EntityAlreadyExistsException') {
        throw new ProvisioningError(`Failed to create Bedrock service role: ${error.message}`, error);
      }
    }

    // Policy granting Bedrock access to foundation models AND OpenSearch Serverless
    const policyDocument = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
          Resource: ['*'],
        },
        {
          Effect: 'Allow',
          Action: ['aoss:APIAccessAll'],
          Resource: [collectionArn],
        },
      ],
    };

    try {
      await iamClient.send(new PutRolePolicyCommand({
        RoleName: roleName,
        PolicyName: SERVICE_ROLE_POLICY_NAME,
        PolicyDocument: JSON.stringify(policyDocument),
      }));
    } catch (error: any) {
      throw new ProvisioningError(`Failed to attach policy to Bedrock service role: ${error.message}`, error);
    }

    return `arn:aws:iam::${accountId}:role/${roleName}`;
  }

  /**
   * Delete a Bedrock service role created during provisioning.
   */
  private async deleteServiceRole(roleName: string): Promise<void> {
    const iamClient = new IAMClient({});
    try {
      await iamClient.send(new DeleteRolePolicyCommand({
        RoleName: roleName,
        PolicyName: SERVICE_ROLE_POLICY_NAME,
      }));
    } catch (error: any) {
      if (error.name !== 'NoSuchEntityException') {
        console.warn(`Failed to delete service role policy: ${error.message}`);
      }
    }
    try {
      await iamClient.send(new DeleteRoleCommand({ RoleName: roleName }));
    } catch (error: any) {
      if (error.name !== 'NoSuchEntityException') {
        console.warn(`Failed to delete service role: ${error.message}`);
      }
    }
  }

  /**
   * Provision an OpenSearch Serverless VECTORSEARCH collection with the
   * required encryption, network, and data access policies.
   */
  private async provisionVectorStore(
    name: string,
    serviceRoleArn: string,
    accountId: string,
  ): Promise<{ collectionArn: string; collectionId: string }> {
    const ossClient = this.makeOssClient();
    const collectionName = `aifkb-${name.replace(/[^a-z0-9-]/gi, '-').substring(0, 25).toLowerCase()}`;
    const policyName = `aifkb-${collectionName}`;

    // 1. Create encryption policy (required before collection creation)
    try {
      await ossClient.send(new CreateSecurityPolicyCommand({
        name: policyName,
        type: 'encryption',
        description: `Encryption policy for KB collection ${collectionName}`,
        policy: JSON.stringify({
          Rules: [{ ResourceType: 'collection', Resource: [`collection/${collectionName}`] }],
          AWSOwnedKey: true,
        }),
      }));
    } catch (error: any) {
      if (error.name !== 'ConflictException') {
        throw new ProvisioningError(`Failed to create encryption policy: ${error.message}`, error);
      }
    }

    // 2. Create network policy (public access for Bedrock)
    try {
      await ossClient.send(new CreateSecurityPolicyCommand({
        name: policyName,
        type: 'network',
        description: `Network policy for KB collection ${collectionName}`,
        policy: JSON.stringify([{
          Description: `Public access for ${collectionName}`,
          Rules: [
            { ResourceType: 'dashboard', Resource: [`collection/${collectionName}`] },
            { ResourceType: 'collection', Resource: [`collection/${collectionName}`] },
          ],
          AllowFromPublic: true,
        }]),
      }));
    } catch (error: any) {
      if (error.name !== 'ConflictException') {
        throw new ProvisioningError(`Failed to create network policy: ${error.message}`, error);
      }
    }

    // 3. Create data access policy granting the Bedrock service role access
    try {
      await ossClient.send(new CreateAccessPolicyCommand({
        name: policyName,
        type: 'data',
        description: `Data access policy for KB collection ${collectionName}`,
        policy: JSON.stringify([{
          Rules: [
            {
              Resource: [`index/${collectionName}/*`],
              Permission: [
                'aoss:CreateIndex', 'aoss:DeleteIndex', 'aoss:UpdateIndex',
                'aoss:DescribeIndex', 'aoss:ReadDocument', 'aoss:WriteDocument',
              ],
              ResourceType: 'index',
            },
            {
              Resource: [`collection/${collectionName}`],
              Permission: ['aoss:CreateCollectionItems', 'aoss:DescribeCollectionItems', 'aoss:UpdateCollectionItems'],
              ResourceType: 'collection',
            },
          ],
          Principal: [serviceRoleArn, `arn:aws:iam::${accountId}:root`],
        }]),
      }));
    } catch (error: any) {
      if (error.name !== 'ConflictException') {
        throw new ProvisioningError(`Failed to create data access policy: ${error.message}`, error);
      }
    }

    // 4. Create the VECTORSEARCH collection
    let collectionId: string | undefined;
    let collectionArn: string | undefined;
    try {
      const result = await ossClient.send(new CreateCollectionCommand({
        name: collectionName,
        type: 'VECTORSEARCH',
        description: `Vector store for Bedrock Knowledge Base: ${name}`,
      }));
      collectionId = result.createCollectionDetail?.id;
      collectionArn = result.createCollectionDetail?.arn;
    } catch (error: any) {
      if (error.name === 'ConflictException') {
        // Collection already exists — look it up
        const existing = await ossClient.send(new BatchGetCollectionCommand({ names: [collectionName] }));
        const detail = existing.collectionDetails?.[0];
        collectionId = detail?.id;
        collectionArn = detail?.arn;
      } else {
        throw new ProvisioningError(`Failed to create AOSS collection: ${error.message}`, error);
      }
    }

    if (!collectionArn || !collectionId) {
      throw new ProvisioningError(`AOSS collection created but ARN/ID not returned for ${collectionName}`);
    }

    // 5. Wait for collection to become ACTIVE
    let collectionEndpoint: string | undefined;
    const startTime = Date.now();
    while (Date.now() - startTime < this.collectionMaxWaitMs) {
      const status = await ossClient.send(new BatchGetCollectionCommand({ ids: [collectionId] }));
      const detail = status.collectionDetails?.[0];
      if (detail?.status === 'ACTIVE') {
        collectionEndpoint = detail.collectionEndpoint;
        break;
      }
      if (detail?.status === 'FAILED') {
        throw new ProvisioningError(`AOSS collection ${collectionName} failed to create`);
      }
      await new Promise((resolve) => setTimeout(resolve, this.collectionPollIntervalMs));
    }

    if (!collectionEndpoint) {
      throw new ProvisioningError(`Timed out waiting for AOSS collection ${collectionName} to become ACTIVE`);
    }

    // 6. Create the vector index inside the collection.
    // Wait briefly for data access policies to propagate before creating the index.
    await new Promise((resolve) => setTimeout(resolve, this.roleCreationDelayMs));
    await this.createVectorIndex(collectionEndpoint, VECTOR_INDEX_NAME, VECTOR_FIELD);

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
    const { SignatureV4 } = await import('@aws-sdk/signature-v4');
    const { Sha256 } = await import('@aws-crypto/sha256-js');
    const { HttpRequest } = await import('@smithy/protocol-http');
    const { defaultProvider } = await import('@aws-sdk/credential-provider-node');
    const { region } = await this.getAccountContext();
    const https = await import('https');

    const host = endpoint.replace('https://', '');
    const body = JSON.stringify({
      settings: {
        'index.knn': true,
      },
      mappings: {
        properties: {
          [vectorField]: {
            type: 'knn_vector',
            dimension: 1024,
            method: { engine: 'faiss', name: 'hnsw', space_type: 'l2' },
          },
          [TEXT_FIELD]: { type: 'text' },
          [METADATA_FIELD]: { type: 'text' },
        },
      },
    });

    const request = new HttpRequest({
      method: 'PUT',
      protocol: 'https:',
      hostname: host,
      path: `/${indexName}`,
      headers: {
        'Content-Type': 'application/json',
        host,
      },
      body,
    });

    const signer = new SignatureV4({
      service: 'aoss',
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
          method: 'PUT',
          headers: signed.headers,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: any) => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode === 200 || res.statusCode === 201) {
              resolve();
            } else if (res.statusCode === 400 && data.includes('already_exists')) {
              resolve(); // Index already exists
            } else {
              reject(new ProvisioningError(
                `Failed to create vector index: HTTP ${res.statusCode} - ${data}`
              ));
            }
          });
        },
      );
      req.on('error', (err: any) => reject(new ProvisioningError(`Failed to create vector index: ${err.message}`, err)));
      req.write(body);
      req.end();
    });
  }

  async provision(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<ProvisionResult> {
    const client = this.makeClient(credentials);
    const name = config.name ?? config.resourceName ?? `citadel-kb-${Date.now()}`;
    const { region, accountId } = await this.getAccountContext();

    // Determine embedding model ARN
    const embeddingModelArn = config.embeddingModelArn ??
      `arn:aws:bedrock:${region}::foundation-model/${DEFAULT_EMBEDDING_MODEL}`;

    // Resolve or provision the vector store
    let collectionArn: string;
    let storageConfiguration: any;

    if (config.storageConfiguration) {
      // Caller provided explicit storage config — use as-is
      storageConfiguration = config.storageConfiguration;
      collectionArn = config.storageConfiguration?.opensearchServerlessConfiguration?.collectionArn ?? '*';
    } else if (config.collectionArn) {
      // Caller provided a real collection ARN
      collectionArn = config.collectionArn;
      storageConfiguration = {
        type: 'OPENSEARCH_SERVERLESS',
        opensearchServerlessConfiguration: {
          collectionArn,
          vectorIndexName: config.vectorIndexName ?? VECTOR_INDEX_NAME,
          fieldMapping: {
            vectorField: config.vectorField ?? VECTOR_FIELD,
            textField: config.textField ?? TEXT_FIELD,
            metadataField: config.metadataField ?? METADATA_FIELD,
          },
        },
      };
    } else {
      // No storage provided — provision a new AOSS VECTORSEARCH collection.
      // We need the service role ARN first for the data access policy, but
      // we also need the collection ARN for the role policy. Solve this by
      // creating the role first with a wildcard, then updating after.
      const tempCollectionArn = `arn:aws:aoss:${region}:${accountId}:collection/*`;

      let roleArn = config.roleArn;
      let serviceRoleName: string | undefined;
      if (!roleArn) {
        roleArn = await this.createServiceRole(name, tempCollectionArn);
        serviceRoleName = roleArn.split('/').pop();
        await new Promise((resolve) => setTimeout(resolve, this.roleCreationDelayMs));
      }

      const vectorStore = await this.provisionVectorStore(name, roleArn, accountId);
      collectionArn = vectorStore.collectionArn;

      storageConfiguration = {
        type: 'OPENSEARCH_SERVERLESS',
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
            knowledgeBaseConfiguration: config.knowledgeBaseConfiguration ?? {
              type: 'VECTOR',
              vectorKnowledgeBaseConfiguration: { embeddingModelArn },
            },
            storageConfiguration,
          })
        );

        return {
          resourceArn: result.knowledgeBase?.knowledgeBaseArn ??
            `arn:aws:bedrock:${region}:${accountId}:knowledge-base/${result.knowledgeBase?.knowledgeBaseId ?? name}`,
        };
      } catch (error: any) {
        if (error.name === 'ConflictException') {
          return { resourceArn: `arn:aws:bedrock:${region}:${accountId}:knowledge-base/${name}` };
        }
        if (error.name === 'AccessDenied' || error.name === 'AccessDeniedException') {
          throw new PermissionError(`Permission denied creating Bedrock knowledge base ${name}`, error);
        }
        throw new ProvisioningError(`Failed to create Bedrock knowledge base ${name}: ${error.message}`, error);
      }
    }

    // Path for caller-provided storage config or collectionArn
    let roleArn = config.roleArn;
    let serviceRoleName: string | undefined;
    if (!roleArn) {
      roleArn = await this.createServiceRole(name, collectionArn);
      serviceRoleName = roleArn.split('/').pop();
      await new Promise((resolve) => setTimeout(resolve, this.roleCreationDelayMs));
    }

    try {
      const result = await client.send(
        new CreateKnowledgeBaseCommand({
          name,
          roleArn,
          knowledgeBaseConfiguration: config.knowledgeBaseConfiguration ?? {
            type: 'VECTOR',
            vectorKnowledgeBaseConfiguration: { embeddingModelArn },
          },
          storageConfiguration,
        })
      );

      return {
        resourceArn: result.knowledgeBase?.knowledgeBaseArn ??
          `arn:aws:bedrock:${region}:${accountId}:knowledge-base/${result.knowledgeBase?.knowledgeBaseId ?? name}`,
      };
    } catch (error: any) {
      if (error.name === 'ConflictException') {
        return { resourceArn: `arn:aws:bedrock:${region}:${accountId}:knowledge-base/${name}` };
      }
      if (error.name === 'AccessDenied' || error.name === 'AccessDeniedException') {
        throw new PermissionError(`Permission denied creating Bedrock knowledge base ${name}`, error);
      }
      throw new ProvisioningError(`Failed to create Bedrock knowledge base ${name}: ${error.message}`, error);
    }
  }

  async connect(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const knowledgeBaseId = config.knowledgeBaseId;

    try {
      const response = await client.send(
        new GetKnowledgeBaseCommand({ knowledgeBaseId })
      );
      if (response.knowledgeBase?.status !== 'ACTIVE') {
        throw new ConnectionError(
          `Bedrock knowledge base ${knowledgeBaseId} is not ready (status: ${response.knowledgeBase?.status})`,
          true
        );
      }
    } catch (error: any) {
      if (error instanceof ConnectionError) throw error;
      if (error.name === 'ResourceNotFoundException') {
        throw new ResourceNotFoundError(
          `Bedrock knowledge base ${knowledgeBaseId} does not exist`, error
        );
      }
      if (error.name === 'AccessDenied' || error.name === 'AccessDeniedException') {
        throw new PermissionError(
          `Permission denied accessing Bedrock knowledge base ${knowledgeBaseId}`, error
        );
      }
      throw new ConnectionError(
        `Failed to connect to Bedrock knowledge base ${knowledgeBaseId}: ${error.message}`, true, error
      );
    }
  }

  async disconnect(_config: Record<string, any>): Promise<void> {}

  async deprovision(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const knowledgeBaseId = config.knowledgeBaseId;

    try {
      await client.send(new DeleteKnowledgeBaseCommand({ knowledgeBaseId }));
    } catch (error: any) {
      if (error.name === 'ResourceNotFoundException') {
        // Already gone — continue to clean up
      } else if (error.name === 'AccessDenied' || error.name === 'AccessDeniedException') {
        throw new PermissionError(
          `Permission denied deleting Bedrock knowledge base ${knowledgeBaseId}`, error
        );
      } else {
        throw error;
      }
    }

    // Clean up AOSS collection if one was provisioned
    if (config.collectionId) {
      try {
        const ossClient = this.makeOssClient();
        await ossClient.send(new DeleteCollectionCommand({ id: config.collectionId }));
      } catch (error: any) {
        if (error.name !== 'ResourceNotFoundException') {
          console.warn(`Failed to delete AOSS collection: ${error.message}`);
        }
      }
    }

    // Clean up the service role if one was created during provisioning
    if (config.serviceRoleName) {
      await this.deleteServiceRole(config.serviceRoleName);
    }
  }

  async testConnection(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<ConnectionTestResult> {
    const client = this.makeClient(credentials);
    const knowledgeBaseId = config.knowledgeBaseId;
    try {
      const response = await client.send(new GetKnowledgeBaseCommand({ knowledgeBaseId }));
      return {
        success: true,
        message: `Successfully connected to Bedrock knowledge base ${knowledgeBaseId}`,
        details: {
          status: response.knowledgeBase?.status,
          arn: response.knowledgeBase?.knowledgeBaseArn,
          description: response.knowledgeBase?.description,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to connect to Bedrock knowledge base ${knowledgeBaseId}: ${error.message}`,
        details: { errorName: error.name },
      };
    }
  }

  async getMetrics(
    config: Record<string, any>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    const client = this.makeClient();
    const knowledgeBaseId = config.knowledgeBaseId;
    try {
      await client.send(new GetKnowledgeBaseCommand({ knowledgeBaseId }));
      return { size: '0 MB', records: 0 };
    } catch (error: any) {
      if (error.name === 'AccessDenied' || error.name === 'AccessDeniedException') {
        throw new PermissionError(
          `Permission denied describing Bedrock knowledge base ${knowledgeBaseId}`, error
        );
      }
      throw new ConnectionError(
        `Failed to get metrics for Bedrock knowledge base ${knowledgeBaseId}: ${error.message}`, true, error
      );
    }
  }
}
