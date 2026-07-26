/**
 * AWS Exports Config Conversion
 *
 * Pure conversion from the `aws-exports.json` wire format to the
 * `AmplifyConfig` shape consumed by `serverService.configure()`. Split out
 * of `amplify.ts` so it can be unit-tested under Jest: `amplify.ts` also
 * references `import.meta.env` (Vite-only syntax) in its environment-
 * variable fallback path, which ts-jest cannot transform to CommonJS even
 * when the offending function is never called — the whole file fails to
 * compile if that syntax appears anywhere in it. This module contains none
 * of that syntax, so it transforms and tests cleanly.
 */

export interface AWSExports {
  aws_project_region: string;
  aws_cognito_region: string;
  aws_user_pools_id: string;
  aws_user_pools_web_client_id: string;
  aws_cognito_identity_pool_id?: string;
  aws_appsync_graphqlEndpoint: string;
  aws_appsync_region: string;
  aws_appsync_authenticationType: 'API_KEY' | 'AMAZON_COGNITO_USER_POOLS' | 'AWS_IAM';
  aws_appsync_apiKey?: string;
  environment?: string;
  aws_event_bus_url?: string;
  /** Cost query HttpApi endpoint (TelemetryStack). Absent when the cost surface isn't deployed/threaded yet. */
  aws_cost_api_url?: string;
}

/**
 * Convert AWS exports format to Amplify config format
 */
export function convertAWSExportsToConfig(awsExports: AWSExports) {
  return {
    region: awsExports.aws_project_region,
    userPoolId: awsExports.aws_user_pools_id,
    userPoolClientId: awsExports.aws_user_pools_web_client_id,
    identityPoolId: awsExports.aws_cognito_identity_pool_id,
    appsyncEndpoint: awsExports.aws_appsync_graphqlEndpoint,
    appsyncRegion: awsExports.aws_appsync_region,
    appsyncAuthenticationType: awsExports.aws_appsync_authenticationType,
    appsyncApiKey: awsExports.aws_appsync_apiKey,
    environment: awsExports.environment,
    eventBusUrl: awsExports.aws_event_bus_url || '',
    costApiUrl: awsExports.aws_cost_api_url || '',
  };
}
