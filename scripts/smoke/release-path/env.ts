/**
 * env.ts — operator-identity + configuration surface for the release-path
 * smoke fixture harness.
 *
 * NON-NEGOTIABLE constraint: this harness must NEVER create Cognito
 * users, IAM roles, or other principals. The one-time operator step
 * (provisioning the dedicated dev fixture Cognito user described in the
 * approved design) is documented in RUNBOOK.md; this module's job is
 * ONLY to read the already-provisioned identity/credentials from the
 * environment and fail with a clear, actionable message when they are
 * absent — never to provision them itself.
 */

export const REQUIRED_ENV = [
  "AWS_REGION",
  "GRAPHQL_API_URL",
  "USER_POOL_ID",
  "USER_POOL_CLIENT_ID",
  "SMOKE_FIXTURE_USERNAME",
  "SMOKE_FIXTURE_PASSWORD",
  "EVAL_RUNS_TABLE",
  "SMOKE_GOVERNANCE_TRANSCRIPTS_BUCKET_NAME",
  "ENVIRONMENT_RELEASE_POINTERS_TABLE",
] as const;

export type RequiredEnvVar = (typeof REQUIRED_ENV)[number];

/**
 * Reads a required env var or throws a clear, actionable error naming
 * BOTH the missing variable and the RUNBOOK section that explains how to
 * provision it — never falls back to a guessed default for anything
 * identity- or infra-shaped.
 */
export function readRequiredEnv(name: RequiredEnvVar | string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. This harness never ` +
        `provisions identities or infrastructure itself — see ` +
        `scripts/smoke/release-path/RUNBOOK.md ("One-time operator setup") ` +
        `for how to create the dedicated fixture Cognito user and how to ` +
        `discover the remaining values (GraphQL endpoint, table names, ` +
        `user pool ids) from your dev deployment's CloudFormation outputs.`,
    );
  }
  return value;
}

/** Fails fast (before any network call) if ANY required env var is
 * absent, listing every missing one in a single actionable error rather
 * than failing piecemeal one variable at a time. */
export function assertEnvComplete(): void {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `This harness never provisions identities or infrastructure itself ` +
        `— see scripts/smoke/release-path/RUNBOOK.md ("One-time operator ` +
        `setup") before running against a dev deployment.`,
    );
  }
}

let cachedToken: { token: string; expiresAt: number } | null = null;

/**
 * Authenticates as the pre-provisioned dedicated fixture Cognito user via
 * USER_PASSWORD_AUTH and returns a fresh (or cached-if-still-valid) ID
 * token. NEVER creates the user, a client, or any IAM principal — if
 * InitiateAuth fails because the user/credentials/pool don't exist, the
 * underlying Cognito error is rethrown with a pointer to RUNBOOK.md
 * rather than this script attempting to self-heal by creating one.
 */
export async function cognitoAuth(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }

  assertEnvComplete();

  const {
    CognitoIdentityProviderClient,
    InitiateAuthCommand,
  } = require("@aws-sdk/client-cognito-identity-provider") as typeof import("@aws-sdk/client-cognito-identity-provider");

  const client = new CognitoIdentityProviderClient({
    region: readRequiredEnv("AWS_REGION"),
  });

  let response;
  try {
    response = await client.send(
      new InitiateAuthCommand({
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: readRequiredEnv("USER_POOL_CLIENT_ID"),
        AuthParameters: {
          USERNAME: readRequiredEnv("SMOKE_FIXTURE_USERNAME"),
          PASSWORD: readRequiredEnv("SMOKE_FIXTURE_PASSWORD"),
        },
      }),
    );
  } catch (err) {
    throw new Error(
      `Cognito authentication failed for the dedicated fixture user ` +
        `(SMOKE_FIXTURE_USERNAME). This harness never creates that user — ` +
        `see RUNBOOK.md ("One-time operator setup") to provision it with ` +
        `custom:role=architect and custom:organization=SMOKE-RELEASE-FIXTURE-ORG. ` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const idToken = response.AuthenticationResult?.IdToken;
  if (!idToken) {
    throw new Error(
      "Cognito USER_PASSWORD_AUTH did not return an IdToken (possibly an " +
        "MFA or NEW_PASSWORD_REQUIRED challenge). See RUNBOOK.md — the " +
        "fixture user must be created with a permanent password and no MFA.",
    );
  }

  const expiresInSec = response.AuthenticationResult?.ExpiresIn ?? 3600;
  cachedToken = {
    token: idToken,
    // Refresh a little early rather than racing the exact expiry.
    expiresAt: Date.now() + (expiresInSec - 60) * 1000,
  };
  return idToken;
}
