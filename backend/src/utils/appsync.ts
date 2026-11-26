import { AppSyncResolverEvent, AppSyncIdentityIAM, AppSyncIdentityCognito, AppSyncIdentityOIDC, AppSyncIdentityLambda } from 'aws-lambda';

/**
 * Extracts the field name from an AppSync resolver event
 */
export function getFieldName(event: AppSyncResolverEvent<unknown, unknown>): string {
  return event.info.fieldName;
}

/**
 * Extracts user ID from AppSync identity, handling different identity types
 */
export function getUserId(identity: AppSyncIdentityIAM | AppSyncIdentityCognito | AppSyncIdentityOIDC | AppSyncIdentityLambda | null | undefined): string {
  if (!identity) {
    return 'anonymous';
  }

  // Handle Cognito User Pool identity
  if ('sub' in identity && identity.sub) {
    return identity.sub;
  }

  // Handle Cognito Identity Pool identity
  if ('cognitoIdentityId' in identity && identity.cognitoIdentityId) {
    return identity.cognitoIdentityId;
  }

  // Handle OIDC identity
  if ('claims' in identity && identity.claims?.sub) {
    return identity.claims.sub;
  }

  // Handle Lambda authorizer identity
  if ('resolverContext' in identity && identity.resolverContext?.userId) {
    return identity.resolverContext.userId;
  }

  // Handle IAM identity
  if ('userArn' in identity && identity.userArn) {
    return identity.userArn;
  }

  return 'anonymous';
}

/**
 * Type guard to check if identity is Cognito User Pool
 */
export function isCognitoUserPoolIdentity(identity: unknown): identity is AppSyncIdentityCognito {
  return !!identity && 'sub' in (identity as object);
}

/**
 * Type guard to check if identity is IAM
 */
export function isIAMIdentity(identity: unknown): identity is AppSyncIdentityIAM {
  return !!identity && 'userArn' in (identity as object);
}

/**
 * Type guard to check if identity is OIDC
 */
export function isOIDCIdentity(identity: unknown): identity is AppSyncIdentityOIDC {
  return !!identity && 'claims' in (identity as object);
}

/**
 * Type guard to check if identity is Lambda authorizer
 */
export function isLambdaIdentity(identity: unknown): identity is AppSyncIdentityLambda {
  return !!identity && 'resolverContext' in (identity as object);
}
