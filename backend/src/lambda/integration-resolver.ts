import { AppSyncResolverEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  SecretsManagerClient,
  CreateSecretCommand,
  GetSecretValueCommand,
  DeleteSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import {
  SSMClient,
  PutParameterCommand,
  GetParameterCommand,
} from '@aws-sdk/client-ssm';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { v4 as uuidv4 } from 'uuid';
import { getConnectorSpec, validateCredentials, validateConfiguration } from '../utils/connector-registry';
import { testConnection } from '../utils/connection-tester';
import {
  validateTransition,
  getStatusAfterSuccessfulTest,
  getStatusAfterFailedTest,
  canTest,
  canConnect,
  canDisconnect,
  type IntegrationStatus,
} from '../utils/lifecycle-validator';
import { storeCredentials } from '../utils/credential-manager';
import {
  provisionCredentialProvider,
  deprovisionCredentialProvider,
} from '../utils/gateway-target-manager';

const dynamodb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secretsManager = new SecretsManagerClient({});
const ssm = new SSMClient({});
const eventBridge = new EventBridgeClient({});

const INTEGRATIONS_TABLE = process.env.INTEGRATIONS_TABLE!;
const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';
const REGION = process.env.AWS_REGION || 'ap-southeast-2';
const ACCOUNT_ID = process.env.ACCOUNT_ID || '';
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || 'citadel-agents-test';
const EVENT_SOURCE = 'citadel.integrations';

// AgentCore connector types — the AgentCore Gateway / IAM-role variants
// (Lambda + Smithy use GATEWAY_IAM_ROLE; MCP_SERVER uses API_KEY/OAUTH2/CUSTOM).
const AGENTCORE_INTEGRATION_TYPES = new Set(['AWS_LAMBDA', 'AWS_SMITHY', 'MCP_SERVER']);

function isAgentCoreType(integrationType: string): boolean {
  return AGENTCORE_INTEGRATION_TYPES.has(integrationType);
}

/**
 * Connector types that need a synchronously-provisioned AgentCore Identity
 * credential provider at create time, so the unified
 * `gateway-registration-handler` can build a target payload with a real
 * `credentialProviderArn`. P3.A: this set adds CONFLUENCE — see gap 9 fix.
 *
 * For AWS_LAMBDA / AWS_SMITHY this returns `undefined` (they use
 * GATEWAY_IAM_ROLE and need no provider provisioning).
 */
function getCredentialProviderType(
  integrationType: string,
  credentials: any,
): 'API_KEY' | 'OAUTH2' | undefined {
  if (integrationType === 'CONFLUENCE') return 'API_KEY';
  if (integrationType !== 'MCP_SERVER') return undefined;
  if (credentials?.authMethod === 'API_KEY') return 'API_KEY';
  if (credentials?.authMethod === 'OAUTH2') return 'OAUTH2';
  return undefined;
}

/**
 * Recover the credential-provider type from a stored integration record.
 * Used by deleteIntegration where we no longer have the original credentials
 * in memory. Reads the explicitly persisted `credentialProviderType` (new
 * format), falling back to ARN-pattern inference for defensive recovery.
 */
function inferCredentialProviderType(
  integration: any,
): 'API_KEY' | 'OAUTH2' | undefined {
  if (!integration?.credentialProviderArn) return undefined;
  if (
    integration.credentialProviderType === 'API_KEY' ||
    integration.credentialProviderType === 'OAUTH2'
  ) {
    return integration.credentialProviderType;
  }
  const arn = String(integration.credentialProviderArn);
  if (arn.includes('api-key-credential-provider')) return 'API_KEY';
  if (arn.includes('oauth2-credential-provider')) return 'OAUTH2';
  return undefined;
}

/**
 * Build the `apiKey` value that AgentCore Identity will inject into the
 * outbound request. For CONFLUENCE this is a Basic-auth-encoded
 * `email:apiToken` pair (the gateway target-builder sets `credentialPrefix:
 * 'Basic'` so AgentCore prepends `Basic ` to this value at request time).
 */
function buildCredentialProviderApiKey(
  integrationType: string,
  credentials: any,
): string {
  if (integrationType === 'CONFLUENCE') {
    const email = credentials?.email;
    const apiToken = credentials?.apiToken;
    if (!email || !apiToken) {
      throw new Error('CONFLUENCE credentials require email and apiToken');
    }
    return Buffer.from(`${email}:${apiToken}`).toString('base64');
  }
  // MCP_SERVER + API_KEY uses the raw apiKey value.
  if (typeof credentials?.apiKey !== 'string') {
    throw new Error('API_KEY credentials require an apiKey field');
  }
  return credentials.apiKey;
}

/**
 * Result of the synchronous credential-provider provisioning step that
 * runs inside `createIntegration` before the EventBridge handoff.
 */
interface ProvisionResult {
  credentialProviderArn?: string;
  credentialProviderType?: 'API_KEY' | 'OAUTH2';
  agentCoreCallbackUrl?: string;
}

/**
 * P3.A: synchronously provision the credential provider (when applicable).
 * Returns the fields the resolver persists on the integration record before
 * publishing the EventBridge `integration.connect.requested` event. Target
 * creation is deferred to `gateway-registration-handler`.
 *
 * For OAUTH2 we pass the validated config object directly; the manager
 * consumes its `tokenUrl` / `discoveryUrl` / `scopes` / `grantType` fields.
 * For API_KEY (CONFLUENCE + MCP_SERVER) we pass the synthesised `apiKey`.
 */
async function provisionProviderForIntegration(
  integrationId: string,
  integrationType: string,
  credentials: any,
): Promise<ProvisionResult> {
  const providerType = getCredentialProviderType(integrationType, credentials);
  if (!providerType) return {};

  if (providerType === 'OAUTH2') {
    const provider = await provisionCredentialProvider(
      integrationId,
      'OAUTH2',
      credentials,
    );
    const result: ProvisionResult = {
      credentialProviderArn: provider.credentialProviderArn,
      credentialProviderType: 'OAUTH2',
    };
    if (provider.callbackUrl) result.agentCoreCallbackUrl = provider.callbackUrl;
    return result;
  }

  // API_KEY (CONFLUENCE basic-auth or MCP_SERVER raw API key).
  const apiKey = buildCredentialProviderApiKey(integrationType, credentials);
  const provider = await provisionCredentialProvider(integrationId, 'API_KEY', { apiKey });
  return {
    credentialProviderArn: provider.credentialProviderArn,
    credentialProviderType: 'API_KEY',
  };
}

/**
 * Publish an EventBridge event to drive the unified async target lifecycle
 * (P3.A). Detail-types `integration.connect.requested` and
 * `integration.disconnect.requested` are handled by
 * `gateway-registration-handler`.
 */
async function emitIntegrationEvent(
  detailType: 'integration.connect.requested' | 'integration.disconnect.requested',
  detail: Record<string, unknown>,
): Promise<void> {
  await eventBridge.send(
    new PutEventsCommand({
      Entries: [
        {
          Source: EVENT_SOURCE,
          DetailType: detailType,
          Detail: JSON.stringify(detail),
          EventBusName: EVENT_BUS_NAME,
        },
      ],
    }),
  );
}

interface AppSyncEventIdentity {
  username?: string;
  sub?: string;
}

interface AppSyncEvent extends Omit<AppSyncResolverEvent<any>, 'identity'> {
  identity?: AppSyncEventIdentity;
}

/**
 * Sanitize event arguments before logging to prevent credential leakage
 * Redacts all sensitive credential fields including IAM role ARNs
 */
function sanitizeEventForLogging(event: AppSyncEvent): unknown {
  const sensitiveFields = [
    'apitoken',
    'password',
    'clientsecret',
    'token',
    'secret',
    'apikey',
    'executionrolearn',
    'rolearn',
  ];

  const sanitizeObject = (obj: any): any => {
    if (!obj || typeof obj !== 'object') {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => sanitizeObject(item));
    }

    const sanitized: any = {};
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      const isSensitive = sensitiveFields.some(field => lowerKey.includes(field));

      if (isSensitive) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = sanitizeObject(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  };

  return sanitizeObject(event);
}

/**
 * Sanitize Integration object for API response
 * Removes all sensitive credential fields from config
 */
function sanitizeIntegrationForResponse(integration: any): unknown {
  const sensitiveConfigFields = [
    'apiToken',
    'password',
    'clientSecret',
    'token',
    'secret',
    'apiKey',
    'executionRoleArn',
    'roleArn',
  ];

  const sanitized = { ...integration };

  if (sanitized.config && typeof sanitized.config === 'object') {
    const sanitizedConfig: any = {};

    for (const [key, value] of Object.entries(sanitized.config)) {
      const isSensitive = sensitiveConfigFields.some(field =>
        key.toLowerCase().includes(field.toLowerCase()),
      );

      if (isSensitive) {
        sanitizedConfig[key] = '********';
      } else {
        sanitizedConfig[key] = value;
      }
    }

    sanitized.config = sanitizedConfig;
  }

  delete sanitized.PK;
  delete sanitized.SK;

  return sanitized;
}

export async function handler(event: AppSyncEvent) {
  const sanitizedEvent = sanitizeEventForLogging(event);
  console.log('Integration resolver event:', JSON.stringify(sanitizedEvent, null, 2));

  const { fieldName } = event.info;

  try {
    switch (fieldName) {
      case 'createIntegration':
        return await createIntegration(event.arguments.input, event.identity?.username || 'system');
      case 'updateIntegration':
        return await updateIntegration(event.arguments.input);
      case 'deleteIntegration':
        return await deleteIntegration(event.arguments.integrationId);
      case 'testIntegration':
        return await testIntegration(event.arguments.integrationId);
      case 'connectIntegration':
        return await connectIntegration(event.arguments.integrationId);
      case 'disconnectIntegration':
        return await disconnectIntegration(event.arguments.integrationId);
      case 'listIntegrations':
        return await listIntegrations(
          event.arguments.orgId,
          event.arguments.integrationType,
          event.arguments.status,
        );
      case 'getIntegration': {
        const integration = await getIntegration(event.arguments.integrationId);
        return sanitizeIntegrationForResponse(integration);
      }
      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error: unknown) {
    console.error('Integration resolver error:', error);
    throw error;
  }
}

/**
 * P3.A: createIntegration is now uniform across CONFLUENCE + AGENTCORE_TYPES:
 *   1. Validate credentials and configuration
 *   2. Store credentials in Secrets Manager + SSM
 *   3. Provision AgentCore Identity credential provider (sync, when needed)
 *   4. Persist DDB record with `credentialProviderArn`, `agentCoreCallbackUrl`,
 *      `targetStatus: PENDING`
 *   5. Emit `integration.connect.requested` event — handler creates target
 *   6. Return integration immediately (frontend polls or waits for callback)
 *
 * Other connector types (JIRA, SERVICENOW…) skip steps 3 and 5.
 */
async function createIntegration(input: any, createdBy: string) {
  const integrationId = uuidv4();
  const timestamp = new Date().toISOString();

  const spec = getConnectorSpec(input.integrationType);
  if (!spec) {
    throw new Error(`Unknown connector type: ${input.integrationType}`);
  }

  const credValidation = validateCredentials(input.integrationType, input.credentials);
  if (!credValidation.valid) {
    throw new Error(`Invalid credentials: ${credValidation.errors.join(', ')}`);
  }

  const configValidation = validateConfiguration(input.integrationType, input.config);
  if (!configValidation.valid) {
    throw new Error(`Invalid configuration: ${configValidation.errors.join(', ')}`);
  }

  const isAgentCore = isAgentCoreType(input.integrationType);
  const needsProvider = Boolean(getCredentialProviderType(input.integrationType, input.credentials));
  const usesUnifiedAsyncFlow = isAgentCore || input.integrationType === 'CONFLUENCE';

  let credentialProviderArn: string | undefined;
  let credentialProviderType: 'API_KEY' | 'OAUTH2' | undefined;
  let agentCoreCallbackUrl: string | undefined;
  let secretArn: string | undefined;
  let ssmParameterPrefix: string | undefined;

  try {
    // 1. Store credentials in Secrets Manager (and configuration in SSM).
    const stored = await storeCredentials(
      input.integrationType,
      integrationId,
      input.orgId,
      input.credentials,
      input.config,
    );
    secretArn = stored.secretArn;
    ssmParameterPrefix = stored.ssmParameterPrefix;

    // Email is non-sensitive metadata for display — surface in config.
    if (input.credentials.email) {
      input.config.email = input.credentials.email;
    }

    // 2. Provision AgentCore Identity credential provider (sync). On failure,
    //    roll back the just-created secret so we don't leak it.
    if (needsProvider) {
      try {
        const provision = await provisionProviderForIntegration(
          integrationId,
          input.integrationType,
          input.credentials,
        );
        credentialProviderArn = provision.credentialProviderArn;
        credentialProviderType = provision.credentialProviderType;
        agentCoreCallbackUrl = provision.agentCoreCallbackUrl;
      } catch (provisionErr: unknown) {
        console.error('Credential provider provisioning failed:', {
          integrationId,
          integrationType: input.integrationType,
          error: provisionErr instanceof Error ? provisionErr.message : String(provisionErr),
        });
        // Best-effort secret cleanup.
        try {
          await secretsManager.send(
            new DeleteSecretCommand({ SecretId: secretArn, ForceDeleteWithoutRecovery: true }),
          );
        } catch (cleanupErr) {
          console.warn('Failed to clean up secret after provision failure:', cleanupErr);
        }
        throw new Error(
          `Failed to provision credential provider: ${provisionErr instanceof Error ? provisionErr.message : String(provisionErr)}`,
        );
      }
    }

    // 3. Persist DDB record with all P3.A fields. `targetStatus: PENDING`
    //    signals the handler has not yet created the gateway target.
    const integration: any = {
      PK: `ORG#${input.orgId}`,
      SK: `INTEGRATION#${input.integrationType}#${integrationId}`,
      integrationId,
      integrationType: input.integrationType,
      name: input.name,
      status: 'CONFIGURED' as IntegrationStatus,
      orgId: input.orgId,
      createdBy,
      createdAt: timestamp,
      updatedAt: timestamp,
      config: input.config,
      secretArn,
      ssmParameterPrefix,
      metadata: {
        version: '1.0',
        protocol: isAgentCore ? 'MCP' : 'REST',
        provider: spec.provider,
        authMethod: spec.authentication.method,
      },
    };

    if (credentialProviderArn) {
      integration.credentialProviderArn = credentialProviderArn;
    }
    if (credentialProviderType) {
      integration.credentialProviderType = credentialProviderType;
    }
    if (agentCoreCallbackUrl) {
      integration.agentCoreCallbackUrl = agentCoreCallbackUrl;
    }
    if (usesUnifiedAsyncFlow) {
      integration.targetStatus = 'PENDING';
    }

    await dynamodb.send(
      new PutCommand({
        TableName: INTEGRATIONS_TABLE,
        Item: integration,
      }),
    );

    // 4. Emit `integration.connect.requested` so the handler creates the
    //    gateway target asynchronously. Skipped for non-async connector
    //    types (JIRA, SERVICENOW…) which use a different flow.
    if (usesUnifiedAsyncFlow) {
      try {
        await emitIntegrationEvent('integration.connect.requested', {
          integrationId,
          integrationType: input.integrationType,
          orgId: input.orgId,
          ...(secretArn ? { secretArn } : {}),
          ...(ssmParameterPrefix ? { ssmParameterPrefix } : {}),
          ...(credentialProviderArn ? { credentialProviderArn } : {}),
          ...(credentialProviderType ? { credentialProviderType } : {}),
        });
      } catch (eventErr: unknown) {
        // Event-emit failure is non-fatal: the user can call
        // connectIntegration to retry the publication. The DDB record is
        // already in `PENDING` state.
        console.warn('Failed to publish integration.connect.requested:', {
          integrationId,
          error: eventErr instanceof Error ? eventErr.message : String(eventErr),
        });
      }
    }

    console.log('Integration created:', {
      integrationId,
      integrationType: input.integrationType,
      orgId: input.orgId,
      hasCredentialProvider: Boolean(credentialProviderArn),
      asyncFlow: usesUnifiedAsyncFlow,
    });

    return sanitizeIntegrationForResponse(integration);
  } catch (error: unknown) {
    console.error('Integration creation failed:', {
      integrationId,
      integrationType: input.integrationType,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function updateIntegration(input: any) {
  const integration = await getIntegration(input.integrationId);

  const spec = getConnectorSpec(integration.integrationType);
  if (!spec) {
    throw new Error(`Unknown connector type: ${integration.integrationType}`);
  }

  if (input.credentials) {
    const secretValue: Record<string, any> = {};

    for (const field of spec.authentication.fields) {
      if (input.credentials[field]) {
        secretValue[field] = input.credentials[field];
      }
    }

    for (const configField of spec.configuration.required) {
      const configVal = input.config?.[configField] || integration.config[configField];
      if (configVal) {
        secretValue[configField] = configVal;
      }
    }

    const existing = await secretsManager.send(
      new GetSecretValueCommand({ SecretId: integration.secretArn }),
    );

    const existingData = existing.SecretString ? JSON.parse(existing.SecretString) : {};
    const mergedData = { ...existingData, ...secretValue };

    await secretsManager.send(
      new CreateSecretCommand({
        Name: integration.secretArn.split(':').pop()!,
        SecretString: JSON.stringify(mergedData),
      }),
    );
  }

  if (input.config) {
    integration.config = { ...integration.config, ...input.config };

    if (input.credentials?.email) {
      integration.config.email = input.credentials.email;
    }

    for (const paramName of spec.configuration.ssmParameters) {
      const camelCaseKey = paramName.replace(/-([a-z])/g, g => g[1].toUpperCase());
      const value = input.config[paramName] || input.config[camelCaseKey];

      if (value !== undefined) {
        await ssm.send(
          new PutParameterCommand({
            Name: `${integration.ssmParameterPrefix}/${paramName}`,
            Value: typeof value === 'string' ? value : JSON.stringify(value),
            Type: 'String',
            Overwrite: true,
          }),
        );
      }
    }
  } else if (input.credentials?.email) {
    integration.config = { ...integration.config, email: input.credentials.email };
  }

  if (input.name) integration.name = input.name;

  if (input.status) {
    validateTransition(integration.status as IntegrationStatus, input.status as IntegrationStatus);
    integration.status = input.status;
  }

  if (input.credentials && !input.status) {
    validateTransition(integration.status as IntegrationStatus, 'CONFIGURED');
    integration.status = 'CONFIGURED';
  }

  const currentVersion = integration.version || 0;
  integration.version = currentVersion + 1;
  integration.updatedAt = new Date().toISOString();

  try {
    await dynamodb.send(
      new PutCommand({
        TableName: INTEGRATIONS_TABLE,
        Item: integration,
        ConditionExpression:
          currentVersion === 0
            ? 'attribute_not_exists(version) OR version = :currentVersion'
            : 'version = :currentVersion',
        ExpressionAttributeValues: {
          ':currentVersion': currentVersion,
        },
      }),
    );
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      throw new Error(
        `Conflict: integration ${input.integrationId} was modified concurrently. Please retry.`,
      );
    }
    throw error;
  }

  console.log('Integration updated:', {
    integrationId: input.integrationId,
    status: integration.status,
  });
  return sanitizeIntegrationForResponse(integration);
}

async function testIntegration(integrationId: string) {
  const integration = await getIntegration(integrationId);

  if (!canTest(integration.status as IntegrationStatus)) {
    throw new Error(
      `Cannot test integration in status ${integration.status}. ` +
        `Integration must be in CONFIGURED, TESTED, CONNECTED, DISCONNECTED, or CONNECTION_FAILED status.`,
    );
  }

  const secret = await secretsManager.send(
    new GetSecretValueCommand({ SecretId: integration.secretArn }),
  );
  const credentials = JSON.parse(secret.SecretString!);

  const config = integration.config || {};
  const isAgentCore = isAgentCoreType(integration.integrationType);

  if (isAgentCore && integration.ssmParameterPrefix) {
    const spec = getConnectorSpec(integration.integrationType);
    if (spec && spec.configuration.ssmParameters) {
      for (const paramName of spec.configuration.ssmParameters) {
        try {
          const param = await ssm.send(
            new GetParameterCommand({
              Name: `${integration.ssmParameterPrefix}/${paramName}`,
            }),
          );

          const configKey = paramName.replace(/-([a-z])/g, g => g[1].toUpperCase());
          config[configKey] = param.Parameter?.Value;
        } catch (error: unknown) {
          console.warn(`Failed to retrieve SSM parameter ${paramName}:`, error instanceof Error ? error.message : String(error));
        }
      }
    }
  }

  try {
    const testResult = await testConnection(integration.integrationType, credentials, config);

    integration.lastTestAt = new Date().toISOString();

    if (testResult.success) {
      integration.errorMessage = undefined;
      const newStatus = getStatusAfterSuccessfulTest(integration.status as IntegrationStatus);
      validateTransition(integration.status as IntegrationStatus, newStatus);
      integration.status = newStatus;
    } else {
      integration.errorMessage = testResult.message;
      const newStatus = getStatusAfterFailedTest(integration.status as IntegrationStatus);
      integration.status = newStatus;
    }

    await dynamodb.send(
      new PutCommand({
        TableName: INTEGRATIONS_TABLE,
        Item: integration,
      }),
    );

    console.log('Integration test completed:', {
      integrationId,
      integrationType: integration.integrationType,
      success: testResult.success,
      status: integration.status,
    });

    return testResult;
  } catch (error: unknown) {
    console.error('Test integration error:', {
      integrationId,
      integrationType: integration.integrationType,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: `Connection error: ${error instanceof Error ? error.message : String(error)}`,
      details: { error: String(error) },
    };
  }
}

/**
 * P3.A: connectIntegration is now uniform — it confirms the integration
 * exists and re-emits `integration.connect.requested` (idempotent in the
 * handler via the `IdempotencyGuard`). For 3LO integrations whose target
 * is in `CREATE_PENDING_AUTH`, the persisted `authorizationUrl` is
 * surfaced so the frontend can redirect the user to the IdP.
 */
async function connectIntegration(integrationId: string) {
  const integration = await getIntegration(integrationId);

  if (!canConnect(integration.status as IntegrationStatus)) {
    throw new Error(
      `Cannot connect integration in status ${integration.status}. ` +
        `Integration must be in TESTED, CONFIGURED, DISCONNECTED, or CONNECTION_FAILED status.`,
    );
  }

  try {
    validateTransition(integration.status as IntegrationStatus, 'CONNECTING');

    await emitIntegrationEvent('integration.connect.requested', {
      integrationId: integration.integrationId,
      integrationType: integration.integrationType,
      orgId: integration.orgId,
      ...(integration.secretArn ? { secretArn: integration.secretArn } : {}),
      ...(integration.ssmParameterPrefix
        ? { ssmParameterPrefix: integration.ssmParameterPrefix }
        : {}),
      ...(integration.credentialProviderArn
        ? { credentialProviderArn: integration.credentialProviderArn }
        : {}),
      ...(integration.credentialProviderType
        ? { credentialProviderType: integration.credentialProviderType }
        : {}),
    });

    integration.status = 'CONNECTING';
    integration.updatedAt = new Date().toISOString();

    await dynamodb.send(
      new PutCommand({
        TableName: INTEGRATIONS_TABLE,
        Item: integration,
      }),
    );

    console.log('Integration connect event published:', {
      integrationId,
      status: integration.status,
      targetStatus: integration.targetStatus || 'N/A',
      hasAuthorizationUrl: Boolean(integration.authorizationUrl),
    });
    return sanitizeIntegrationForResponse(integration);
  } catch (error: unknown) {
    console.error('Failed to publish connect event:', error);

    try {
      validateTransition(integration.status as IntegrationStatus, 'CONNECTION_FAILED');
      integration.status = 'CONNECTION_FAILED';
      integration.errorMessage = `Failed to initiate connection: ${error instanceof Error ? error.message : String(error)}`;
      integration.updatedAt = new Date().toISOString();

      await dynamodb.send(
        new PutCommand({
          TableName: INTEGRATIONS_TABLE,
          Item: integration,
        }),
      );
    } catch (persistErr) {
      console.warn('Failed to persist CONNECTION_FAILED for integration', {
        integrationId,
        error: (persistErr as Error)?.message,
      });
    }

    throw error;
  }
}

async function disconnectIntegration(integrationId: string) {
  const integration = await getIntegration(integrationId);

  if (!canDisconnect(integration.status as IntegrationStatus)) {
    throw new Error(
      `Cannot disconnect integration in status ${integration.status}. ` +
        `Integration must be in CONNECTED status.`,
    );
  }

  try {
    validateTransition(integration.status as IntegrationStatus, 'DISCONNECTED');

    // Emit disconnect event so the handler can detach the gateway target.
    // Unlike deleteIntegration, this does NOT remove the credential provider
    // or the integration record — disconnect is reversible.
    await emitIntegrationEvent('integration.disconnect.requested', {
      integrationId: integration.integrationId,
      integrationType: integration.integrationType,
      orgId: integration.orgId,
      ...(integration.gatewayTargetId ? { gatewayTargetId: integration.gatewayTargetId } : {}),
      // disconnect: target only (no provider/secret/ssm/ddb cleanup).
      keepResources: true,
    });

    integration.status = 'DISCONNECTED';
    integration.agentCoreRegistered = false;
    integration.updatedAt = new Date().toISOString();

    await dynamodb.send(
      new PutCommand({
        TableName: INTEGRATIONS_TABLE,
        Item: integration,
      }),
    );

    console.log('Integration disconnect event published:', {
      integrationId,
      status: integration.status,
    });
    return sanitizeIntegrationForResponse(integration);
  } catch (error: unknown) {
    console.error('Failed to publish disconnect event:', error);
    throw error;
  }
}

async function listIntegrations(orgId: string, integrationType?: string, status?: string) {
  const params: any = {
    TableName: INTEGRATIONS_TABLE,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `ORG#${orgId}`,
    },
  };

  if (integrationType) {
    params.KeyConditionExpression += ' AND begins_with(SK, :sk)';
    params.ExpressionAttributeValues[':sk'] = `INTEGRATION#${integrationType}#`;
  } else {
    params.KeyConditionExpression += ' AND begins_with(SK, :sk)';
    params.ExpressionAttributeValues[':sk'] = 'INTEGRATION#';
  }

  if (status) {
    params.FilterExpression = '#status = :status';
    params.ExpressionAttributeNames = { '#status': 'status' };
    params.ExpressionAttributeValues[':status'] = status;
  }

  const response = await dynamodb.send(new QueryCommand(params));
  console.log('Listed integrations:', {
    orgId,
    count: response.Items?.length || 0,
    integrationType,
    status,
  });

  const sanitizedItems = (response.Items || []).map(item =>
    sanitizeIntegrationForResponse(item),
  );
  return sanitizedItems;
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

  if (!response.Items || response.Items.length === 0) {
    throw new Error(`Integration not found: ${integrationId}`);
  }

  return response.Items[0];
}

/**
 * P3.A: deleteIntegration emits an EventBridge event and returns
 * immediately. The `gateway-registration-handler` performs target →
 * provider → secret → SSM → DDB deletion asynchronously (option (c) from
 * the architectural Q&A: simplest, single Lambda invocation per
 * integration). The DDB row is marked `targetStatus: DELETING` so the
 * frontend can show "Disconnecting..." until the handler finishes.
 */
async function deleteIntegration(integrationId: string) {
  const integration = await getIntegration(integrationId);

  try {
    await emitIntegrationEvent('integration.disconnect.requested', {
      integrationId: integration.integrationId,
      integrationType: integration.integrationType,
      orgId: integration.orgId,
      ...(integration.gatewayTargetId ? { gatewayTargetId: integration.gatewayTargetId } : {}),
      ...(integration.credentialProviderArn
        ? { credentialProviderArn: integration.credentialProviderArn }
        : {}),
      ...(integration.credentialProviderType
        ? { credentialProviderType: integration.credentialProviderType }
        : { credentialProviderType: inferCredentialProviderType(integration) }),
      ...(integration.secretArn ? { secretArn: integration.secretArn } : {}),
      ...(integration.ssmParameterPrefix
        ? { ssmParameterPrefix: integration.ssmParameterPrefix }
        : {}),
      // delete: full teardown.
      keepResources: false,
    });

    // Mark the integration as DELETING so the user sees "Disconnecting…"
    // until the handler removes the row. Use UpdateCommand to avoid
    // clobbering concurrent writes.
    await dynamodb.send(
      new UpdateCommand({
        TableName: INTEGRATIONS_TABLE,
        Key: { PK: integration.PK, SK: integration.SK },
        UpdateExpression: 'SET #targetStatus = :ts, #updatedAt = :now',
        ExpressionAttributeNames: {
          '#targetStatus': 'targetStatus',
          '#updatedAt': 'updatedAt',
        },
        ExpressionAttributeValues: {
          ':ts': 'DELETING',
          ':now': new Date().toISOString(),
        },
      }),
    );

    console.log('Integration deletion event published:', {
      integrationId,
      integrationType: integration.integrationType,
    });
    return {
      success: true,
      message: 'Integration deletion scheduled',
    };
  } catch (error: unknown) {
    console.error('Integration deletion failed:', {
      integrationId,
      integrationType: integration.integrationType,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// Re-export deprovisionCredentialProvider so other resolvers (and tests)
// have a single import surface for the Phase-3-era integration lifecycle.
export { deprovisionCredentialProvider };

// Touched for type-check purposes: env constants are referenced indirectly
// in the registered handler.  Suppress unused-warning for build-time only.
void ENVIRONMENT;
void REGION;
void ACCOUNT_ID;
