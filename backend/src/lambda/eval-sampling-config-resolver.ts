/**
 * eval-sampling-config-resolver (Phase 2 §2.1) — admin-only GraphQL
 * resolver for EvalSamplingConfig storage/reads, and read-only
 * listEvalProdSamples for the governance/observability UI.
 *
 * ADMIN-ONLY, not eval:approve: this toggle controls whether PRODUCTION
 * traffic gets sampled and PII-sanitized-but-real customer conversations
 * get written to S3 and judged. That is a platform-wide data-handling
 * decision, not a per-suite governance action — so it is gated on
 * `authContext.roles.includes("admin")` directly, deliberately stricter
 * than the eval:author/eval:approve permissions used by eval-resolver.ts
 * for suite/case authoring. Org opt-in is the ONLY way sampling activates
 * for that org (design invariant, enforced independently again in
 * eval-sampling-config.ts's resolveEffectiveRate on the read side).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  AuthContext,
  EvalSamplingConfig,
  EvalSamplingConfigInput,
} from "../types";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const EVAL_SAMPLING_CONFIG_TABLE = process.env.EVAL_SAMPLING_CONFIG_TABLE!;
const EVAL_PROD_SAMPLES_TABLE = process.env.EVAL_PROD_SAMPLES_TABLE!;

function requireAdmin(authContext: AuthContext, action: string): void {
  if (!authContext.roles?.includes("admin")) {
    throw new Error(`UnauthorizedError: admin role required to ${action}`);
  }
}

function clampRate(rate: number): number {
  if (typeof rate !== "number" || Number.isNaN(rate)) return 0;
  return Math.min(1, Math.max(0, rate));
}

export async function setEvalSamplingConfig(
  orgId: string,
  input: EvalSamplingConfigInput,
  authContext: AuthContext,
): Promise<EvalSamplingConfig> {
  requireAdmin(authContext, "modify eval sampling configuration");

  const perAgentSampleRate: Record<string, number> = {};
  for (const [agentId, rate] of Object.entries(
    input.perAgentSampleRate ?? {},
  )) {
    perAgentSampleRate[agentId] = clampRate(rate);
  }

  const config: EvalSamplingConfig = {
    orgId,
    optIn: input.optIn === true,
    defaultSampleRate: clampRate(input.defaultSampleRate),
    perAgentSampleRate,
    updatedAt: new Date().toISOString(),
    updatedBy: authContext.userId,
  };

  await docClient.send(
    new PutCommand({ TableName: EVAL_SAMPLING_CONFIG_TABLE, Item: config }),
  );

  return config;
}

export async function getEvalSamplingConfig(
  orgId: string,
  authContext: AuthContext,
): Promise<EvalSamplingConfig | undefined> {
  requireAdmin(authContext, "read eval sampling configuration");

  const res = await docClient.send(
    new GetCommand({ TableName: EVAL_SAMPLING_CONFIG_TABLE, Key: { orgId } }),
  );
  return res.Item as EvalSamplingConfig | undefined;
}

export interface EvalProdSampleRow {
  orgId: string;
  runId: string;
  sampleId: string;
  agentId: string;
  kind: "EXECUTION" | "CONVERSATION" | string;
  artifactRef: string;
  scoreVector?: string;
  capturedAt: string;
}

/**
 * Lists production samples for an org (base-table Query, PK=ORG#<orgId>
 * — same org-isolation-lives-in-the-key-condition discipline as
 * cost-query-handler.ts). Optional `agentId` filter is applied
 * client-side over the Queried page (small per-org volume expected;
 * a dedicated per-agent GSI Query is available via AgentDimTimeIndex
 * when that becomes a hot path).
 *
 * M1 fix (taskId 316427f2): `EvalProdSample.kind` is typed
 * `EvalCaseKind!` in the GraphQL schema (enum `EXECUTION`/`CONVERSATION`),
 * but rows are written with the lowercase `ReplayKind`
 * (`"execution"`/`"conversation"`) coming straight off the sampled event
 * (eval-sample-scorer.ts writes `kind: detail.kind`). AppSync enum
 * serialization would reject/blank an unrecognized lowercase value, so
 * every row is normalized to the uppercase enum value on read here.
 */
function normalizeKind(kind: string): "EXECUTION" | "CONVERSATION" | string {
  const upper = kind.toUpperCase();
  return upper === "EXECUTION" || upper === "CONVERSATION" ? upper : kind;
}

export async function listEvalProdSamples(
  orgId: string,
  agentId: string | undefined,
  authContext: AuthContext,
): Promise<EvalProdSampleRow[]> {
  requireAdmin(authContext, "read eval production samples");

  const res = await docClient.send(
    new QueryCommand({
      TableName: EVAL_PROD_SAMPLES_TABLE,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": `ORG#${orgId}` },
    }),
  );
  const items = (res.Items as EvalProdSampleRow[] | undefined) ?? [];
  const normalized = items.map((r) => ({ ...r, kind: normalizeKind(r.kind) }));
  return agentId ? normalized.filter((r) => r.agentId === agentId) : normalized;
}

interface EvalSamplingConfigResolverArguments {
  orgId: string;
  agentId?: string;
  input: EvalSamplingConfigInput;
}

interface EvalSamplingConfigResolverEvent {
  info?: { fieldName?: string };
  identity?: {
    sub?: string;
    username?: string;
    ["cognito:groups"]?: string[];
    claims?: Record<string, string>;
    ["custom:role"]?: string;
  };
  arguments: EvalSamplingConfigResolverArguments;
}

function authContextFromEvent(
  event: EvalSamplingConfigResolverEvent,
): AuthContext {
  const identity = event?.identity || {};
  const claimRole = identity["custom:role"] ?? identity.claims?.["custom:role"];
  return {
    userId: identity.sub || identity.username || "anonymous",
    username: identity.username,
    groups: identity["cognito:groups"] || [],
    roles: claimRole ? [claimRole] : [],
  };
}

export const handler = async (
  event: EvalSamplingConfigResolverEvent,
): Promise<unknown> => {
  const fieldName = event?.info?.fieldName;
  const authContext = authContextFromEvent(event);
  switch (fieldName) {
    case "setEvalSamplingConfig":
      return await setEvalSamplingConfig(
        event.arguments.orgId,
        event.arguments.input,
        authContext,
      );
    case "getEvalSamplingConfig":
      return await getEvalSamplingConfig(event.arguments.orgId, authContext);
    case "listEvalProdSamples":
      return await listEvalProdSamples(
        event.arguments.orgId,
        event.arguments.agentId,
        authContext,
      );
    default:
      throw new Error(`Unknown field: ${fieldName}`);
  }
};
