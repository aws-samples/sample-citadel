/**
 * Seed Eval Suites — CloudFormation Custom Resource Lambda (CIT-101 §6).
 *
 * Loads two demo eval suites (Suite A: intake-agent, Suite B:
 * template:monolithic_db) into the eval tables on deployment. Follows the
 * seed-blueprints/index.ts pattern exactly: deterministic sha256 ids,
 * monotonic SEED_VERSION, heal SYSTEM seed rows on version bump, never
 * touch user rows.
 *
 * Seeds land in DRAFT (so the app can demo freeze), orgId='system',
 * createdBy='SYSTEM'.
 *
 * Data definitions (SEED_VERSION, SEED_EVAL_SUITES, types, and the content
 * fingerprint) live in ./definitions.ts — a data-only module that is safe
 * to import at CDK synth time (no AWS SDK instantiation).
 */

import * as https from "https";
import * as url from "url";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  CloudFormationCustomResourceEvent,
  CloudFormationCustomResourceHandler,
  Context,
} from "aws-lambda";
import { emitGovernanceEvent } from "../../utils/notifier-base";

// Re-export everything from definitions so existing consumers continue to work.
export {
  SEED_VERSION,
  deterministicId,
  SEED_EVAL_SUITES,
  computeSeedEvalSuitesFingerprint,
} from "./definitions";
export type { SeedSuiteDefinition, SeedCaseDefinition } from "./definitions";
import { SEED_VERSION, deterministicId, SEED_EVAL_SUITES } from "./definitions";
import type { SeedSuiteDefinition } from "./definitions";
import type {
  EvalCaseKindLiteral,
  MatchSpec,
  ExpectedPolicyOutcome,
  GroundingRequirement,
  TrajectorySpec,
} from "../../types";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const EVAL_SUITES_TABLE = process.env.EVAL_SUITES_TABLE!;
const EVAL_CASES_TABLE = process.env.EVAL_CASES_TABLE!;

/** DynamoDB row shape written for a seeded EvalSuite. */
export interface SeedSuiteItem {
  suiteId: string;
  orgId: string;
  agentTargetId: string;
  name: string;
  description: string;
  semver: string;
  status: string;
  version: number;
  references: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  seedVersion: number;
  gateClass?: string;
}

/** DynamoDB row shape written for a seeded EvalCase. */
export interface SeedCaseItem {
  suiteId: string;
  caseId: string;
  name: string;
  description: string;
  kind: EvalCaseKindLiteral;
  input: { prompt?: string; structuredInput?: string | null };
  expectedOutcome: MatchSpec;
  requiredTools: string[];
  forbiddenTools: string[];
  expectedPolicyOutcome?: ExpectedPolicyOutcome;
  maxLatencyMs?: number;
  maxCostUsd?: number;
  groundingRequirements?: GroundingRequirement[];
  trajectorySpec?: TrajectorySpec;
  provenance: { source: "AUTHORED"; producerCommit: null };
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  seedVersion: number;
}

export function buildSeedSuiteItem(
  suite: SeedSuiteDefinition,
  now: string,
): SeedSuiteItem {
  const suiteId = deterministicId(`citadel-seed-eval-suite:${suite.name}`);
  return {
    suiteId,
    orgId: "system",
    agentTargetId: suite.agentTargetId,
    name: suite.name,
    description: suite.description,
    semver: suite.semver,
    status: "DRAFT",
    version: 1,
    references: [],
    createdBy: "SYSTEM",
    createdAt: now,
    updatedAt: now,
    seedVersion: SEED_VERSION,
    ...(suite.gateClass !== undefined ? { gateClass: suite.gateClass } : {}),
  };
}

export function buildSeedCaseItems(
  suite: SeedSuiteDefinition,
  suiteId: string,
  now: string,
): SeedCaseItem[] {
  return suite.cases.map((c) => {
    const caseId = deterministicId(
      `citadel-seed-eval-case:${suite.name}:${c.name}`,
    );
    return {
      suiteId,
      caseId,
      name: c.name,
      description: c.description,
      kind: c.kind,
      input: c.input,
      expectedOutcome: c.expectedOutcome,
      requiredTools: c.requiredTools ?? [],
      forbiddenTools: c.forbiddenTools ?? [],
      expectedPolicyOutcome: c.expectedPolicyOutcome,
      maxLatencyMs: c.maxLatencyMs,
      maxCostUsd: c.maxCostUsd,
      groundingRequirements: c.groundingRequirements,
      trajectorySpec: c.trajectorySpec,
      provenance: { source: "AUTHORED", producerCommit: null },
      version: 1,
      createdBy: "SYSTEM",
      createdAt: now,
      updatedAt: now,
      seedVersion: SEED_VERSION,
    };
  });
}

/** Send CloudFormation Custom Resource response. */
async function sendCfnResponse(
  event: CloudFormationCustomResourceEvent,
  context: Context,
  status: "SUCCESS" | "FAILED",
  data: Record<string, unknown>,
): Promise<void> {
  const responseBody = JSON.stringify({
    Status: status,
    Reason: `See CloudWatch Log Stream: ${context.logStreamName}`,
    PhysicalResourceId: context.logStreamName,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    Data: data,
  });

  const parsedUrl = url.parse(event.ResponseURL);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: parsedUrl.hostname,
        port: 443,
        path: parsedUrl.path,
        method: "PUT",
        headers: {
          "Content-Type": "",
          "Content-Length": responseBody.length,
        },
      },
      () => resolve(),
    );
    req.on("error", reject);
    req.write(responseBody);
    req.end();
  });
}

/** Minimal shape read back from EVAL_SUITES_TABLE to classify a blocked heal. */
interface ExistingSuiteRow {
  status?: string;
  references?: string[];
}

/**
 * After a conditional PutCommand failure on a suite seed row, distinguish
 * "already current" (benign — the row's seedVersion already satisfies
 * SEED_VERSION, expected on every redeploy) from "blocked" (the row is
 * stale but FROZEN/ARCHIVED and/or referenced, so assertSuiteMutable's
 * invariant correctly refused the heal). Returns null for the benign case
 * so callers never notify on it.
 */
function classifyBlockedHeal(row: ExistingSuiteRow | null): {
  reason: "not_draft" | "referenced" | "not_draft_and_referenced";
  status: string;
  referenceCount: number;
} | null {
  if (!row) {
    // Row vanished between the failed conditional Put and the read —
    // treat as benign; nothing to notify about.
    return null;
  }
  const status = row.status ?? "UNKNOWN";
  const referenceCount = row.references?.length ?? 0;
  const isDraft = status === "DRAFT";
  const isReferenced = referenceCount > 0;

  if (isDraft && !isReferenced) {
    // Row is DRAFT and unreferenced but the Put still failed: the only
    // remaining reason under this ConditionExpression is that
    // seedVersion is already >= SEED_VERSION — the ordinary
    // already-current no-op every redeploy hits.
    return null;
  }

  const reason =
    !isDraft && isReferenced
      ? "not_draft_and_referenced"
      : !isDraft
        ? "not_draft"
        : "referenced";
  return { reason, status, referenceCount };
}

/**
 * Read the current row and, if it is genuinely blocked (not merely
 * already-current), log a structured BLOCKED line and emit exactly one
 * governance.eval.seed.heal.blocked notification for this suite.
 */
async function handleBlockedSuiteHeal(
  suiteId: string,
  suiteName: string,
): Promise<void> {
  const res = await docClient.send(
    new GetCommand({ TableName: EVAL_SUITES_TABLE, Key: { suiteId } }),
  );
  const row = (res.Item as ExistingSuiteRow | undefined) ?? null;
  const classification = classifyBlockedHeal(row);

  if (!classification) {
    console.log(
      `skipping: eval suite current (seedVersion >= ${SEED_VERSION}): ${suiteName}`,
    );
    return;
  }

  console.log(
    `BLOCKED: seed heal refused for eval suite "${suiteName}" (suiteId=${suiteId}) — ` +
      `status=${classification.status}, references=${classification.referenceCount}, ` +
      `reason=${classification.reason}. Row left untouched.`,
  );

  await emitGovernanceEvent("governance.eval.seed.heal.blocked", {
    suiteId,
    suiteName,
    status: classification.status,
    referenceCount: classification.referenceCount,
    reason: classification.reason,
    seedVersion: SEED_VERSION,
    attemptedSeedVersion: SEED_VERSION,
  });
}

export const handler: CloudFormationCustomResourceHandler = async (
  event,
  context,
) => {
  console.log("Event:", JSON.stringify(event));

  if (event.RequestType === "Delete") {
    await sendCfnResponse(event, context, "SUCCESS", {
      Message: "Nothing to clean up",
    });
    return;
  }

  try {
    const now = new Date().toISOString();
    let suitesSeeded = 0;
    let casesSeeded = 0;

    for (const suiteDef of SEED_EVAL_SUITES) {
      const suiteItem = buildSeedSuiteItem(suiteDef, now);

      try {
        // Upsert semantics: create when absent, heal SYSTEM seed rows that
        // predate the current SEED_VERSION — but ONLY when the existing
        // row is still DRAFT and unreferenced. A row that is FROZEN,
        // ARCHIVED, or carries any reference is a mutability-guarded row
        // under assertSuiteMutable (eval-resolver.ts) and must be left
        // completely untouched, even on a seed-version bump. User-created
        // suites never match a seed suiteId, so their rows are never
        // touched by this condition either way.
        const result = await docClient.send(
          new PutCommand({
            TableName: EVAL_SUITES_TABLE,
            Item: suiteItem,
            ConditionExpression:
              "attribute_not_exists(suiteId) OR ((attribute_not_exists(seedVersion) OR seedVersion < :v) AND #status = :draft AND size(#refs) = :zero)",
            ExpressionAttributeNames: {
              "#status": "status",
              "#refs": "references",
            },
            ExpressionAttributeValues: {
              ":v": SEED_VERSION,
              ":draft": "DRAFT",
              ":zero": 0,
            },
            ReturnValues: "ALL_OLD",
          }),
        );
        if (result.Attributes) {
          console.log(
            `Updated outdated seed eval suite (seedVersion -> ${SEED_VERSION}): ${suiteDef.name}`,
          );
        } else {
          console.log(`Created eval suite: ${suiteDef.name}`);
        }
        suitesSeeded += 1;
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          err.name === "ConditionalCheckFailedException"
        ) {
          await handleBlockedSuiteHeal(suiteItem.suiteId, suiteDef.name);
          continue;
        }
        throw err;
      }

      const caseItems = buildSeedCaseItems(suiteDef, suiteItem.suiteId, now);
      for (const caseItem of caseItems) {
        try {
          const result = await docClient.send(
            new PutCommand({
              TableName: EVAL_CASES_TABLE,
              Item: caseItem,
              ConditionExpression:
                "attribute_not_exists(caseId) OR attribute_not_exists(seedVersion) OR seedVersion < :v",
              ExpressionAttributeValues: { ":v": SEED_VERSION },
              ReturnValues: "ALL_OLD",
            }),
          );
          if (result.Attributes) {
            console.log(
              `Updated outdated seed eval case (seedVersion -> ${SEED_VERSION}): ${caseItem.name}`,
            );
          } else {
            console.log(`Created eval case: ${caseItem.name}`);
          }
          casesSeeded += 1;
        } catch (err: unknown) {
          if (
            err instanceof Error &&
            err.name === "ConditionalCheckFailedException"
          ) {
            console.log(
              `skipping: eval case current (seedVersion >= ${SEED_VERSION}): ${caseItem.name}`,
            );
            continue;
          }
          throw err;
        }
      }
    }

    await sendCfnResponse(event, context, "SUCCESS", {
      Message: "Eval suites seeded successfully",
      SuitesSeeded: suitesSeeded,
      CasesSeeded: casesSeeded,
    });
  } catch (err: unknown) {
    console.error("Error seeding eval suites:", err);
    await sendCfnResponse(event, context, "FAILED", {
      Message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
};
