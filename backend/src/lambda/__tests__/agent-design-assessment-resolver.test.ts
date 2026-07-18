/**
 * Unit tests for agent-design-assessment-resolver Lambda.
 *
 * Covers:
 * - startAgentDesignAssessment: perm gate (assessment:submit), PutCommand
 * with attribute_not_exists(projectId), happy path returns PENDING row
 * with ISO-8601 createdAt/updatedAt, ConditionalCheckFailedException
 * propagates when a row already exists.
 * - submitAgentDesignAssessment: perm gate FIRST, seven ValidationError
 * branches (length!=4, duplicate ranks, missing rank 4, wrong dimension
 * set, empty dataSources, empty riskAreas, empty rationale), absence of
 * a started row, re-submission guard on completedAt, happy path emits
 * EXACTLY one TransactWriteCommand containing BOTH tables plus
 * governance.archetype.classified, ProjectsTable mirror-write.
 * - getAgentDesignAssessment: no perm gate, null when missing, Item
 * passthrough when present.
 * - handler: dispatch for each fieldName + unknown-field throw.
 * - Property test (200 iters, QB-003-1 safe arbs): resolver validator
 * matches the schema-level allowlist — ValidationError iff the
 * generated dimensionRanking is not a valid permutation of the 4
 * dimensions with ranks forming exactly {1,2,3,4}.
 *
 * The `hasPermission` helper is mocked so these tests remain hermetic
 * against Track B's auth.ts landing timing (I17/I18 isolation invariants
 * from PLAN_GOV_CONTEXT_20260501.md).
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { mockClient } from 'aws-sdk-client-mock';
import * as fc from 'fast-check';
import type { AuthContext } from '../../types';

// ── Auth mock ─────────────────────────────────────────────────────────
// Track B is landing `assessment:submit` on architect + project_manager in
// auth.ts. Rather than couple this test file to that pending edit, mock the
// permission helper: `architect` and `project_manager` and `admin` hold
// `assessment:submit`, `developer` does not. This matches the intended
// auth.ts rolePermissions table.
jest.mock('../../utils/auth', () => ({
  hasPermission: (authContext: AuthContext, permission: string): boolean => {
    if (authContext.roles?.includes('admin')) return true;
    const grants: Record<string, string[]> = {
      architect: ['assessment:submit', 'project:read'],
      project_manager: ['assessment:submit', 'project:read'],
      developer: ['project:read'],
    };
    for (const role of authContext.roles || []) {
      if ((grants[role] || []).includes(permission)) return true;
    }
    return false;
  },
}));

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);

// Env MUST be set before importing the module under test — the resolver
// captures process.env at module load time.
process.env.AGENT_DESIGN_ASSESSMENTS_TABLE = 'citadel-agent-design-assessments-test';
process.env.PROJECTS_TABLE = 'citadel-projects-test';
process.env.EVENT_BUS_NAME = 'citadel-agents-test';

import {
  startAgentDesignAssessment,
  submitAgentDesignAssessment,
  getAgentDesignAssessment,
  handler,
} from '../agent-design-assessment-resolver';
import { __resetGovernanceNotifierForTest } from '../../utils/notifier-base';
import {
  GovernanceArchetype,
  ProjectArchetypeStatus,
  type FourDimensionLiteral,
  type SubmitAgentDesignAssessmentInput,
  type DimensionComplexityInput,
  type AgentDesignAssessment,
} from '../../types';

const ASSESS_TABLE = 'citadel-agent-design-assessments-test';
const PROJECTS_TABLE = 'citadel-projects-test';

function authContextFor(
  role: 'architect' | 'developer' | 'project_manager' | 'admin',
): AuthContext {
  return {
    userId: `user-${role}`,
    username: role,
    groups: [],
    roles: [role],
  };
}

function validRanking(): DimensionComplexityInput[] {
  return [
    { dimension: 'CODE', rank: 1, rationale: 'core modernisation path' },
    { dimension: 'DATA', rank: 2, rationale: 'schema migration needed' },
    { dimension: 'INTEGRATION', rank: 3, rationale: 'a few legacy hooks' },
    { dimension: 'INFRASTRUCTURE', rank: 4, rationale: 'greenfield AWS' },
  ];
}

function validInput(
  overrides: Partial<SubmitAgentDesignAssessmentInput> = {},
): SubmitAgentDesignAssessmentInput {
  return {
    projectId: 'proj-1',
    archetype: GovernanceArchetype.MONOLITHIC_DB,
    archetypeConfidence: 0.9,
    dimensionRanking: validRanking(),
    accessibleDataSources: ['postgres-prod'],
    primaryRiskAreas: ['data-migration'],
    ...overrides,
  };
}

function existingAssessment(
  overrides: Partial<AgentDesignAssessment> = {},
): AgentDesignAssessment {
  return {
    projectId: 'proj-1',
    archetype: null,
    archetypeConfidence: null,
    archetypeStatus: ProjectArchetypeStatus.PENDING,
    dimensionRanking: [],
    accessibleDataSources: [],
    primaryRiskAreas: [],
    completedAt: null,
    completedBy: null,
    createdAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
    ...overrides,
  };
}

function completedAssessment(): AgentDesignAssessment {
  return existingAssessment({
    archetype: GovernanceArchetype.MONOLITHIC_DB,
    archetypeConfidence: 0.9,
    archetypeStatus: ProjectArchetypeStatus.CLASSIFIED,
    dimensionRanking: validRanking().map((d) => ({ ...d })),
    accessibleDataSources: ['postgres-prod'],
    primaryRiskAreas: ['data-migration'],
    completedAt: '2026-04-30T01:00:00.000Z',
    completedBy: 'user-architect',
    updatedAt: '2026-04-30T01:00:00.000Z',
  });
}

describe('agent-design-assessment-resolver', () => {
  beforeEach(() => {
    ddbMock.reset();
    ebMock.reset();
    ebMock.on(PutEventsCommand).resolves({
      FailedEntryCount: 0,
      Entries: [{ EventId: 'evt-1' }],
    });
    __resetGovernanceNotifierForTest();
  });

  // ── startAgentDesignAssessment ────────────────────────────────────────

  describe('startAgentDesignAssessment', () => {
    test('1. happy path: persists PENDING row with ISO-8601 timestamps and ConditionExpression attribute_not_exists(projectId)', async () => {
      ddbMock.on(PutCommand).resolves({});
      const auth = authContextFor('architect');

      const row = await startAgentDesignAssessment('proj-1', auth);

      expect(row.projectId).toBe('proj-1');
      expect(row.archetype).toBeNull();
      expect(row.archetypeConfidence).toBeNull();
      expect(row.archetypeStatus).toBe(ProjectArchetypeStatus.PENDING);
      expect(row.dimensionRanking).toEqual([]);
      expect(row.accessibleDataSources).toEqual([]);
      expect(row.primaryRiskAreas).toEqual([]);
      expect(row.completedAt).toBeNull();
      expect(row.completedBy).toBeNull();
      expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(row.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      const puts = ddbMock.commandCalls(PutCommand);
      expect(puts).toHaveLength(1);
      expect(puts[0].args[0].input.TableName).toBe(ASSESS_TABLE);
      expect(puts[0].args[0].input.ConditionExpression).toBe(
        'attribute_not_exists(projectId)',
      );
      expect(puts[0].args[0].input.Item).toMatchObject({
        projectId: 'proj-1',
        archetypeStatus: 'PENDING',
      });
    });

    test('2. project_manager also allowed (assessment:submit grant on architect + project_manager)', async () => {
      ddbMock.on(PutCommand).resolves({});
      const auth = authContextFor('project_manager');
      const row = await startAgentDesignAssessment('proj-2', auth);
      expect(row.projectId).toBe('proj-2');
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    });

    test('3. developer denied: UnauthorizedError, no DDB write', async () => {
      ddbMock.on(PutCommand).resolves({});
      const auth = authContextFor('developer');
      await expect(
        startAgentDesignAssessment('proj-1', auth),
      ).rejects.toThrow(/UnauthorizedError.*assessment:submit/);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test('4. empty projectId → ValidationError, no DDB write', async () => {
      const auth = authContextFor('architect');
      await expect(startAgentDesignAssessment('', auth)).rejects.toThrow(
        /ValidationError.*projectId/,
      );
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test('5. ConditionalCheckFailedException from pre-existing row propagates', async () => {
      const ccf = new Error('The conditional request failed');
      ccf.name = 'ConditionalCheckFailedException';
      ddbMock.on(PutCommand).rejects(ccf);
      const auth = authContextFor('architect');
      await expect(
        startAgentDesignAssessment('proj-1', auth),
      ).rejects.toThrow(/conditional/i);
    });
  });

  // ── getAgentDesignAssessment ──────────────────────────────────────────

  describe('getAgentDesignAssessment', () => {
    test('6. returns null when missing', async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      const result = await getAgentDesignAssessment('proj-missing');
      expect(result).toBeNull();
    });

    test('7. returns Item when present', async () => {
      const existing = existingAssessment();
      ddbMock.on(GetCommand).resolves({ Item: existing });
      const result = await getAgentDesignAssessment('proj-1');
      expect(result).toEqual(existing);
      const gets = ddbMock.commandCalls(GetCommand);
      expect(gets).toHaveLength(1);
      expect(gets[0].args[0].input.TableName).toBe(ASSESS_TABLE);
    });
  });

  // ── submitAgentDesignAssessment — perm gate ───────────────────────────

  describe('submitAgentDesignAssessment — perm gate', () => {
    test('8. developer denied BEFORE any DDB access', async () => {
      const auth = authContextFor('developer');
      await expect(
        submitAgentDesignAssessment(validInput(), auth),
      ).rejects.toThrow(/UnauthorizedError.*assessment:submit/);
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });
  });

  // ── submitAgentDesignAssessment — validation branches ─────────────────

  describe('submitAgentDesignAssessment — validation', () => {
    test('9. dimensionRanking length != 4 rejected', async () => {
      const auth = authContextFor('architect');
      const input = validInput({ dimensionRanking: validRanking().slice(0, 3) });
      await expect(submitAgentDesignAssessment(input, auth)).rejects.toThrow(
        /ValidationError.*dimensionRanking.*exactly 4/,
      );
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    });

    test('10. duplicate ranks (1,1,2,3) rejected', async () => {
      const auth = authContextFor('architect');
      const input = validInput({
        dimensionRanking: [
          { dimension: 'CODE', rank: 1, rationale: 'ok' },
          { dimension: 'DATA', rank: 1, rationale: 'ok' },
          { dimension: 'INTEGRATION', rank: 2, rationale: 'ok' },
          { dimension: 'INFRASTRUCTURE', rank: 3, rationale: 'ok' },
        ],
      });
      await expect(submitAgentDesignAssessment(input, auth)).rejects.toThrow(
        /ValidationError/,
      );
    });

    test('11. missing rank 4 (ranks 1,2,3,5) rejected', async () => {
      const auth = authContextFor('architect');
      const input = validInput({
        dimensionRanking: [
          { dimension: 'CODE', rank: 1, rationale: 'ok' },
          { dimension: 'DATA', rank: 2, rationale: 'ok' },
          { dimension: 'INTEGRATION', rank: 3, rationale: 'ok' },
          { dimension: 'INFRASTRUCTURE', rank: 5, rationale: 'ok' },
        ],
      });
      await expect(submitAgentDesignAssessment(input, auth)).rejects.toThrow(
        /ValidationError/,
      );
    });

    test('12. wrong dimension set (CODE duplicated, INFRASTRUCTURE missing) rejected', async () => {
      const auth = authContextFor('architect');
      const input = validInput({
        dimensionRanking: [
          { dimension: 'CODE', rank: 1, rationale: 'ok' },
          { dimension: 'CODE', rank: 2, rationale: 'ok' },
          { dimension: 'DATA', rank: 3, rationale: 'ok' },
          { dimension: 'INTEGRATION', rank: 4, rationale: 'ok' },
        ],
      });
      await expect(submitAgentDesignAssessment(input, auth)).rejects.toThrow(
        /ValidationError/,
      );
    });

    test('13. empty accessibleDataSources rejected', async () => {
      const auth = authContextFor('architect');
      const input = validInput({ accessibleDataSources: [] });
      await expect(submitAgentDesignAssessment(input, auth)).rejects.toThrow(
        /ValidationError.*accessibleDataSources/,
      );
    });

    test('14. empty primaryRiskAreas rejected', async () => {
      const auth = authContextFor('architect');
      const input = validInput({ primaryRiskAreas: [] });
      await expect(submitAgentDesignAssessment(input, auth)).rejects.toThrow(
        /ValidationError.*primaryRiskAreas/,
      );
    });

    test('15. empty rationale (whitespace only) rejected', async () => {
      const auth = authContextFor('architect');
      const input = validInput({
        dimensionRanking: [
          { dimension: 'CODE', rank: 1, rationale: '   ' },
          { dimension: 'DATA', rank: 2, rationale: 'ok' },
          { dimension: 'INTEGRATION', rank: 3, rationale: 'ok' },
          { dimension: 'INFRASTRUCTURE', rank: 4, rationale: 'ok' },
        ],
      });
      await expect(submitAgentDesignAssessment(input, auth)).rejects.toThrow(
        /ValidationError.*rationale/,
      );
    });
  });

  // ── submitAgentDesignAssessment — lifecycle guards ────────────────────

  describe('submitAgentDesignAssessment — lifecycle guards', () => {
    test('16. assessment not started (GetCommand returns null) → throws', async () => {
      const auth = authContextFor('architect');
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      await expect(
        submitAgentDesignAssessment(validInput(), auth),
      ).rejects.toThrow(/AgentDesignAssessment not found.*startAgentDesignAssessment/);
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    });

    test('17. re-submission on completed assessment (completedAt !== null) → throws, no TransactWrite', async () => {
      const auth = authContextFor('architect');
      ddbMock.on(GetCommand).resolves({ Item: completedAssessment() });
      await expect(
        submitAgentDesignAssessment(validInput(), auth),
      ).rejects.toThrow(/already completed.*re-submission not permitted/);
      expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
      expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
    });
  });

  // ── submitAgentDesignAssessment — happy path ──────────────────────────

  describe('submitAgentDesignAssessment — happy path', () => {
    test('18. emits EXACTLY one TransactWriteCommand with 2 items spanning both tables + governance.archetype.classified', async () => {
      const auth = authContextFor('architect');
      // First Get: existing PENDING row. Second Get: post-commit re-fetch.
      const pending = existingAssessment();
      const postCommit = completedAssessment();
      ddbMock
        .on(GetCommand)
        .resolvesOnce({ Item: pending })
        .resolvesOnce({ Item: postCommit });
      ddbMock.on(TransactWriteCommand).resolves({});

      const result = await submitAgentDesignAssessment(validInput(), auth);

      // Result is the post-commit row.
      expect(result.archetype).toBe(GovernanceArchetype.MONOLITHIC_DB);
      expect(result.archetypeStatus).toBe(ProjectArchetypeStatus.CLASSIFIED);
      expect(result.completedBy).toBe('user-architect');

      // Exactly one TransactWriteCommand.
      const tx = ddbMock.commandCalls(TransactWriteCommand);
      expect(tx).toHaveLength(1);
      const items = tx[0].args[0].input.TransactItems!;
      expect(items).toHaveLength(2);

      const tableNames = items.map((i) => i.Update?.TableName).filter(Boolean);
      expect(tableNames).toEqual(
        expect.arrayContaining([ASSESS_TABLE, PROJECTS_TABLE]),
      );

      // Assessment table update uses attribute_not_exists(completedAt) for
      // the optimistic lock (prevents concurrent double-submit).
      const assessUpdate = items.find(
        (i) => i.Update?.TableName === ASSESS_TABLE,
      );
      expect(assessUpdate!.Update!.ConditionExpression).toMatch(
        /attribute_not_exists\(completedAt\)/,
      );

      // Governance event emitted with the correct detail-type + payload.
      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      const entry = ebCalls[0].args[0].input.Entries![0];
      expect(entry.DetailType).toBe('governance.archetype.classified');
      const detail = JSON.parse(entry.Detail!);
      expect(detail.projectId).toBe('proj-1');
      expect(detail.archetype).toBe(GovernanceArchetype.MONOLITHIC_DB);
      // `confidence` is the field name in the typed DetailPayloadOf
      // map in notifier-base.ts (reconciled). The resolver passes
      // input.archetypeConfidence through under the `confidence` key
      // (default 1.0).
      expect(detail.confidence).toBe(0.9);
    });

    test('19. ProjectsTable update writes the archetype back (mirror-write)', async () => {
      const auth = authContextFor('architect');
      ddbMock
        .on(GetCommand)
        .resolvesOnce({ Item: existingAssessment() })
        .resolvesOnce({ Item: completedAssessment() });
      ddbMock.on(TransactWriteCommand).resolves({});

      await submitAgentDesignAssessment(validInput(), auth);

      const items = ddbMock.commandCalls(TransactWriteCommand)[0].args[0].input
        .TransactItems!;
      const projectsUpdate = items.find(
        (i) => i.Update?.TableName === PROJECTS_TABLE,
      );
      expect(projectsUpdate).toBeDefined();
      expect(projectsUpdate!.Update!.Key).toEqual({ id: 'proj-1' });
      const values = projectsUpdate!.Update!.ExpressionAttributeValues!;
      // Find the value corresponding to archetype in the UpdateExpression.
      const archetypeValue = Object.entries(values).find(
        ([, v]) => v === GovernanceArchetype.MONOLITHIC_DB,
      );
      expect(archetypeValue).toBeDefined();
      const statusValue = Object.entries(values).find(
        ([, v]) => v === ProjectArchetypeStatus.CLASSIFIED,
      );
      expect(statusValue).toBeDefined();
    });

    test('20. archetypeConfidence defaults to 1.0 when omitted', async () => {
      const auth = authContextFor('architect');
      ddbMock
        .on(GetCommand)
        .resolvesOnce({ Item: existingAssessment() })
        .resolvesOnce({
          Item: completedAssessment(),
        });
      ddbMock.on(TransactWriteCommand).resolves({});

      const input = validInput();
      delete input.archetypeConfidence;
      await submitAgentDesignAssessment(input, auth);

      const ebCalls = ebMock.commandCalls(PutEventsCommand);
      expect(ebCalls).toHaveLength(1);
      const detail = JSON.parse(ebCalls[0].args[0].input.Entries![0].Detail!);
      expect(detail.confidence).toBe(1.0);
    });
  });

  // ── handler dispatch ──────────────────────────────────────────────────

  describe('handler dispatch', () => {
    function event(
      fieldName: string,
      args: Record<string, unknown>,
      role: 'architect' | 'developer' = 'architect',
    ): Record<string, unknown> {
      return {
        info: { fieldName },
        arguments: args,
        identity: { sub: `user-${role}`, username: role, 'custom:role': role },
      };
    }

    test('21. dispatches startAgentDesignAssessment', async () => {
      ddbMock.on(PutCommand).resolves({});
      const result = (await handler(
        event('startAgentDesignAssessment', { projectId: 'proj-1' }),
      )) as { projectId: string; archetypeStatus: string };
      expect(result.projectId).toBe('proj-1');
      expect(result.archetypeStatus).toBe('PENDING');
    });

    test('22. dispatches getAgentDesignAssessment', async () => {
      ddbMock.on(GetCommand).resolves({ Item: existingAssessment() });
      const result = (await handler(
        event('getAgentDesignAssessment', { projectId: 'proj-1' }, 'developer'),
      )) as { projectId: string } | null;
      expect(result?.projectId).toBe('proj-1');
    });

    test('23. dispatches submitAgentDesignAssessment with full input object', async () => {
      ddbMock
        .on(GetCommand)
        .resolvesOnce({ Item: existingAssessment() })
        .resolvesOnce({ Item: completedAssessment() });
      ddbMock.on(TransactWriteCommand).resolves({});
      const result = (await handler(event('submitAgentDesignAssessment', validInput()))) as {
        archetypeStatus: string;
      };
      expect(result.archetypeStatus).toBe('CLASSIFIED');
    });

    test('24. unknown fieldName throws', async () => {
      await expect(
        handler(event('bogusField', {})),
      ).rejects.toThrow(/Unknown fieldName.*bogusField/);
    });

    test('25. handler honours auth gate on write fields (developer denied)', async () => {
      await expect(
        handler(
          event('startAgentDesignAssessment', { projectId: 'proj-1' }, 'developer'),
        ),
      ).rejects.toThrow(/UnauthorizedError/);
    });
  });

  // ── Property test: resolver validator matches schema allowlist ────────

  describe('property: submitAgentDesignAssessment validator (200 iters)', () => {
    test('26. ValidationError iff ranking is not a permutation of the 4 dimensions with ranks = {1,2,3,4}', async () => {
      const dimensionArb = fc.constantFrom<FourDimensionLiteral>(
        'CODE',
        'DATA',
        'INTEGRATION',
        'INFRASTRUCTURE',
      );
      // QB-003-1: use bounded simple rationale strings to avoid ReDoS-risk
      // payloads in redactPII.
      const rationaleArb = fc.constantFrom(
        'core work',
        'some data',
        'small scope',
        'integration point',
        'simple',
      );
      const entryArb = fc.record({
        dimension: dimensionArb,
        rank: fc.integer({ min: 0, max: 5 }),
        rationale: rationaleArb,
      });
      const rankingArb = fc.array(entryArb, { minLength: 0, maxLength: 8 });

      const FOUR = new Set<FourDimensionLiteral>([
        'CODE',
        'DATA',
        'INTEGRATION',
        'INFRASTRUCTURE',
      ]);

      await fc.assert(
        fc.asyncProperty(rankingArb, async (ranking) => {
          // Per I17/I18: reset mocks AND the governance notifier cache
          // INSIDE the property callback.
          ddbMock.reset();
          ebMock.reset();
          ebMock.on(PutEventsCommand).resolves({
            FailedEntryCount: 0,
            Entries: [{ EventId: 'evt-prop' }],
          });
          __resetGovernanceNotifierForTest();

          // Even on a valid ranking the happy path needs DDB mocks primed
          // so the resolver doesn't hang on a real AWS call.
          ddbMock
            .on(GetCommand)
            .resolvesOnce({ Item: existingAssessment() })
            .resolvesOnce({ Item: completedAssessment() });
          ddbMock.on(TransactWriteCommand).resolves({});
          ddbMock.on(PutCommand).resolves({});

          const validLength = ranking.length === 4;
          const ranks = ranking.map((r) => r.rank).sort((a, b) => a - b);
          const validRanks =
            validLength && JSON.stringify(ranks) === JSON.stringify([1, 2, 3, 4]);
          const dims = new Set(ranking.map((r) => r.dimension));
          const validDims =
            validLength &&
            dims.size === 4 &&
            [...FOUR].every((d) => dims.has(d));
          const validRationales =
            validLength && ranking.every((r) => r.rationale.trim().length > 0);
          const isValid = validLength && validRanks && validDims && validRationales;

          const auth = authContextFor('architect');
          const input: SubmitAgentDesignAssessmentInput = {
            projectId: 'proj-prop',
            archetype: GovernanceArchetype.MONOLITHIC_DB,
            archetypeConfidence: 0.8,
            dimensionRanking: ranking,
            accessibleDataSources: ['src-1'],
            primaryRiskAreas: ['risk-1'],
          };

          if (isValid) {
            // Must NOT throw ValidationError on the ranking branches.
            // (It may still throw for some other reason, but not ValidationError.)
            try {
              await submitAgentDesignAssessment(input, auth);
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e);
              if (/ValidationError/.test(message)) {
                throw new Error(
                  `Unexpected ValidationError on valid ranking: ${message}`,
                );
              }
              // Any other error class is acceptable for this property.
            }
          } else {
            await expect(
              submitAgentDesignAssessment(input, auth),
            ).rejects.toThrow(/ValidationError/);
          }
        }),
        { numRuns: 200 },
      );
    });
  });
});
