/**
 * Gateway Registration Handler (P3.A)
 *
 * Single async sink for AgentCore Gateway target lifecycle. Consumes
 * EventBridge events emitted by `integration-resolver.ts` and performs the
 * `CreateGatewayTargetCommand` / `DeleteGatewayTargetCommand` work that used
 * to live in the resolver. This unifies what was previously two divergent
 * paths (CONFLUENCE async via this handler, AGENTCORE_TYPES sync inside the
 * resolver).
 *
 * Detail-types:
 *   - `integration.connect.requested`   → handleConnect    (dispatch by type)
 *   - `integration.disconnect.requested`→ handleDisconnect (full teardown
 *     unless `detail.keepResources === true`, in which case only the target
 *     is removed — used by AppSync `disconnectIntegration`)
 *
 * Strict deletion order (deleteIntegration): target → provider → secret →
 * SSM → DDB row. Failure of an earlier step aborts later steps; a
 * partially-complete teardown can be retried by re-emitting the event.
 *
 * TODO: verify against MCP 2025-11-25 spec — confirm
 * `CreateGatewayTargetCommand` 3LO response carries `status` and
 * `authorizationData.oauth2.authorizationUrl` once Phase 3 ships.
 */

import { EventBridgeEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  DeleteCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  BedrockAgentCoreControlClient,
  CreateGatewayTargetCommand,
  type CreateGatewayTargetCommandInput,
  DeleteGatewayTargetCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import {
  SSMClient,
  GetParameterCommand,
  DeleteParameterCommand,
} from '@aws-sdk/client-ssm';
import {
  SecretsManagerClient,
  DeleteSecretCommand,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { IdempotencyGuard } from '../utils/idempotency';
import { getConnectorSpec } from '../utils/connector-registry';
import {
  buildLambdaTargetPayload,
  buildSmithyTargetPayload,
  buildMCPServerTargetPayload,
  deprovisionCredentialProvider,
} from '../utils/gateway-target-manager';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const bedrockAgentCore = new BedrockAgentCoreControlClient({});
const ssm = new SSMClient({});
const secretsManager = new SecretsManagerClient({});
const idempotencyGuard = new IdempotencyGuard(process.env.IDEMPOTENCY_TABLE!);

const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';
const REGION = process.env.AWS_REGION || 'us-west-2';
const ACCOUNT_ID = process.env.ACCOUNT_ID || '';
const INTEGRATIONS_TABLE = process.env.INTEGRATIONS_TABLE || '';
const GATEWAY_ID_PARAM = process.env.GATEWAY_ID_PARAM || '';

let cachedGatewayId: string | undefined;

async function getGatewayId(): Promise<string> {
  if (cachedGatewayId) return cachedGatewayId;
  const resp = await ssm.send(new GetParameterCommand({ Name: GATEWAY_ID_PARAM }));
  cachedGatewayId = resp.Parameter?.Value || '';
  return cachedGatewayId;
}

/**
 * Test-only hook: clear the cached `gatewayIdentifier` between tests so a
 * fresh `process.env.GATEWAY_ID_PARAM` is honoured. Production code must
 * not call this.
 */
export function __resetGatewayIdCacheForTesting(): void {
  cachedGatewayId = undefined;
}

interface IntegrationEvent {
  integrationId: string;
  integrationType: string;
  orgId: string;
  secretArn?: string;
  ssmParameterPrefix?: string;
  /** P3.A: real AgentCore Identity provider ARN (NOT the Secrets Manager ARN). */
  credentialProviderArn?: string;
  credentialProviderType?: 'API_KEY' | 'OAUTH2';
  /** P3.A: gateway target id, present on disconnect events. */
  gatewayTargetId?: string;
  /**
   * If `true`, only the gateway target is deleted (used by AppSync
   * `disconnectIntegration`). Default `false` performs full teardown:
   * target → provider → secret → SSM → DDB row.
   */
  keepResources?: boolean;
}

export async function handler(event: EventBridgeEvent<string, IntegrationEvent>) {
  console.log('Gateway registration event:', JSON.stringify(event, null, 2));

  const { detail, 'detail-type': detailType } = event;

  // D-03: Use integrationId as idempotency key (not event.id) to handle race conditions
  const idempotencyKey = `${detailType}:${detail.integrationId}`;
  const { executed } = await idempotencyGuard.withIdempotency(idempotencyKey, async () => {
    try {
      if (detailType === 'integration.connect.requested') {
        await handleConnect(detail);
      } else if (detailType === 'integration.disconnect.requested') {
        await handleDisconnect(detail);
      }
    } catch (error: unknown) {
      console.error('Gateway registration error:', error);
      throw error;
    }
  });

  if (!executed) {
    console.log(
      'Skipping duplicate gateway registration event for integration:',
      detail.integrationId,
    );
  }
}

// ────────────────────────────────────────────────────────────────────────
// Connect dispatch
// ────────────────────────────────────────────────────────────────────────

async function handleConnect(detail: IntegrationEvent): Promise<void> {
  console.log('Registering integration with AgentCore:', detail.integrationId);

  switch (detail.integrationType) {
    case 'CONFLUENCE':
      await registerConfluence(detail);
      break;
    case 'AWS_LAMBDA':
      await registerLambda(detail);
      break;
    case 'AWS_SMITHY':
      await registerSmithy(detail);
      break;
    case 'MCP_SERVER':
      await registerMcpServer(detail);
      break;
    default:
      console.warn(`Gateway registration not implemented for ${detail.integrationType}`);
  }
}

/**
 * P3.A gap-9 fix: register CONFLUENCE using the real
 * `credentialProviderArn` persisted on the integration record at create
 * time. The previous implementation passed `detail.secretArn` as
 * `apiKeyCredentialProvider.providerArn`, which AgentCore rejects (it
 * expects an AgentCore Identity provider ARN, not a Secrets Manager ARN).
 */
async function registerConfluence(detail: IntegrationEvent): Promise<void> {
  const integration = await getIntegration(detail.integrationId);
  if (!integration) {
    throw new Error(`Integration not found for connect: ${detail.integrationId}`);
  }

  const credentialProviderArn =
    detail.credentialProviderArn ?? integration.credentialProviderArn;
  if (!credentialProviderArn) {
    const msg =
      'CONFLUENCE registration missing credentialProviderArn; resolver must call ' +
      'provisionCredentialProvider("API_KEY", ...) at create time';
    console.error(msg, { integrationId: detail.integrationId });
    await updateIntegrationStatus(
      detail.integrationId,
      'CONNECTION_FAILED',
      false,
      undefined,
      msg,
    );
    throw new Error(msg);
  }

  // Persisted at deploy time by the schema-publishing pipeline.
  const schemaUri =
    `s3://citadel-schemas-${ENVIRONMENT}-${ACCOUNT_ID}-${REGION}/confluence-openapi.json`;

  try {
    const response = await bedrockAgentCore.send(
      new CreateGatewayTargetCommand({
        gatewayIdentifier: await getGatewayId(),
        name: `confluence-${detail.integrationId}`,
        description: `Confluence integration for ${detail.orgId}`,
        targetConfiguration: {
          mcp: {
            openApiSchema: {
              s3: {
                uri: schemaUri,
                bucketOwnerAccountId: ACCOUNT_ID,
              },
            },
          },
        } as CreateGatewayTargetCommandInput['targetConfiguration'],
        credentialProviderConfigurations: [
          {
            credentialProviderType: 'API_KEY',
            credentialProvider: {
              apiKeyCredentialProvider: {
                providerArn: credentialProviderArn,
                credentialLocation: 'HEADER',
                credentialParameterName: 'Authorization',
                credentialPrefix: 'Basic',
              },
            },
          },
        ] as CreateGatewayTargetCommandInput['credentialProviderConfigurations'],
      }),
    );

    console.log('CONFLUENCE gateway target created:', {
      integrationId: detail.integrationId,
      targetId: response.targetId,
    });
    await updateIntegrationStatus(
      detail.integrationId,
      'CONNECTED',
      true,
      response.targetId,
    );
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'ConflictException') {
      console.log('CONFLUENCE target already exists, reconciling state');
      const existing = await getIntegration(detail.integrationId);
      if (existing?.gatewayTargetId) {
        await updateIntegrationStatus(
          detail.integrationId,
          'CONNECTED',
          true,
          existing.gatewayTargetId,
        );
      } else {
        const msg = 'Gateway target exists but ID not found in DynamoDB';
        console.error(msg, { integrationId: detail.integrationId });
        await updateIntegrationStatus(
          detail.integrationId,
          'CONNECTION_FAILED',
          false,
          undefined,
          msg,
        );
      }
    } else {
      console.error('Failed to create CONFLUENCE gateway target:', error);
      await updateIntegrationStatus(
        detail.integrationId,
        'CONNECTION_FAILED',
        false,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }
}

async function registerLambda(detail: IntegrationEvent): Promise<void> {
  const integration = await getIntegration(detail.integrationId);
  if (!integration) {
    throw new Error(`Integration not found for connect: ${detail.integrationId}`);
  }

  // Lambda + Smithy use GATEWAY_IAM_ROLE — credential provider not required.
  const cmdInput = buildLambdaTargetPayload({
    integrationId: detail.integrationId,
    config: integration.config,
  });

  await sendCreateGatewayTargetAndPersist(detail, cmdInput);
}

async function registerSmithy(detail: IntegrationEvent): Promise<void> {
  const integration = await getIntegration(detail.integrationId);
  if (!integration) {
    throw new Error(`Integration not found for connect: ${detail.integrationId}`);
  }

  const cmdInput = buildSmithyTargetPayload({
    integrationId: detail.integrationId,
    config: integration.config,
  });

  await sendCreateGatewayTargetAndPersist(detail, cmdInput);
}

async function registerMcpServer(detail: IntegrationEvent): Promise<void> {
  const integration = await getIntegration(detail.integrationId);
  if (!integration) {
    throw new Error(`Integration not found for connect: ${detail.integrationId}`);
  }

  const credentialProviderArn =
    detail.credentialProviderArn ?? integration.credentialProviderArn;
  const credentialProviderType =
    (detail.credentialProviderType ?? integration.credentialProviderType) as
      | 'API_KEY'
      | 'OAUTH2'
      | undefined;

  let cmdInput;
  if (credentialProviderType === 'OAUTH2') {
    if (!credentialProviderArn) {
      throw new Error(
        `MCP_SERVER + OAUTH2 missing credentialProviderArn (integration ${detail.integrationId})`,
      );
    }
    // Read OAuth target-level settings from the integration's stored
    // credentials (Secrets Manager). The credential provider ARN is the
    // pre-provisioned one; the gateway target receives scopes / grantType.
    const credentials = await retrieveOauthCredentialsFromSecret(integration.secretArn);
    const grantType = (credentials.grantType ?? 'CLIENT_CREDENTIALS') as NonNullable<
      Parameters<typeof buildMCPServerTargetPayload>[0]['oauthSettings']
    >['grantType'];
    const oauthSettings: NonNullable<
      Parameters<typeof buildMCPServerTargetPayload>[0]['oauthSettings']
    > = {
      scopes: Array.isArray(credentials.scopes) ? [...credentials.scopes] : [],
      grantType,
    };
    const defaultReturnUrl = process.env.OAUTH_DEFAULT_RETURN_URL;
    if (defaultReturnUrl) {
      oauthSettings.defaultReturnUrl = defaultReturnUrl;
    }
    cmdInput = buildMCPServerTargetPayload({
      integrationId: detail.integrationId,
      config: integration.config,
      credentialProviderArn,
      credentialProviderType: 'OAUTH2',
      oauthSettings,
    });
  } else if (credentialProviderType === 'API_KEY') {
    if (!credentialProviderArn) {
      throw new Error(
        `MCP_SERVER + API_KEY missing credentialProviderArn (integration ${detail.integrationId})`,
      );
    }
    cmdInput = buildMCPServerTargetPayload({
      integrationId: detail.integrationId,
      config: integration.config,
      credentialProviderArn,
      credentialProviderType: 'API_KEY',
    });
  } else {
    // CUSTOM auth — no credential provider configurations on the target.
    cmdInput = buildMCPServerTargetPayload({
      integrationId: detail.integrationId,
      config: integration.config,
    });
  }

  await sendCreateGatewayTargetAndPersist(detail, cmdInput);
}

/**
 * Send the CreateGatewayTargetCommand and persist the response on the
 * integration record. Handles `ConflictException` idempotently and 3LO
 * `CREATE_PENDING_AUTH` status / `authorizationUrl` capture.
 */
async function sendCreateGatewayTargetAndPersist(
  detail: IntegrationEvent,
  cmdInput: CreateGatewayTargetCommandInput,
): Promise<void> {
  try {
    const response: {
      targetId?: string;
      status?: string;
      authorizationData?: { oauth2?: { authorizationUrl?: string } };
    } = await bedrockAgentCore.send(
      new CreateGatewayTargetCommand({
        ...cmdInput,
        gatewayIdentifier: cmdInput.gatewayIdentifier ?? (await getGatewayId()),
      }),
    );

    const targetStatus: string | undefined = response?.status;
    const authorizationUrl: string | undefined =
      response?.authorizationData?.oauth2?.authorizationUrl;

    console.log('Gateway target created:', {
      integrationId: detail.integrationId,
      targetId: response.targetId,
      targetStatus: targetStatus || 'READY',
      hasAuthorizationUrl: Boolean(authorizationUrl),
    });

    // 3LO: target is in CREATE_PENDING_AUTH until the user completes the
    // IdP flow. Surface that to DDB so the resolver can return the
    // authorizationUrl on the next connectIntegration call.
    if (targetStatus === 'CREATE_PENDING_AUTH') {
      await updateIntegrationAfterCreate(detail.integrationId, {
        status: 'CONNECTING',
        agentCoreRegistered: false,
        gatewayTargetId: response.targetId,
        targetStatus,
        ...(authorizationUrl ? { authorizationUrl } : {}),
      });
    } else {
      await updateIntegrationAfterCreate(detail.integrationId, {
        status: 'CONNECTED',
        agentCoreRegistered: true,
        gatewayTargetId: response.targetId,
        targetStatus: targetStatus ?? 'READY',
      });
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'ConflictException') {
      console.log('Gateway target already exists, reconciling state');
      const existing = await getIntegration(detail.integrationId);
      if (existing?.gatewayTargetId) {
        await updateIntegrationStatus(
          detail.integrationId,
          'CONNECTED',
          true,
          existing.gatewayTargetId,
        );
      } else {
        const msg = 'Gateway target exists but ID not found in DynamoDB';
        console.error(msg, { integrationId: detail.integrationId });
        await updateIntegrationStatus(
          detail.integrationId,
          'CONNECTION_FAILED',
          false,
          undefined,
          msg,
        );
      }
    } else {
      console.error('Failed to create gateway target:', error);
      await updateIntegrationStatus(
        detail.integrationId,
        'CONNECTION_FAILED',
        false,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Disconnect dispatch
// ────────────────────────────────────────────────────────────────────────

/**
 * P3.A: handle integration teardown (full delete or simple disconnect).
 *
 * Strict ordering for full delete:
 *   1. DeleteGatewayTargetCommand   (RNF treated as success)
 *   2. deprovisionCredentialProvider (RNF already swallowed inside helper)
 *   3. DeleteSecretCommand          (best-effort)
 *   4. DeleteParameterCommand x N   (best-effort)
 *   5. DeleteCommand on DDB row     (best-effort)
 *
 * If step 1 fails with a non-RNF error, the chain is aborted and the error
 * is re-thrown — the credential provider must NOT be deleted while a live
 * target still references it. If step 2 fails, the error is logged and a
 * metric is emitted; ops can retry the delete by re-emitting the event.
 *
 * If `detail.keepResources === true` (used by AppSync
 * `disconnectIntegration`), only steps 1 and the DDB status update run.
 */
async function handleDisconnect(detail: IntegrationEvent): Promise<void> {
  console.log('Unregistering integration from AgentCore:', detail.integrationId);

  const integration = await getIntegration(detail.integrationId);
  const targetId = detail.gatewayTargetId ?? integration?.gatewayTargetId;
  const credentialProviderType = (detail.credentialProviderType ??
    integration?.credentialProviderType) as 'API_KEY' | 'OAUTH2' | undefined;

  // 1. Delete the gateway target FIRST.
  if (targetId) {
    try {
      await bedrockAgentCore.send(
        new DeleteGatewayTargetCommand({
          gatewayIdentifier: await getGatewayId(),
          targetId,
        }),
      );
      console.log('Gateway target deleted:', { integrationId: detail.integrationId, targetId });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'ResourceNotFoundException') {
        console.info('Gateway target already absent — idempotent delete', {
          integrationId: detail.integrationId,
          targetId,
        });
      } else {
        console.error('Failed to delete gateway target — aborting cleanup', {
          integrationId: detail.integrationId,
          targetId,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
  }

  if (detail.keepResources) {
    // Disconnect-only: target removed, integration record stays.
    console.log('Disconnect (keepResources=true) complete:', detail.integrationId);
    return;
  }

  // 2. Deprovision the AgentCore Identity credential provider.
  const integrationProviderArn =
    detail.credentialProviderArn ?? integration?.credentialProviderArn;
  if (integrationProviderArn && credentialProviderType) {
    try {
      await deprovisionCredentialProvider(detail.integrationId, credentialProviderType);
      console.log('Credential provider deprovisioned:', {
        integrationId: detail.integrationId,
        credentialProviderType,
      });
    } catch (error: unknown) {
      // Provider delete failure: log + emit metric; do NOT abort, secret
      // and DDB cleanup still need to run so the user isn't stuck with a
      // half-deleted record. Ops can retry provider deletion separately.
      console.error('Failed to deprovision credential provider — continuing teardown', {
        integrationId: detail.integrationId,
        credentialProviderType,
        error: error instanceof Error ? error.message : String(error),
      });
      console.log(
        JSON.stringify({
          metric: 'integration.disconnect.provider_delete_failed',
          integrationId: detail.integrationId,
          credentialProviderType,
        }),
      );
    }
  }

  // 3. Delete Secrets Manager secret (best-effort).
  const secretArn = detail.secretArn ?? integration?.secretArn;
  if (secretArn) {
    try {
      await secretsManager.send(
        new DeleteSecretCommand({
          SecretId: secretArn,
          ForceDeleteWithoutRecovery: true,
        }),
      );
    } catch (error) {
      console.warn('Failed to delete secret:', error);
    }
  }

  // 4. Delete SSM parameters (best-effort).
  const ssmParameterPrefix =
    detail.ssmParameterPrefix ?? integration?.ssmParameterPrefix;
  if (ssmParameterPrefix && integration) {
    try {
      const spec = getConnectorSpec(integration.integrationType);
      if (spec?.configuration.ssmParameters) {
        for (const paramName of spec.configuration.ssmParameters) {
          try {
            await ssm.send(
              new DeleteParameterCommand({
                Name: `${ssmParameterPrefix}/${paramName}`,
              }),
            );
          } catch (error) {
            console.warn(`Failed to delete SSM parameter ${paramName}:`, error);
          }
        }
      }
    } catch (error) {
      console.warn('Failed to delete SSM parameters:', error);
    }
  }

  // 5. Delete the DDB row last (best-effort).
  if (integration) {
    try {
      await dynamodb.send(
        new DeleteCommand({
          TableName: INTEGRATIONS_TABLE,
          Key: { PK: integration.PK, SK: integration.SK },
        }),
      );
      console.log('Integration row deleted:', detail.integrationId);
    } catch (error) {
      console.warn('Failed to delete DDB row:', error);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

async function retrieveOauthCredentialsFromSecret(secretArn: string): Promise<Record<string, unknown>> {
  const resp = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!resp.SecretString) return {};
  try {
    return JSON.parse(resp.SecretString);
  } catch {
    return {};
  }
}

async function getIntegration(integrationId: string) {
  const response = await dynamodb.send(
    new QueryCommand({
      TableName: INTEGRATIONS_TABLE,
      IndexName: 'IntegrationIdIndex',
      KeyConditionExpression: 'integrationId = :id',
      ExpressionAttributeValues: {
        ':id': integrationId,
      },
    }),
  );

  return response.Items && response.Items.length > 0 ? response.Items[0] : null;
}

interface UpdateAfterCreateInput {
  status: string;
  agentCoreRegistered: boolean;
  gatewayTargetId?: string;
  targetStatus?: string;
  authorizationUrl?: string;
}

/**
 * P3.A: write the post-create state in a single UpdateCommand to capture
 * `gatewayTargetId`, `targetStatus`, and (for 3LO) `authorizationUrl`.
 */
async function updateIntegrationAfterCreate(
  integrationId: string,
  input: UpdateAfterCreateInput,
): Promise<void> {
  const integration = await getIntegration(integrationId);
  if (!integration) {
    throw new Error(`Integration not found: ${integrationId}`);
  }

  const now = new Date().toISOString();
  const setParts = [
    '#status = :status',
    '#agentCoreRegistered = :agentCoreRegistered',
    '#updatedAt = :updatedAt',
  ];
  const exprNames: Record<string, string> = {
    '#status': 'status',
    '#agentCoreRegistered': 'agentCoreRegistered',
    '#updatedAt': 'updatedAt',
  };
  const exprValues: Record<string, unknown> = {
    ':status': input.status,
    ':agentCoreRegistered': input.agentCoreRegistered,
    ':updatedAt': now,
  };

  if (input.gatewayTargetId) {
    setParts.push('#gatewayTargetId = :gatewayTargetId');
    exprNames['#gatewayTargetId'] = 'gatewayTargetId';
    exprValues[':gatewayTargetId'] = input.gatewayTargetId;
  }
  if (input.targetStatus) {
    setParts.push('#targetStatus = :targetStatus');
    exprNames['#targetStatus'] = 'targetStatus';
    exprValues[':targetStatus'] = input.targetStatus;
  }
  if (input.authorizationUrl) {
    setParts.push('#authorizationUrl = :authorizationUrl');
    exprNames['#authorizationUrl'] = 'authorizationUrl';
    exprValues[':authorizationUrl'] = input.authorizationUrl;
  }

  const removeParts: string[] = [];
  if (input.status === 'CONNECTED') {
    removeParts.push('#errorMessage');
    exprNames['#errorMessage'] = 'errorMessage';
    setParts.push('#lastSyncAt = :lastSyncAt');
    exprNames['#lastSyncAt'] = 'lastSyncAt';
    exprValues[':lastSyncAt'] = now;
  }

  let updateExpression = `SET ${setParts.join(', ')}`;
  if (removeParts.length > 0) {
    updateExpression += ` REMOVE ${removeParts.join(', ')}`;
  }

  await dynamodb.send(
    new UpdateCommand({
      TableName: INTEGRATIONS_TABLE,
      Key: { PK: integration.PK, SK: integration.SK },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
    }),
  );
}

// D-03: Atomic status update using UpdateCommand instead of read-then-write
async function updateIntegrationStatus(
  integrationId: string,
  status: string,
  agentCoreRegistered: boolean,
  gatewayTargetId?: string,
  errorMessage?: string,
) {
  const integration = await getIntegration(integrationId);

  if (!integration) {
    throw new Error(`Integration not found: ${integrationId}`);
  }

  const now = new Date().toISOString();
  const updateExprParts = [
    '#status = :status',
    '#agentCoreRegistered = :agentCoreRegistered',
    '#updatedAt = :updatedAt',
  ];
  const exprNames: Record<string, string> = {
    '#status': 'status',
    '#agentCoreRegistered': 'agentCoreRegistered',
    '#updatedAt': 'updatedAt',
  };
  const exprValues: Record<string, unknown> = {
    ':status': status,
    ':agentCoreRegistered': agentCoreRegistered,
    ':updatedAt': now,
  };

  if (gatewayTargetId) {
    updateExprParts.push('#gatewayTargetId = :gatewayTargetId');
    exprNames['#gatewayTargetId'] = 'gatewayTargetId';
    exprValues[':gatewayTargetId'] = gatewayTargetId;
  }

  if (status === 'CONNECTED') {
    updateExprParts.push('#lastSyncAt = :lastSyncAt');
    exprNames['#lastSyncAt'] = 'lastSyncAt';
    exprValues[':lastSyncAt'] = now;
  }

  if (errorMessage) {
    updateExprParts.push('#errorMessage = :errorMessage');
    exprNames['#errorMessage'] = 'errorMessage';
    exprValues[':errorMessage'] = errorMessage;
  }

  const removeExprParts: string[] = [];
  if (status === 'CONNECTED') {
    removeExprParts.push('#errorMessage');
    exprNames['#errorMessage'] = 'errorMessage';
  }

  let updateExpression = `SET ${updateExprParts.join(', ')}`;
  if (removeExprParts.length > 0 && !errorMessage) {
    updateExpression += ` REMOVE ${removeExprParts.join(', ')}`;
  }

  await dynamodb.send(
    new UpdateCommand({
      TableName: INTEGRATIONS_TABLE,
      Key: { PK: integration.PK, SK: integration.SK },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: exprValues,
    }),
  );
}
