/**
 * Invoke Event Detail Builder
 *
 * Constructs the EventBridge event detail for app invoke requests.
 * Injects app-scoped headers and a unique requestId into the event detail
 * alongside the original request body.
 *
 * Requirements: 2.3, 2.4, 2.5, 2.6
 */
import { v4 as uuidv4 } from 'uuid';

export interface AppContext {
  appId: string;
  appName: string;
  groupId: string;
}

export interface InvokeEventDetail {
  body: Record<string, any>;
  headers: {
    'x-citadel-group-id': string;
    'x-citadel-app-name': string;
    'x-citadel-api-key-id': string;
    'x-citadel-timestamp': string;
  };
  requestId: string;
}

/**
 * Builds the EventBridge event detail for an app invoke request.
 *
 * @param requestBody - The original JSON request body
 * @param appContext - App context containing appId, appName, groupId
 * @param apiKeyId - The authenticated API key ID
 * @returns The constructed event detail with body, injected headers, and requestId
 */
export function buildInvokeEventDetail(
  requestBody: Record<string, any>,
  appContext: AppContext,
  apiKeyId: string,
): InvokeEventDetail {
  return {
    body: requestBody,
    headers: {
      'x-citadel-group-id': `APP#${appContext.appId}`,
      'x-citadel-app-name': appContext.appName,
      'x-citadel-api-key-id': apiKeyId,
      'x-citadel-timestamp': new Date().toISOString(),
    },
    requestId: uuidv4(),
  };
}
