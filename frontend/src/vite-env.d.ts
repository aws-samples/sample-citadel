/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AWS_REGION: string;
  readonly VITE_COGNITO_USER_POOL_ID: string;
  readonly VITE_COGNITO_USER_POOL_CLIENT_ID: string;
  readonly VITE_COGNITO_IDENTITY_POOL_ID?: string;
  readonly VITE_APPSYNC_ENDPOINT: string;
  readonly VITE_APPSYNC_REGION: string;
  readonly VITE_APPSYNC_AUTH_TYPE: string;
  readonly VITE_APPSYNC_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// Global debug interface for subscription debugging (development mode only)
interface Window {
  __subscriptionDebug?: {
    getActiveSubscriptions(): Array<{
      eventType: string;
      subscriberCount: number;
    }>;
    getSubscriberCounts(): Array<{
      eventType: string;
      count: number;
    }>;
    getSubscriptionState(): {
      activeBackendConnections: number;
      totalLocalSubscribers: number;
      eventTypes: Array<{
        eventType: string;
        backendActive: boolean;
        localSubscribers: number;
      }>;
    };
    enableVerboseLogging(): void;
    disableVerboseLogging(): void;
    isVerboseLoggingEnabled(): boolean;
  };
}
