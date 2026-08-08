/**
 * appsync-client.ts — minimal AppSync GraphQL HTTP client.
 *
 * Deliberately NOT using an AppSync/Amplify SDK: the backend package has
 * no server-side GraphQL client dependency (frontend uses Amplify with a
 * browser-only config), and pulling one in for a single-purpose smoke
 * script would be a new dependency for a handful of POST calls. Node 22+
 * ships a native `fetch`, which is all a Cognito-user-pool-authorized
 * AppSync request needs: an `Authorization: <idToken>` header (AppSync's
 * COGNITO_USER_POOLS auth mode reads the raw JWT directly, no SigV4).
 */

import { readRequiredEnv } from "./env";

export interface GraphQLError {
  message: string;
  errorType?: string;
  path?: (string | number)[];
}

export class AppSyncRequestError extends Error {
  constructor(
    message: string,
    public readonly errors: GraphQLError[],
  ) {
    super(message);
    this.name = "AppSyncRequestError";
  }
}

/**
 * Issues one GraphQL request (query or mutation) against the deployment's
 * AppSync endpoint, authenticated as the caller identified by `idToken`
 * (from env.cognitoAuth()). Throws AppSyncRequestError with the full
 * GraphQL errors array on any `errors` field in the response — callers
 * must not silently ignore a partial-success/error response.
 */
export async function appsyncRequest<T>(
  idToken: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const endpoint = readRequiredEnv("GRAPHQL_API_URL");

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: idToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "<unreadable body>");
    throw new Error(
      `AppSync request failed with HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  }

  const body = (await res.json()) as { data?: T; errors?: GraphQLError[] };

  if (body.errors && body.errors.length > 0) {
    throw new AppSyncRequestError(
      `AppSync returned ${body.errors.length} error(s): ` +
        body.errors.map((e) => e.message).join("; "),
      body.errors,
    );
  }

  if (body.data === undefined) {
    throw new Error(
      "AppSync response had neither `data` nor `errors` — unexpected shape.",
    );
  }

  return body.data;
}
