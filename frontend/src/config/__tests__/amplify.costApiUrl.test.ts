/**
 * amplify config threading tests
 *
 * Covers: `aws_cost_api_url` from aws-exports.json threads into
 * `convertAWSExportsToConfig()`'s `costApiUrl` field (pass 2 config
 * plumbing).
 *
 * Imports from `awsExportsConfig.ts` (not `amplify.ts`) deliberately:
 * `amplify.ts` also references `import.meta.env` (Vite-only syntax) in its
 * environment-variable fallback path, which ts-jest cannot transform to
 * CommonJS regardless of which exported function a test actually calls —
 * the whole file fails to compile if that syntax appears anywhere in it.
 * `convertAWSExportsToConfig` was extracted to its own `import.meta`-free
 * module specifically so this pass's config-threading change is testable
 * under this repo's Jest runner.
 */

import { convertAWSExportsToConfig } from '../awsExportsConfig';

describe('convertAWSExportsToConfig: aws_cost_api_url threading', () => {
  const baseAwsExports = {
    aws_project_region: 'us-east-1',
    aws_cognito_region: 'us-east-1',
    aws_user_pools_id: 'pool-id',
    aws_user_pools_web_client_id: 'client-id',
    aws_appsync_graphqlEndpoint: 'https://appsync.example.com/graphql',
    aws_appsync_region: 'us-east-1',
    aws_appsync_authenticationType: 'AMAZON_COGNITO_USER_POOLS' as const,
  };

  it('maps aws_cost_api_url into costApiUrl when present', () => {
    const config = convertAWSExportsToConfig({
      ...baseAwsExports,
      aws_cost_api_url: 'https://cost.example.com',
    });

    expect(config.costApiUrl).toBe('https://cost.example.com');
  });

  it('defaults costApiUrl to an empty string when aws_cost_api_url is absent', () => {
    const config = convertAWSExportsToConfig({ ...baseAwsExports });

    expect(config.costApiUrl).toBe('');
  });
});
