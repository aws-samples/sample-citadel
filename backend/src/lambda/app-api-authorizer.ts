/**
 * App API Authorizer — Lambda authorizer for per-app API Gateway endpoints.
 *
 * Validates x-api-key header against hashed API key records in DynamoDB.
 * Uses API Gateway Lambda authorizer v2 format (simple response).
 *
 * Authorization flow:
 * 1. Extract appId from stage variables
 * 2. Compute HMAC-SHA-256 of the provided x-api-key using the server-side
 *    pepper (fail closed / deny if the pepper is unavailable)
 * 3. Query GroupIndex for APIKEY# items under APP#{appId}
 * 4. Match by hashedKey: records with `hashAlg` set compare against the
 *    HMAC digest; records without `hashAlg` (pre-migration legacy records)
 *    compare against the legacy plain-SHA-256 digest. This dual-read is a
 *    time-boxed migration bridge (~90 days) — plaintext for legacy keys
 *    cannot be re-derived, so in-place rehashing is not possible. All
 *    comparisons use a timing-safe equality check.
 * 5. Check status === ACTIVE and not expired
 * 6. Return { isAuthorized: true/false }
 * 7. Update lastUsedAt asynchronously (best-effort)
 * 8. Log all attempts for audit
 *
 * Requirements: 3.2, 3.3, 3.4, 3.8, 3.9
 */
import { timingSafeEqual } from "crypto";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  hashApiKey,
  legacyHashApiKey,
  getApiKeyPepper,
} from "../utils/api-key-hash";

// ── Types ───────────────────────────────────────────────────

export interface AuthorizerEvent {
  headers?: Record<string, string | undefined>;
  requestContext?: {
    http?: { sourceIp?: string };
    stage?: string;
    apiId?: string;
  };
  stageVariables?: Record<string, string>;
}

export interface SimpleAuthorizerResult {
  isAuthorized: boolean;
  context?: Record<string, string>;
}

export interface AuditLogEntry {
  appId: string;
  apiKeyId: string;
  sourceIp: string;
  timestamp: string;
  result: "allow" | "deny";
}

// ── SDK Client (lazy-initialized) ───────────────────────────

const APPS_TABLE = process.env.APPS_TABLE || "citadel-apps-dev";

let _docClient: DynamoDBDocumentClient | undefined;

function getDocClient(): DynamoDBDocumentClient {
  if (!_docClient)
    _docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return _docClient;
}

// ── Audit Logger ────────────────────────────────────────────

function logAudit(entry: AuditLogEntry): void {
  console.log(JSON.stringify(entry));
}

// ── Authorization Decision (pure logic) ─────────────────────

/**
 * Constant-time comparison of two hex digest strings. Returns false (not a
 * throw) on length mismatch — timingSafeEqual requires equal-length buffers,
 * and a length mismatch is itself not a valid match.
 */
function timingSafeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Matches an API key item against the provided x-api-key using the
 * appropriate digest for that item's storage generation:
 * - `hashAlg` present → new HMAC-SHA-256-with-pepper record.
 * - `hashAlg` absent → legacy plain-SHA-256 record (dual-read window).
 * Comparisons are timing-safe.
 */
function matchesApiKey(
  item: { hashedKey?: string; hashAlg?: string },
  hmacDigest: string,
  legacyDigest: string,
): boolean {
  if (!item.hashedKey) return false;
  const expected = item.hashAlg ? hmacDigest : legacyDigest;
  return timingSafeHexEqual(item.hashedKey, expected);
}

/**
 * Pure authorization decision based on key status and expiry.
 * Returns 'allow' if key is ACTIVE and not expired, 'deny' otherwise.
 * This function has no side effects and depends only on key state.
 */
export function evaluateKeyAuthorization(
  matchedKey:
    | { status: string; expiresAt?: string; keyId?: string }
    | undefined,
): "allow" | "deny" {
  if (!matchedKey) return "deny";
  if (matchedKey.status !== "ACTIVE") return "deny";
  if (matchedKey.expiresAt && new Date(matchedKey.expiresAt) <= new Date())
    return "deny";
  return "allow";
}

// ── Handler ─────────────────────────────────────────────────

/**
 * Lambda authorizer handler (v2 simple response format).
 *
 * Extracts appId from stage variables, hashes the x-api-key,
 * queries DynamoDB for matching APIKEY# items, and returns
 * isAuthorized based on key status and expiry.
 */
export const handler = async (
  event: AuthorizerEvent,
  _context?: unknown,
  deps: { docClient?: DynamoDBDocumentClient; appsTable?: string } = {},
): Promise<SimpleAuthorizerResult> => {
  const docClient = deps.docClient || getDocClient();
  const appsTable = deps.appsTable || APPS_TABLE;
  const appId = event.stageVariables?.appId || "";
  const sourceIp = event.requestContext?.http?.sourceIp || "unknown";
  const apiKey = event.headers?.["x-api-key"];

  // Missing or empty x-api-key → 401 Unauthorized
  if (!apiKey) {
    logAudit({
      appId,
      apiKeyId: "unknown",
      sourceIp,
      timestamp: new Date().toISOString(),
      result: "deny",
    });
    throw new Error("Unauthorized");
  }

  // Compute the HMAC digest (requires the server-side pepper) and the
  // legacy plain-SHA-256 digest (dual-read window only — never used for
  // new records). Fail closed if the pepper is unavailable: we cannot
  // safely evaluate HMAC-generation records without it, and proceeding
  // would silently exclude those records from matching.
  let hmacDigest: string;
  const legacyDigest = legacyHashApiKey(apiKey);
  try {
    const pepper = await getApiKeyPepper();
    hmacDigest = hashApiKey(apiKey, pepper);
  } catch (error) {
    logAudit({
      appId,
      apiKeyId: "unknown",
      sourceIp,
      timestamp: new Date().toISOString(),
      result: "deny",
    });
    console.error("app-api-authorizer: pepper unavailable, failing closed", {
      appId,
      err: error instanceof Error ? error.message : String(error),
    });
    return { isAuthorized: false };
  }

  try {
    // Query GroupIndex for APIKEY# items under APP#{appId}
    const result = await docClient.send(
      new QueryCommand({
        TableName: appsTable,
        IndexName: "GroupIndex",
        KeyConditionExpression: "groupId = :gid AND begins_with(sortId, :sk)",
        ExpressionAttributeValues: {
          ":gid": `APP#${appId}`,
          ":sk": "APIKEY#",
        },
      }),
    );

    const items = result.Items || [];

    // Find matching key: HMAC digest for hashAlg-tagged records, legacy
    // SHA-256 digest for pre-migration records without hashAlg.
    const matchedKey = items.find((item) =>
      matchesApiKey(item, hmacDigest, legacyDigest),
    ) as
      | {
          status: string;
          expiresAt?: string;
          keyId?: string;
          appId?: string;
          hashAlg?: string;
        }
      | undefined;

    // Evaluate authorization using pure decision logic
    const decision = evaluateKeyAuthorization(matchedKey);

    logAudit({
      appId,
      apiKeyId: matchedKey?.keyId || "unknown",
      sourceIp,
      timestamp: new Date().toISOString(),
      result: decision,
    });

    if (decision === "deny") {
      return { isAuthorized: false };
    }

    // Best-effort async update of lastUsedAt
    docClient
      .send(
        new UpdateCommand({
          TableName: appsTable,
          Key: { appId: matchedKey!.appId },
          UpdateExpression: "SET lastUsedAt = :now",
          ExpressionAttributeValues: {
            ":now": new Date().toISOString(),
          },
        }),
      )
      .catch(() => {
        // Best-effort — swallow errors silently
      });

    return {
      isAuthorized: true,
      context: {
        appId,
        apiKeyId: matchedKey!.keyId as string,
      },
    };
  } catch {
    // DynamoDB failure → fail closed (deny)
    logAudit({
      appId,
      apiKeyId: "unknown",
      sourceIp,
      timestamp: new Date().toISOString(),
      result: "deny",
    });
    return { isAuthorized: false };
  }
};
