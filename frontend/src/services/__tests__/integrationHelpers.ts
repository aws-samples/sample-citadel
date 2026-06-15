/**
 * Integration Test Helpers
 * 
 * Utility functions for integration testing with real AppSync
 */

/**
 * Wait for a condition to become true
 * @param condition - Function that returns true when condition is met
 * @param timeout - Maximum time to wait in milliseconds
 * @param checkInterval - How often to check the condition in milliseconds
 */
export const waitFor = (
  condition: () => boolean,
  timeout: number = 5000,
  checkInterval: number = 100
): Promise<void> => {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      if (condition()) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - startTime > timeout) {
        clearInterval(interval);
        reject(new Error(`Timeout waiting for condition after ${timeout}ms`));
      }
    }, checkInterval);
  });
};

/**
 * Wait for a specific duration
 * @param ms - Milliseconds to wait
 */
export const wait = (ms: number): Promise<void> => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

/**
 * Wait for a specific number of messages to be received
 * @param messages - Array that will be populated with messages
 * @param expectedCount - Number of messages to wait for
 * @param timeout - Maximum time to wait in milliseconds
 */
export const waitForMessages = <T>(
  messages: T[],
  expectedCount: number,
  timeout: number = 5000
): Promise<void> => {
  return waitFor(() => messages.length >= expectedCount, timeout);
};

/**
 * Create a mock callback that tracks invocations
 */
export const createMockCallback = <T>() => {
  const calls: T[] = [];
  const callback = (data: T) => {
    calls.push(data);
  };
  return { callback, calls };
};

/**
 * Check if environment is configured for integration tests
 */
export const isIntegrationTestConfigured = (): boolean => {
  return !!(
    process.env.VITE_APPSYNC_ENDPOINT &&
    process.env.VITE_AWS_REGION &&
    process.env.VITE_APPSYNC_REGION
  );
};

/**
 * Get integration test configuration
 */
export const getIntegrationTestConfig = () => {
  return {
    region: process.env.VITE_AWS_REGION || 'ap-southeast-2',
    userPoolId: process.env.VITE_COGNITO_USER_POOL_ID || '',
    userPoolClientId: process.env.VITE_COGNITO_USER_POOL_CLIENT_ID || '',
    identityPoolId: process.env.VITE_COGNITO_IDENTITY_POOL_ID,
    appsyncEndpoint: process.env.VITE_APPSYNC_ENDPOINT || '',
    appsyncRegion: process.env.VITE_APPSYNC_REGION || 'ap-southeast-2',
    appsyncAuthenticationType: (process.env.VITE_APPSYNC_AUTH_TYPE || 'AMAZON_COGNITO_USER_POOLS') as any,
    appsyncApiKey: process.env.VITE_APPSYNC_API_KEY,
  };
};

/**
 * Retry a function with exponential backoff
 * @param fn - Function to retry
 * @param maxAttempts - Maximum number of attempts
 * @param initialDelay - Initial delay in milliseconds
 */
export const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  initialDelay: number = 1000
): Promise<T> => {
  let lastError: Error | undefined;
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt < maxAttempts - 1) {
        const delay = initialDelay * Math.pow(2, attempt);
        await wait(delay);
      }
    }
  }
  
  throw lastError || new Error('Retry failed');
};

/**
 * Create a timeout promise that rejects after a duration
 * @param ms - Milliseconds before timeout
 * @param message - Error message
 */
export const timeout = (ms: number, message: string = 'Operation timed out'): Promise<never> => {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
};

/**
 * Race a promise against a timeout
 * @param promise - Promise to race
 * @param ms - Timeout in milliseconds
 * @param message - Timeout error message
 */
export const withTimeout = <T>(
  promise: Promise<T>,
  ms: number,
  message?: string
): Promise<T> => {
  return Promise.race([
    promise,
    timeout(ms, message)
  ]);
};
