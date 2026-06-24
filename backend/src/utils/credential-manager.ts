/**
 * Credential Manager
 * 
 * Handles storing, retrieving, updating, and deleting credentials
 * for different connector types in AWS Secrets Manager and SSM Parameter Store.
 */

import { SecretsManagerClient, CreateSecretCommand, GetSecretValueCommand, UpdateSecretCommand, DeleteSecretCommand } from '@aws-sdk/client-secrets-manager';
import { SSMClient, PutParameterCommand, GetParameterCommand, DeleteParameterCommand } from '@aws-sdk/client-ssm';
import { getConnectorSpec, type ConnectorSpec } from './connector-registry';

const secretsManager = new SecretsManagerClient({});
const ssm = new SSMClient({});

export interface StoreCredentialsResult {
  secretArn: string;
  ssmParameterPrefix: string;
}

/**
 * Store credentials in Secrets Manager with connector-specific structure
 * 
 * @param connectorType - The type of connector (e.g., CONFLUENCE, SERVICENOW)
 * @param integrationId - Unique identifier for the integration
 * @param orgId - Organization ID
 * @param credentials - Credential data (e.g., API tokens, passwords)
 * @param config - Configuration data (e.g., base URLs, workspace IDs)
 * @returns Secret ARN and SSM parameter prefix
 */
export async function storeCredentials(
  connectorType: string,
  integrationId: string,
  orgId: string,
  credentials: any,
  config: any
): Promise<StoreCredentialsResult> {
  // Read connector spec from registry
  const spec = getConnectorSpec(connectorType);
  if (!spec) {
    throw new Error(`Unknown connector type: ${connectorType}`);
  }
  
  // Build secret value based on connector's authentication config
  const secretValue: Record<string, any> = {};
  
  // For IAM_ROLE authentication, only executionRoleArn is required
  // For CONFIGURABLE authentication (MCP_SERVER), fields are conditionally required
  const isConfigurable = spec.authentication.method === 'CONFIGURABLE';
  
  // Validate and add authentication fields to secret
  for (const field of spec.authentication.fields) {
    if (isConfigurable) {
      // For CONFIGURABLE auth, only add fields that are provided
      // authMethod is always required, other fields depend on authMethod value
      if (field === 'authMethod') {
        if (!credentials[field]) {
          throw new Error(`Missing required authentication field: ${field}`);
        }
        secretValue[field] = credentials[field];
      } else if (credentials[field]) {
        // Add optional fields if provided
        secretValue[field] = credentials[field];
      }
    } else {
      // For other auth methods (including IAM_ROLE), all fields are required
      if (!credentials[field]) {
        throw new Error(`Missing required authentication field: ${field}`);
      }
      secretValue[field] = credentials[field];
    }
  }
  
  // Add configuration fields that should be in secret (per connector spec)
  for (const configField of spec.configuration.required) {
    if (config[configField]) {
      secretValue[configField] = config[configField];
    }
  }
  
  // Store in Secrets Manager with connector-specific structure
  const secretName = `/citadel/integrations/${orgId}/${connectorType.toLowerCase()}-${integrationId}`;
  
  const response = await secretsManager.send(new CreateSecretCommand({
    Name: secretName,
    SecretString: JSON.stringify(secretValue),
    Description: `Credentials for ${connectorType} integration ${integrationId}`
  }));
  
  // Store non-sensitive config in SSM Parameter Store
  const ssmParameterPrefix = `/citadel/integrations/${orgId}/${connectorType.toLowerCase()}-${integrationId}`;
  await storeConfiguration(connectorType, ssmParameterPrefix, config);
  
  return {
    secretArn: response.ARN!,
    ssmParameterPrefix
  };
}

/**
 * Detect if credentials are in old format (pre-multi-connector)
 * Old format detection heuristics:
 * - May have different field names or structure
 * - May be missing fields expected in new format
 * - May have legacy field names
 * 
 * @param secretData - Raw secret data from Secrets Manager
 * @param spec - Connector specification
 * @returns true if credentials appear to be in old format
 */
function isOldCredentialFormat(secretData: any, spec: ConnectorSpec): boolean {
  // Check if any expected authentication fields are missing
  for (const field of spec.authentication.fields) {
    if (secretData[field] === undefined) {
      return true;
    }
  }
  
  // Check if any required configuration fields that should be in secret are missing
  for (const configField of spec.configuration.required) {
    // Check if this config field is also in the secret structure
    if (spec.authentication.secretStructure[configField] !== undefined) {
      if (secretData[configField] === undefined) {
        return true;
      }
    }
  }
  
  // Check for legacy field names (e.g., 'token' instead of 'apiToken')
  const hasLegacyFields = 
    (secretData.token !== undefined && secretData.apiToken === undefined) ||
    (secretData.url !== undefined && secretData.baseUrl === undefined) ||
    (secretData.user !== undefined && secretData.username === undefined);
  
  return hasLegacyFields;
}

/**
 * Migrate old credential format to new format
 * Handles various legacy field naming conventions
 * 
 * @param secretData - Raw secret data in old format
 * @param spec - Connector specification
 * @returns Migrated credentials in new format
 */
function migrateOldCredentials(secretData: any, spec: ConnectorSpec): any {
  const migrated: Record<string, any> = { ...secretData };
  
  // Migrate legacy field names to new format
  const fieldMappings: Record<string, string> = {
    'token': 'apiToken',
    'url': 'baseUrl',
    'user': 'username',
    'pass': 'password',
    'instance': 'instanceUrl',
    'workspace': 'workspaceId',
    'tenant': 'tenantId',
    'domain': 'subdomain'
  };
  
  for (const [oldField, newField] of Object.entries(fieldMappings)) {
    if (migrated[oldField] !== undefined && migrated[newField] === undefined) {
      migrated[newField] = migrated[oldField];
      // Keep old field for compatibility but prioritize new field
    }
  }
  
  // Ensure all required authentication fields are present after migration
  for (const field of spec.authentication.fields) {
    if (migrated[field] === undefined) {
      // If still missing after migration, check if we can derive it
      // For example, some old integrations might have stored everything in a single field
      if (field === 'baseUrl' && migrated.instanceUrl !== undefined) {
        migrated.baseUrl = migrated.instanceUrl;
      }
    }
  }
  
  // Ensure all required configuration fields that should be in secret are present
  for (const configField of spec.configuration.required) {
    // Check if this config field is also in the secret structure
    if (spec.authentication.secretStructure[configField] !== undefined) {
      if (migrated[configField] === undefined) {
        // Try to derive from legacy field names
        if (configField === 'baseUrl' && migrated.instanceUrl !== undefined) {
          migrated.baseUrl = migrated.instanceUrl;
        }
      }
    }
  }
  
  return migrated;
}

/**
 * Retrieve credentials from Secrets Manager and parse by connector type
 * Handles both new format and old format credentials for backward compatibility
 * 
 * @param secretArn - ARN of the secret in Secrets Manager
 * @param connectorType - The type of connector
 * @returns Parsed credentials in expected format
 */
export async function retrieveCredentials(
  secretArn: string,
  connectorType: string
): Promise<any> {
  // Retrieve secret from Secrets Manager
  const response = await secretsManager.send(new GetSecretValueCommand({
    SecretId: secretArn
  }));
  
  if (!response.SecretString) {
    throw new Error(`Secret ${secretArn} has no string value`);
  }
  
  // Parse structure based on connector type
  const secretData = JSON.parse(response.SecretString);
  
  const spec = getConnectorSpec(connectorType);
  if (!spec) {
    // If connector type is unknown, return raw data for backward compatibility
    return secretData;
  }
  
  // Detect old format credentials and migrate if necessary
  let credentialsData = secretData;
  if (isOldCredentialFormat(secretData, spec)) {
    console.log(`Detected old credential format for ${connectorType}, migrating...`);
    credentialsData = migrateOldCredentials(secretData, spec);
  }
  
  // Return credentials in expected format
  // Validate that all expected fields are present
  const credentials: Record<string, any> = {};
  const isConfigurable = spec.authentication.method === 'CONFIGURABLE';
  
  for (const field of spec.authentication.fields) {
    if (isConfigurable) {
      // For CONFIGURABLE auth, only authMethod is required
      // Other fields are optional and depend on authMethod value
      if (field === 'authMethod') {
        if (credentialsData[field] === undefined) {
          throw new Error(`Missing expected field ${field} in secret for connector type ${connectorType} (even after migration attempt)`);
        }
        credentials[field] = credentialsData[field];
      } else if (credentialsData[field] !== undefined) {
        // Add optional fields if present
        credentials[field] = credentialsData[field];
      }
    } else {
      // For other auth methods (including IAM_ROLE), all fields are required
      if (credentialsData[field] === undefined) {
        throw new Error(`Missing expected field ${field} in secret for connector type ${connectorType} (even after migration attempt)`);
      }
      credentials[field] = credentialsData[field];
    }
  }
  
  // Include any configuration fields that were stored in the secret
  for (const configField of spec.configuration.required) {
    if (credentialsData[configField] !== undefined) {
      credentials[configField] = credentialsData[configField];
    }
  }
  
  return credentials;
}

/**
 * Update credentials in Secrets Manager
 * 
 * @param secretArn - ARN of the secret to update
 * @param connectorType - The type of connector
 * @param credentials - New credential data
 * @param config - New configuration data
 */
export async function updateCredentials(
  secretArn: string,
  connectorType: string,
  credentials: any,
  config: any
): Promise<void> {
  const spec = getConnectorSpec(connectorType);
  if (!spec) {
    throw new Error(`Unknown connector type: ${connectorType}`);
  }
  
  // Build updated secret value
  const secretValue: Record<string, any> = {};
  
  for (const field of spec.authentication.fields) {
    if (credentials[field]) {
      secretValue[field] = credentials[field];
    }
  }
  
  // Add configuration fields that should be in secret
  for (const configField of spec.configuration.required) {
    if (config[configField]) {
      secretValue[configField] = config[configField];
    }
  }
  
  // If no fields to update, skip
  if (Object.keys(secretValue).length === 0) {
    return;
  }
  
  // Retrieve existing secret to merge with new values
  const existing = await secretsManager.send(new GetSecretValueCommand({
    SecretId: secretArn
  }));
  
  const existingData = existing.SecretString ? JSON.parse(existing.SecretString) : {};
  const mergedData = { ...existingData, ...secretValue };
  
  await secretsManager.send(new UpdateSecretCommand({
    SecretId: secretArn,
    SecretString: JSON.stringify(mergedData)
  }));
}

/**
 * Delete credentials from Secrets Manager
 * 
 * @param secretArn - ARN of the secret to delete
 */
export async function deleteCredentials(secretArn: string): Promise<void> {
  await secretsManager.send(new DeleteSecretCommand({
    SecretId: secretArn,
    ForceDeleteWithoutRecovery: true
  }));
}

/**
 * Store non-sensitive configuration in SSM Parameter Store
 * Uses connector-specific SSM parameters
 * 
 * @param connectorType - The type of connector
 * @param ssmParameterPrefix - Prefix for SSM parameters
 * @param config - Configuration data
 */
export async function storeConfiguration(
  connectorType: string,
  ssmParameterPrefix: string,
  config: any
): Promise<void> {
  const spec = getConnectorSpec(connectorType);
  if (!spec) {
    throw new Error(`Unknown connector type: ${connectorType}`);
  }
  
  // Store each SSM parameter defined in the connector spec
  for (const paramName of spec.configuration.ssmParameters) {
    // Try to find the config value using different key formats
    // Convert param-name to paramName (camelCase)
    const camelCaseKey = paramName.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
    
    // Also try the original param name and without dashes
    const value = config[paramName] || config[camelCaseKey];
    
    if (value !== undefined) {
      await ssm.send(new PutParameterCommand({
        Name: `${ssmParameterPrefix}/${paramName}`,
        Value: typeof value === 'string' ? value : JSON.stringify(value),
        Type: 'String',
        Overwrite: true,
        Description: `Configuration for ${connectorType} integration`
      }));
    }
  }
}

/**
 * Retrieve configuration from SSM Parameter Store
 * 
 * @param connectorType - The type of connector
 * @param ssmParameterPrefix - Prefix for SSM parameters
 * @returns Configuration object
 */
export async function retrieveConfiguration(
  connectorType: string,
  ssmParameterPrefix: string
): Promise<any> {
  const spec = getConnectorSpec(connectorType);
  if (!spec) {
    throw new Error(`Unknown connector type: ${connectorType}`);
  }
  
  const config: Record<string, any> = {};
  
  for (const paramName of spec.configuration.ssmParameters) {
    try {
      const response = await ssm.send(new GetParameterCommand({
        Name: `${ssmParameterPrefix}/${paramName}`
      }));
      
      if (response.Parameter?.Value) {
        // Try to parse as JSON, fall back to string
        try {
          config[paramName] = JSON.parse(response.Parameter.Value);
        } catch {
          config[paramName] = response.Parameter.Value;
        }
      }
    } catch (error: any) {
      // Parameter might not exist, which is okay for optional parameters
      if (error.name !== 'ParameterNotFound') {
        throw error;
      }
    }
  }
  
  return config;
}

/**
 * Delete configuration from SSM Parameter Store
 * 
 * @param connectorType - The type of connector
 * @param ssmParameterPrefix - Prefix for SSM parameters
 */
export async function deleteConfiguration(
  connectorType: string,
  ssmParameterPrefix: string
): Promise<void> {
  const spec = getConnectorSpec(connectorType);
  if (!spec) {
    return; // If connector type is unknown, skip deletion
  }
  
  for (const paramName of spec.configuration.ssmParameters) {
    try {
      await ssm.send(new DeleteParameterCommand({
        Name: `${ssmParameterPrefix}/${paramName}`
      }));
    } catch (error: any) {
      // Parameter might not exist, which is okay
      if (error.name !== 'ParameterNotFound') {
        console.warn(`Failed to delete SSM parameter ${paramName}:`, error);
      }
    }
  }
}
