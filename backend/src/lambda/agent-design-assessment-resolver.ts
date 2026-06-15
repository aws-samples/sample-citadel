/**
 * AgentDesignAssessment resolver.
 *
 * Implements the startAgentDesignAssessment / submitAgentDesignAssessment
 * mutations and the getAgentDesignAssessment query against the
 * citadel-agent-design-assessments-{env} table, with a mirror-write onto
 * the citadel-projects-{env} table's archetype/archetypeConfidence/
 * archetypeStatus columns as part of the same DynamoDB transaction.
 *
 * Four-dimension contract (PLAN_GOV_FUTURE_STATE.md §3.1, locked by QT2A-8):
 *   dimensionRanking MUST contain EXACTLY 4 entries whose `dimension` values
 *   are a permutation of {CODE, DATA, INTEGRATION, INFRASTRUCTURE} and whose
 *   `rank` values form EXACTLY the set {1,2,3,4}. These invariants are
 *   validated at the resolver so the fail-closed behaviour matches the
 *   schema-level allowlist AC #4 on the backlog.
 *
 * Re-submission guard:
 *   Once completedAt is non-null the row is considered terminal. A second
 *   submit is rejected both:
 *     (a) client-side via an explicit `completedAt !== null` check AFTER
 *         the GetCommand — gives a clear error message; and
 *     (b) DDB-side via `ConditionExpression: attribute_not_exists(completedAt)`
 *         inside the TransactWriteCommand, which catches concurrent
 *         double-submits that race past (a) with a
 *         ConditionalCheckFailedException.
 *
 * Permission model:
 *   Mutations gated on `assessment:submit` (grant added to the architect
 *   and project_manager roles by auth.ts edit). Reads are
 *   open — matches execspec/adr resolvers' getter pattern.
 *
 * EventBridge:
 *   On successful submit we emit `governance.archetype.classified` with the
 *   payload `{projectId, archetype, archetypeConfidence}` (the field name
 *   `archetypeConfidence` matches the typed DetailPayloadOf map in
 *   notifier-base.ts — the catalog entry is the source of truth).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { emitGovernanceEvent } from '../utils/notifier-base';
import { hasPermission } from '../utils/auth';
import type {
  AuthContext,
  AgentDesignAssessment,
  SubmitAgentDesignAssessmentInput,
  DimensionComplexityInput,
  FourDimensionLiteral,
} from '../types';
import { ProjectArchetypeStatus } from '../types';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const ASSESS_TABLE = process.env.AGENT_DESIGN_ASSESSMENTS_TABLE!;
const PROJECTS_TABLE = process.env.PROJECTS_TABLE!;

// The four canonical dimensions (QT2A-8). Frozen at four; ambiguous projects
// escalate via archetypeStatus=PENDING_ESCALATION instead of introducing an
// OTHER escape hatch.
const FOUR_DIMENSIONS: readonly FourDimensionLiteral[] = [
  'CODE',
  'DATA',
  'INTEGRATION',
  'INFRASTRUCTURE',
];
const EXPECTED_RANKS = [1, 2, 3, 4];

function authContextFromEvent(event: any): AuthContext {
  const identity = event?.identity || {};
  const claimRole = identity['custom:role'] ?? identity.claims?.['custom:role'];
  return {
    userId: identity.sub || identity.username || 'anonymous',
    username: identity.username,
    groups: identity['cognito:groups'] || [],
    roles: claimRole ? [claimRole] : [],
  };
}

/**
 * Truncate long string values in event.arguments so that error logs cannot
 * be weaponised to exfiltrate long payloads. Non-string values pass through.
 * Mirrors the shape in adr-resolver.ts / execspec-resolver.ts.
 */
function sanitizeForLog(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v;
  }
  return out;
}

function requireAssessmentSubmitPermission(
  authContext: AuthContext,
  action: string,
): void {
  if (!hasPermission(authContext, 'assessment:submit')) {
    throw new Error(
      `UnauthorizedError: assessment:submit permission required to ${action}`,
    );
  }
}

function validateDimensionRanking(
  ranking: DimensionComplexityInput[],
): void {
  if (!Array.isArray(ranking) || ranking.length !== 4) {
    throw new Error(
      'ValidationError: dimensionRanking must have exactly 4 entries',
    );
  }

  // Ranks must form exactly {1,2,3,4} (sorted ascending).
  const ranks = ranking.map((r) => r.rank).sort((a, b) => a - b);
  if (
    ranks.length !== 4 ||
    ranks.some((r, i) => r !== EXPECTED_RANKS[i])
  ) {
    throw new Error(
      'ValidationError: dimensionRanking ranks must form exactly the set {1,2,3,4}',
    );
  }

  // Dimensions must be a permutation of the four canonical values.
  const dims = new Set(ranking.map((r) => r.dimension));
  if (
    dims.size !== 4 ||
    !FOUR_DIMENSIONS.every((d) => dims.has(d))
  ) {
    throw new Error(
      'ValidationError: dimensionRanking dimensions must be exactly {CODE, DATA, INTEGRATION, INFRASTRUCTURE} with each appearing once',
    );
  }

  // Each rationale must be a non-empty trimmed string.
  for (const entry of ranking) {
    if (
      typeof entry.rationale !== 'string' ||
      entry.rationale.trim().length === 0
    ) {
      throw new Error(
        'ValidationError: each dimensionRanking entry must have a non-empty rationale',
      );
    }
  }
}

export async function startAgentDesignAssessment(
  projectId: string,
  authContext: AuthContext,
): Promise<AgentDesignAssessment> {
  requireAssessmentSubmitPermission(
    authContext,
    'start agent design assessments',
  );

  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new Error('ValidationError: projectId is required');
  }

  const now = new Date().toISOString();
  const row: AgentDesignAssessment = {
    projectId,
    archetype: null,
    archetypeConfidence: null,
    archetypeStatus: ProjectArchetypeStatus.PENDING,
    dimensionRanking: [],
    accessibleDataSources: [],
    primaryRiskAreas: [],
    completedAt: null,
    completedBy: null,
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: ASSESS_TABLE,
      Item: row,
      ConditionExpression: 'attribute_not_exists(projectId)',
    }),
  );
  return row;
}

export async function getAgentDesignAssessment(
  projectId: string,
): Promise<AgentDesignAssessment | null> {
  const res = await docClient.send(
    new GetCommand({ TableName: ASSESS_TABLE, Key: { projectId } }),
  );
  return (res.Item as AgentDesignAssessment | undefined) ?? null;
}

export async function submitAgentDesignAssessment(
  input: SubmitAgentDesignAssessmentInput,
  authContext: AuthContext,
): Promise<AgentDesignAssessment> {
  // Step 1: perm gate FIRST — no DDB, no event, before any state work.
  requireAssessmentSubmitPermission(
    authContext,
    'submit agent design assessments',
  );

  // Step 2: eager input validation.
  if (typeof input?.projectId !== 'string' || input.projectId.length === 0) {
    throw new Error('ValidationError: projectId is required');
  }
  validateDimensionRanking(input.dimensionRanking);
  if (
    !Array.isArray(input.accessibleDataSources) ||
    input.accessibleDataSources.length === 0
  ) {
    throw new Error(
      'ValidationError: accessibleDataSources must contain at least one entry',
    );
  }
  if (
    !Array.isArray(input.primaryRiskAreas) ||
    input.primaryRiskAreas.length === 0
  ) {
    throw new Error(
      'ValidationError: primaryRiskAreas must contain at least one entry',
    );
  }

  // Step 3: existing-row guards.
  const existing = await getAgentDesignAssessment(input.projectId);
  if (!existing) {
    throw new Error(
      'AgentDesignAssessment not found — call startAgentDesignAssessment first',
    );
  }
  if (existing.completedAt !== null && existing.completedAt !== undefined) {
    throw new Error(
      'Assessment already completed — re-submission not permitted',
    );
  }

  // Step 4: atomic two-table write — assessments row + projects mirror.
  const now = new Date().toISOString();
  const archetypeConfidence = input.archetypeConfidence ?? 1.0;

  await docClient.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Update: {
            TableName: ASSESS_TABLE,
            Key: { projectId: input.projectId },
            UpdateExpression:
              'SET archetype = :archetype,' +
              ' archetypeConfidence = :conf,' +
              ' archetypeStatus = :classified,' +
              ' dimensionRanking = :ranking,' +
              ' accessibleDataSources = :sources,' +
              ' primaryRiskAreas = :risks,' +
              ' completedAt = :now,' +
              ' completedBy = :userId,' +
              ' updatedAt = :now',
            // DDB-side re-submission guard — catches concurrent double-submit
            // that raced past the client-side `completedAt !== null` check.
            ConditionExpression: 'attribute_not_exists(completedAt)',
            ExpressionAttributeValues: {
              ':archetype': input.archetype,
              ':conf': archetypeConfidence,
              ':classified': ProjectArchetypeStatus.CLASSIFIED,
              ':ranking': input.dimensionRanking,
              ':sources': input.accessibleDataSources,
              ':risks': input.primaryRiskAreas,
              ':now': now,
              ':userId': authContext.userId,
            },
          },
        },
        {
          Update: {
            TableName: PROJECTS_TABLE,
            Key: { id: input.projectId },
            UpdateExpression:
              'SET archetype = :archetype,' +
              ' archetypeConfidence = :conf,' +
              ' archetypeStatus = :classified,' +
              ' updatedAt = :now',
            ExpressionAttributeValues: {
              ':archetype': input.archetype,
              ':conf': archetypeConfidence,
              ':classified': ProjectArchetypeStatus.CLASSIFIED,
              ':now': now,
            },
          },
        },
      ],
    }),
  );

  // Step 5: emit governance event AFTER the successful commit.
  // The typed DetailPayloadOf map in notifier-base.ts uses `confidence`
  // as the payload field name for this detail-type ( catalog,
  // reconciled). The row/input schema field remains
  // `archetypeConfidence` — only the event payload is renamed.
  await emitGovernanceEvent('governance.archetype.classified', {
    projectId: input.projectId,
    archetype: input.archetype,
    confidence: archetypeConfidence,
  });

  // Step 6: TransactWriteCommand does not return attributes — second Get
  // so callers receive the full updated row.
  const after = await getAgentDesignAssessment(input.projectId);
  if (!after) {
    // Vanishingly unlikely (commit succeeded moments ago), but fail loud if
    // a downstream process has deleted the row between commit and read.
    throw new Error(
      'AgentDesignAssessment vanished after commit — investigate TTL / concurrent delete',
    );
  }
  return after;
}

export const handler = async (event: any): Promise<unknown> => {
  const fieldName = event?.info?.fieldName;
  const authContext = authContextFromEvent(event);
  try {
    switch (fieldName) {
      case 'startAgentDesignAssessment':
        return await startAgentDesignAssessment(
          event.arguments.projectId,
          authContext,
        );
      case 'submitAgentDesignAssessment':
        return await submitAgentDesignAssessment(
          event.arguments as SubmitAgentDesignAssessmentInput,
          authContext,
        );
      case 'getAgentDesignAssessment':
        return await getAgentDesignAssessment(event.arguments.projectId);
      default:
        throw new Error(`Unknown fieldName: ${fieldName}`);
    }
  } catch (err: any) {
    console.error('agent-design-assessment-resolver error', {
      fieldName,
      message: err?.message,
      args: sanitizeForLog(event?.arguments),
    });
    throw err;
  }
};
