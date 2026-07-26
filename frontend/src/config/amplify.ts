/**
 * Amplify Configuration Loader
 * Loads AWS configuration from aws-exports.json or environment variables
 */

import serverService from '../services/server';
import { convertAWSExportsToConfig, type AWSExports } from './awsExportsConfig';

export { convertAWSExportsToConfig, type AWSExports };

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
    costApiUrl: import.meta.env.VITE_COST_API_URL || '',
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
