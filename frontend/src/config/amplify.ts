/**
 * Amplify Configuration Loader
 * Loads AWS configuration from aws-exports.json or environment variables
 */

import serverService from '../services/server';

interface AWSExports {
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
}

/**
 * Load AWS configuration from aws-exports.json file
 */
async function loadAWSExports(): Promise<AWSExports | null> {
  try {
    const response = await fetch('/aws-exports.json');
    if (!response.ok) {
      console.warn('aws-exports.json not found, falling back to environment variables');
      return null;
    }
    const config = await response.json();
    return config;
  } catch (error) {
    console.warn('Failed to load aws-exports.json:', error);
    return null;
  }
}

/**
 * Get configuration from environment variables
 */
function getEnvConfig() {
  if (!import.meta.env.VITE_AWS_REGION) {
    return null;
  }

  return {
    region: import.meta.env.VITE_AWS_REGION,
    userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID || '',
    userPoolClientId: import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID || '',
    identityPoolId: import.meta.env.VITE_COGNITO_IDENTITY_POOL_ID,
    appsyncEndpoint: import.meta.env.VITE_APPSYNC_ENDPOINT || '',
    appsyncRegion: import.meta.env.VITE_APPSYNC_REGION || import.meta.env.VITE_AWS_REGION,
    appsyncAuthenticationType: (import.meta.env.VITE_APPSYNC_AUTH_TYPE as any) || 'AMAZON_COGNITO_USER_POOLS',
    appsyncApiKey: import.meta.env.VITE_APPSYNC_API_KEY,
    environment: import.meta.env.VITE_ENVIRONMENT,
    eventBusUrl: import.meta.env.VITE_EVENT_BUS_URL || '',
  };
}

/**
 * Convert AWS exports format to Amplify config format
 */
function convertAWSExportsToConfig(awsExports: AWSExports) {
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
  };
}

/**
 * Initialize Amplify configuration
 * Priority: aws-exports.json > environment variables
 */
export async function initializeAmplify(): Promise<boolean> {
  try {
    // Try to load from aws-exports.json first
    const awsExports = await loadAWSExports();
    
    if (awsExports) {
      const config = convertAWSExportsToConfig(awsExports);
      serverService.configure(config);
      console.log('Amplify configured from aws-exports.json');
      return true;
    }

    // Fall back to environment variables
    const envConfig = getEnvConfig();
    if (envConfig) {
      serverService.configure(envConfig);
      console.log('Amplify configured from environment variables');
      return true;
    }

    console.error('No AWS configuration found. Please provide aws-exports.json or environment variables.');
    return false;
  } catch (error) {
    console.error('Failed to initialize Amplify:', error);
    return false;
  }
}

export { serverService };
