/**
 * App Auth Config Management — Set authentication configuration for published apps.
 *
 * Supports API_KEY (default) and OAUTH2 (client credentials) modes.
 * Stored as CONFIG#auth component item under the app's groupId.
 *
 * Requirements: 3.1, 3.5, 3.6, 3.7
 */
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

export interface AuthConfigDeps {
  docClient: DynamoDBDocumentClient;
  appsTable: string;
}

export type AuthMode = 'API_KEY' | 'OAUTH2';

export interface AuthConfig {
  mode: string;
  issuerUrl?: string;
  audience?: string;
}

export interface AuthConfigResult {
  appId: string;
  mode: AuthMode;
  issuerUrl?: string;
  audience?: string;
  sortId: string;
}

const VALID_MODES: ReadonlySet<string> = new Set(['API_KEY', 'OAUTH2']);

/**
 * Validates an auth config object.
 * Returns an array of error strings. Empty array means valid.
 */
export function validateAuthConfig(config: AuthConfig): string[] {
  const errors: string[] = [];

  if (!config.mode || !VALID_MODES.has(config.mode)) {
    errors.push(`Invalid auth mode: ${config.mode}. Must be API_KEY or OAUTH2`);
    return errors;
  }

  if (config.mode === 'OAUTH2') {
    if (!config.issuerUrl) {
      errors.push('OAuth2 mode requires issuerUrl');
    }
    if (!config.audience) {
      errors.push('OAuth2 mode requires audience');
    }
  }

  return errors;
}

/**
 * Sets the authentication configuration for an app.
 *
 * - Validates mode is API_KEY or OAUTH2
 * - For OAUTH2, requires issuerUrl and audience
 * - Stores as CONFIG#auth component item under the app's groupId
 *
 * Requirements: 3.1, 3.5, 3.6, 3.7
 */
export async function setAppAuthConfig(
  appId: string,
  config: AuthConfig,
  deps: AuthConfigDeps,
): Promise<AuthConfigResult> {
  // Validate the config
  const errors = validateAuthConfig(config);
  if (errors.length > 0) {
    throw new Error(`Auth config validation failed: ${errors.join('; ')}`);
  }

  const item: {
    appId: string;
    groupId: string;
    sortId: string;
    mode: string;
    updatedAt: string;
    issuerUrl?: string;
    audience?: string;
  } = {
    appId: `${appId}#CONFIG#auth`,
    groupId: `APP#${appId}`,
    sortId: 'CONFIG#auth',
    mode: config.mode,
    updatedAt: new Date().toISOString(),
  };

  if (config.mode === 'OAUTH2') {
    item.issuerUrl = config.issuerUrl;
    item.audience = config.audience;
  }

  await deps.docClient.send(new PutCommand({
    TableName: deps.appsTable,
    Item: item,
  }));

  return {
    appId,
    mode: config.mode as AuthMode,
    issuerUrl: item.issuerUrl,
    audience: item.audience,
    sortId: 'CONFIG#auth',
  };
}
