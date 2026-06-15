/**
 * Unit tests for program-review-resolver.
 *
 * Covers:
 *   - AC 1: runProgramReview returns a row with exactly one ChecklistResult
 *     per question in the real checklist (20 results).
 *   - AC 2: project with a completed assessment → Q001 returns PASS with
 *     the AgentDesignAssessment evidenceRef.
 *   - AC 3: project with zero ADRs → Q006 returns FAIL with empty
 *     evidenceRefs.
 *   - AC 4 (historical-snapshot invariant): calling runProgramReview twice
 *     creates two distinct rows with distinct reviewIds; the first row is
 *     not mutated.
 *   - AC 5 (determinism property, 50 iters): for a deterministic evidence
 *     fixture, answers are byte-identical across runs (sort + stringify).
 *   - Permission gate: developer role throws UnauthorizedError with zero
 *     evidence fetches, zero DDB writes.
 *   - getProgramReview: null on miss, passthrough on hit.
 *   - listProgramReviewsForProject: QueryCommand on project-index.
 *   - handler dispatch for each fieldName + unknown-field throw.
 *
 * Mocking strategy (I17/I18):
 *   - hasPermission is mocked so the test does not depend on auth.ts state.
 *   - The four evidence-source functions (listADRsForProject,
 *     listExecutionSpecifications, listInterrogationRounds,
 *     getAgentDesignAssessment) are mocked via jest.spyOn so we can
 *     feed deterministic fixtures without touching DDB.
 *   - DynamoDBDocumentClient is mocked with aws-sdk-client-mock.
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import * as fc from 'fast-check';
import type { AuthContext } from '../../types';

// ── Auth mock ─────────────────────────────────────────────────────────
// `adr:create` is held by architect + project_manager (via the
// governance story edits in auth.ts). Mock here to decouple
// from Track B's pending auth.ts edits.
jest.mock('../../utils/auth', () => ({
  hasPermission: (authContext: AuthContext, permission: string): boolean => {
    if (authContext.roles?.includes('admin')) return true;
    const grants: Record<string, string[]> = {
      architect: ['adr:create', 'project:read'],
      project_manager: ['adr:create', 'project:read'],
      developer: ['project:read'],
    };
    for (const role of authContext.roles || []) {
      if ((grants[role] || []).includes(permission)) return true;
    }
    return false;
  },
}));

const ddbMock = mockClient(DynamoDBDocumentClient);

// Env vars must be set BEFORE importing the resolver (module-load capture).
process.env.PROGRAM_REVIEWS_TABLE = 'citadel-program-reviews-test';
process.env.ADRS_TABLE = 'citadel-adrs-test';
process.env.EXECUTION_SPECS_TABLE = 'citadel-execution-specifications-test';
process.env.INTERROGATION_ROUNDS_TABLE = 'citadel-interrogation-rounds-test';
process.env.AGENT_DESIGN_ASSESSMENTS_TABLE = 'citadel-agent-design-assessments-test';
process.env.PROJECTS_TABLE = 'citadel-projects-test';

import {
  runProgramReview,
  getProgramReview,
  listProgramReviewsForProject,
  handler,
} from '../program-review-resolver';
import * as adrResolver from '../adr-resolver';
import * as execSpecResolver from '../execspec-resolver';
import * as roundResolver from '../interrogation-round-resolver';
import * as assessmentResolver from '../agent-design-assessment-resolver';

const REVIEWS_TABLE = 'citadel-program-reviews-test';

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

// ── Deterministic evidence fixtures ──────────────────────────────────

function emptyEvidence() {
  return { adrs: [], specs: [], rounds: [], assessment: null };
}

function fullyCompliantEvidence(projectId: string) {
  // Enough evidence to satisfy every automated question (Q001..Q012).
  const adrs = [
    {
      adrId: 'adr-1',
      projectId,
      status: 'LOCKED',
      lockedAt: '2026-04-01T00:00:00.000Z',
    },
  ];
  const specs = [
    {
      specId: 'spec-1',
      projectId,
      status: 'APPROVED',
      approvedBy: 'user-architect',
      sourceAdrIds: ['adr-1'],
      sourceDesignArtifactType: 'ADR',
      executorKind: 'LAMBDA',
      narrativeReviewStatus: 'REVIEWED',
    },
  ];
  const rounds = [
    {
      projectId,
      roundN: 1,
      status: 'STABILISED',
      participantRoles: ['OPERATIONS', 'ARCHITECT'],
      injectedConstraintIds: ['c1'],
    },
    {
      projectId,
      roundN: 2,
      status: 'STABILISED',
      participantRoles: ['OPERATIONS'],
      injectedConstraintIds: ['c2'],
    },
    {
      projectId,
      roundN: 3,
      status: 'STABILISED',
      participantRoles: ['OPERATIONS'],
      injectedConstraintIds: ['c3'],
    },
  ];
  const assessment = {
    projectId,
    archetype: 'MONOLITHIC_DB',
    archetypeStatus: 'CLASSIFIED',
    completedAt: '2026-04-10T00:00:00.000Z',
    dimensionRanking: [
      { dimension: 'CODE', rank: 1, rationale: 'x' },
      { dimension: 'DATA', rank: 2, rationale: 'x' },
      {
        dimension: 'INTEGRATION_ARCHAEOLOGY',
        rank: 3,
        rationale: 'x',
        coverage: 'COMPLETE',
      },
      { dimension: 'INFRASTRUCTURE', rank: 4, rationale: 'x' },
    ],
    nonFunctionalConstraints: ['PERFORMANCE', 'SECURITY', 'COMPLIANCE'],
  };
  return { adrs, specs, rounds, assessment };
}

function installEvidence(ev: ReturnType<typeof emptyEvidence>): void {
  jest.spyOn(adrResolver, 'listADRsForProject').mockResolvedValue(ev.adrs as any);
  jest
    .spyOn(execSpecResolver, 'listExecutionSpecifications')
    .mockResolvedValue(ev.specs as any);
  jest
    .spyOn(roundResolver, 'listInterrogationRounds')
    .mockResolvedValue(ev.rounds as any);
  jest
    .spyOn(assessmentResolver, 'getAgentDesignAssessment')
    .mockResolvedValue(ev.assessment as any);
}

describe('program-review-resolver', () => {
  beforeEach(() => {
    ddbMock.reset();
    jest.restoreAllMocks();
  });

  // ── AC 1: one result per question ────────────────────────────────────

  describe('runProgramReview — structural invariants', () => {
    test('1. AC1: returns exactly 20 results, one per checklist question', async () => {
      installEvidence(emptyEvidence());
      ddbMock.on(PutCommand).resolves({});

      const review = await runProgramReview('proj-1', authContextFor('architect'));

      expect(review.results).toHaveLength(20);
      const ids = review.results.map((r) => r.questionId).sort();
      const expected = Array.from({ length: 20 }, (_, i) =>
        `Q${String(i + 1).padStart(3, '0')}`,
      ).sort();
      expect(ids).toEqual(expected);
    });

    test('2. persists the review via PutCommand on PROGRAM_REVIEWS_TABLE', async () => {
      installEvidence(emptyEvidence());
      ddbMock.on(PutCommand).resolves({});

      const review = await runProgramReview('proj-1', authContextFor('architect'));

      const puts = ddbMock.commandCalls(PutCommand);
      expect(puts).toHaveLength(1);
      expect(puts[0].args[0].input.TableName).toBe(REVIEWS_TABLE);
      const item = puts[0].args[0].input.Item as Record<string, unknown>;
      expect(item.reviewId).toBe(review.reviewId);
      expect(item.projectId).toBe('proj-1');
      expect(Array.isArray(item.results)).toBe(true);
    });

    test('3. stamps runAt, createdAt (ISO 8601) and runBy=authContext.userId', async () => {
      installEvidence(emptyEvidence());
      ddbMock.on(PutCommand).resolves({});

      const review = await runProgramReview('proj-1', authContextFor('architect'));

      expect(review.runBy).toBe('user-architect');
      expect(review.runAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(review.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(review.reviewId).toMatch(/^[0-9a-f-]{36}$/);
    });

    test('4. fetches the four evidence sources IN PARALLEL (all called once each)', async () => {
      installEvidence(emptyEvidence());
      ddbMock.on(PutCommand).resolves({});

      await runProgramReview('proj-parallel', authContextFor('architect'));

      expect(adrResolver.listADRsForProject).toHaveBeenCalledTimes(1);
      expect(adrResolver.listADRsForProject).toHaveBeenCalledWith('proj-parallel');
      expect(execSpecResolver.listExecutionSpecifications).toHaveBeenCalledTimes(1);
      expect(roundResolver.listInterrogationRounds).toHaveBeenCalledTimes(1);
      expect(assessmentResolver.getAgentDesignAssessment).toHaveBeenCalledTimes(1);
    });
  });

  // ── AC 2: completed assessment → Q001 PASS ──────────────────────────

  describe('runProgramReview — evidence evaluation', () => {
    test('5. AC2: completed assessment → Q001 PASS with assessment evidenceRef', async () => {
      installEvidence(fullyCompliantEvidence('proj-1'));
      ddbMock.on(PutCommand).resolves({});

      const review = await runProgramReview('proj-1', authContextFor('architect'));
      const q001 = review.results.find((r) => r.questionId === 'Q001');
      expect(q001).toBeDefined();
      expect(q001!.answer).toBe('PASS');
      expect(q001!.evidenceRefs).toContain('AgentDesignAssessment:proj-1');
    });

    test('6. Q001 FAIL with empty evidenceRefs when assessment missing', async () => {
      installEvidence(emptyEvidence());
      ddbMock.on(PutCommand).resolves({});

      const review = await runProgramReview('proj-1', authContextFor('architect'));
      const q001 = review.results.find((r) => r.questionId === 'Q001');
      expect(q001!.answer).toBe('FAIL');
      expect(q001!.evidenceRefs).toEqual([]);
    });

    test('7. AC3: zero ADRs → Q006 FAIL with empty evidenceRefs', async () => {
      installEvidence(emptyEvidence());
      ddbMock.on(PutCommand).resolves({});

      const review = await runProgramReview('proj-1', authContextFor('architect'));
      const q006 = review.results.find((r) => r.questionId === 'Q006');
      expect(q006).toBeDefined();
      expect(q006!.answer).toBe('FAIL');
      expect(q006!.evidenceRefs).toEqual([]);
    });

    test('8. LOCKED ADR → Q006 PASS with the adrId in evidenceRefs', async () => {
      installEvidence(fullyCompliantEvidence('proj-1'));
      ddbMock.on(PutCommand).resolves({});

      const review = await runProgramReview('proj-1', authContextFor('architect'));
      const q006 = review.results.find((r) => r.questionId === 'Q006');
      expect(q006!.answer).toBe('PASS');
      expect(q006!.evidenceRefs.length).toBeGreaterThan(0);
      expect(q006!.evidenceRefs.join(',')).toMatch(/adr-1/);
    });

    test('9. Q005: three stabilised rounds → PASS', async () => {
      installEvidence(fullyCompliantEvidence('proj-1'));
      ddbMock.on(PutCommand).resolves({});

      const review = await runProgramReview('proj-1', authContextFor('architect'));
      const q005 = review.results.find((r) => r.questionId === 'Q005');
      expect(q005!.answer).toBe('PASS');
    });

    test('10. Q005: two stabilised rounds → FAIL', async () => {
      const ev = fullyCompliantEvidence('proj-1');
      ev.rounds = ev.rounds.slice(0, 2);
      installEvidence(ev);
      ddbMock.on(PutCommand).resolves({});

      const review = await runProgramReview('proj-1', authContextFor('architect'));
      const q005 = review.results.find((r) => r.questionId === 'Q005');
      expect(q005!.answer).toBe('FAIL');
    });

    test('11. Q010: APPROVED spec → PASS', async () => {
      installEvidence(fullyCompliantEvidence('proj-1'));
      ddbMock.on(PutCommand).resolves({});

      const review = await runProgramReview('proj-1', authContextFor('architect'));
      const q010 = review.results.find((r) => r.questionId === 'Q010');
      expect(q010!.answer).toBe('PASS');
    });

    test('12. investment / partner cluster questions default to PENDING_EVIDENCE with a note', async () => {
      installEvidence(fullyCompliantEvidence('proj-1'));
      ddbMock.on(PutCommand).resolves({});

      const review = await runProgramReview('proj-1', authContextFor('architect'));
      const q013 = review.results.find((r) => r.questionId === 'Q013');
      const q017 = review.results.find((r) => r.questionId === 'Q017');
      expect(q013!.answer).toBe('PENDING_EVIDENCE');
      expect(q013!.notes).toMatch(/manual review|evaluator/i);
      expect(q017!.answer).toBe('PENDING_EVIDENCE');
    });
  });

  // ── AC 4: historical-snapshot invariant ─────────────────────────────

  describe('runProgramReview — historical snapshot', () => {
    test('13. AC4: two runs → two distinct reviewIds, two PutCommands, first row not mutated', async () => {
      installEvidence(emptyEvidence());
      ddbMock.on(PutCommand).resolves({});

      const first = await runProgramReview('proj-1', authContextFor('architect'));
      const second = await runProgramReview('proj-1', authContextFor('architect'));

      expect(first.reviewId).not.toBe(second.reviewId);

      const puts = ddbMock.commandCalls(PutCommand);
      expect(puts).toHaveLength(2);
      const firstItem = puts[0].args[0].input.Item as any;
      const secondItem = puts[1].args[0].input.Item as any;
      expect(firstItem.reviewId).toBe(first.reviewId);
      expect(secondItem.reviewId).toBe(second.reviewId);
      expect(firstItem.reviewId).not.toBe(secondItem.reviewId);

      // PutCommand (no UpdateCommand) confirms we're inserting new rows,
      // not mutating existing ones.
      expect(puts[0].args[0].input.UpdateExpression).toBeUndefined();
    });
  });

  // ── AC 5: determinism property (50 iters) ───────────────────────────

  describe('runProgramReview — determinism', () => {
    test('14. AC5: deterministic evidence → identical answers array across runs', async () => {
      ddbMock.on(PutCommand).resolves({});

      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('proj-alpha', 'proj-beta', 'proj-gamma'),
          fc.boolean(),
          fc.boolean(),
          async (projectId, hasAssessment, hasAdrs) => {
            // Build a deterministic evidence fixture per seed.
            const ev = {
              adrs: hasAdrs
                ? [{ adrId: 'adr-x', projectId, status: 'LOCKED' }]
                : [],
              specs: hasAssessment
                ? [
                    {
                      specId: 'spec-x',
                      projectId,
                      status: 'APPROVED',
                      approvedBy: 'user-architect',
                      sourceDesignArtifactType: 'ADR',
                      executorKind: 'LAMBDA',
                      narrativeReviewStatus: 'REVIEWED',
                      sourceAdrIds: ['adr-x'],
                    },
                  ]
                : [],
              rounds: hasAdrs
                ? [
                    {
                      projectId,
                      roundN: 1,
                      status: 'STABILISED',
                      participantRoles: ['OPERATIONS'],
                      injectedConstraintIds: ['c1'],
                    },
                  ]
                : [],
              assessment: hasAssessment
                ? {
                    projectId,
                    archetype: 'MONOLITHIC_DB',
                    archetypeStatus: 'CLASSIFIED',
                    completedAt: '2026-04-10T00:00:00.000Z',
                    dimensionRanking: [
                      { dimension: 'CODE', rank: 1, rationale: 'x' },
                    ],
                    nonFunctionalConstraints: ['PERFORMANCE'],
                  }
                : null,
            };

            installEvidence(ev as any);

            const a = await runProgramReview(projectId, authContextFor('architect'));
            const b = await runProgramReview(projectId, authContextFor('architect'));

            // Answers array must be byte-identical under sort+stringify.
            const projA = a.results
              .map((r) => ({
                questionId: r.questionId,
                answer: r.answer,
                evidenceRefs: [...r.evidenceRefs].sort(),
                notes: r.notes,
              }))
              .sort((x, y) => x.questionId.localeCompare(y.questionId));
            const projB = b.results
              .map((r) => ({
                questionId: r.questionId,
                answer: r.answer,
                evidenceRefs: [...r.evidenceRefs].sort(),
                notes: r.notes,
              }))
              .sort((x, y) => x.questionId.localeCompare(y.questionId));

            expect(JSON.stringify(projA)).toBe(JSON.stringify(projB));
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  // ── Permission gate ─────────────────────────────────────────────────

  describe('runProgramReview — permission gate', () => {
    test('15. developer denied BEFORE any evidence fetch or DDB write', async () => {
      const adrSpy = jest
        .spyOn(adrResolver, 'listADRsForProject')
        .mockResolvedValue([] as any);
      const specSpy = jest
        .spyOn(execSpecResolver, 'listExecutionSpecifications')
        .mockResolvedValue([] as any);
      const roundSpy = jest
        .spyOn(roundResolver, 'listInterrogationRounds')
        .mockResolvedValue([] as any);
      const assessSpy = jest
        .spyOn(assessmentResolver, 'getAgentDesignAssessment')
        .mockResolvedValue(null as any);
      ddbMock.on(PutCommand).resolves({});

      await expect(
        runProgramReview('proj-1', authContextFor('developer')),
      ).rejects.toThrow(/UnauthorizedError/);

      expect(adrSpy).not.toHaveBeenCalled();
      expect(specSpy).not.toHaveBeenCalled();
      expect(roundSpy).not.toHaveBeenCalled();
      expect(assessSpy).not.toHaveBeenCalled();
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    test('16. architect allowed (adr:create granted)', async () => {
      installEvidence(emptyEvidence());
      ddbMock.on(PutCommand).resolves({});
      await expect(
        runProgramReview('proj-1', authContextFor('architect')),
      ).resolves.toBeDefined();
    });

    test('17. project_manager allowed (adr:create granted)', async () => {
      installEvidence(emptyEvidence());
      ddbMock.on(PutCommand).resolves({});
      await expect(
        runProgramReview('proj-1', authContextFor('project_manager')),
      ).resolves.toBeDefined();
    });
  });

  // ── getProgramReview ────────────────────────────────────────────────

  describe('getProgramReview', () => {
    test('18. returns null when the reviewId is absent', async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      const result = await getProgramReview('missing-review');
      expect(result).toBeNull();
    });

    test('19. returns Item passthrough when present; Get against PROGRAM_REVIEWS_TABLE', async () => {
      const row = {
        reviewId: 'rv-1',
        projectId: 'proj-1',
        results: [],
        runAt: '2026-04-30T00:00:00.000Z',
        runBy: 'user-architect',
        createdAt: '2026-04-30T00:00:00.000Z',
      };
      ddbMock.on(GetCommand).resolves({ Item: row });
      const result = await getProgramReview('rv-1');
      expect(result).toEqual(row);
      const gets = ddbMock.commandCalls(GetCommand);
      expect(gets[0].args[0].input.TableName).toBe(REVIEWS_TABLE);
      expect(gets[0].args[0].input.Key).toEqual({ reviewId: 'rv-1' });
    });
  });

  // ── listProgramReviewsForProject ────────────────────────────────────

  describe('listProgramReviewsForProject', () => {
    test('20. Query against project-index GSI on PROGRAM_REVIEWS_TABLE', async () => {
      const rows = [
        {
          reviewId: 'rv-1',
          projectId: 'proj-1',
          results: [],
          runAt: '2026-04-01T00:00:00.000Z',
          runBy: 'user-architect',
          createdAt: '2026-04-01T00:00:00.000Z',
        },
      ];
      ddbMock.on(QueryCommand).resolves({ Items: rows });

      const result = await listProgramReviewsForProject('proj-1');
      expect(result).toEqual(rows);

      const queries = ddbMock.commandCalls(QueryCommand);
      expect(queries).toHaveLength(1);
      expect(queries[0].args[0].input.TableName).toBe(REVIEWS_TABLE);
      expect(queries[0].args[0].input.IndexName).toBe('project-index');
      expect(queries[0].args[0].input.KeyConditionExpression).toBe(
        'projectId = :pid',
      );
    });

    test('21. returns empty array when the project has no reviews', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: undefined });
      const result = await listProgramReviewsForProject('proj-0');
      expect(result).toEqual([]);
    });
  });

  // ── handler dispatch ────────────────────────────────────────────────

  describe('handler', () => {
    test('22. dispatches runProgramReview', async () => {
      installEvidence(emptyEvidence());
      ddbMock.on(PutCommand).resolves({});
      const event = {
        info: { fieldName: 'runProgramReview' },
        arguments: { projectId: 'proj-1' },
        identity: { sub: 'user-architect', 'custom:role': 'architect' },
      };
      const result = (await handler(event)) as any;
      expect(result.projectId).toBe('proj-1');
      expect(result.results).toHaveLength(20);
    });

    test('23. dispatches getProgramReview', async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { reviewId: 'rv-1', projectId: 'p1', results: [] },
      });
      const event = {
        info: { fieldName: 'getProgramReview' },
        arguments: { reviewId: 'rv-1' },
        identity: { sub: 'user-architect', 'custom:role': 'architect' },
      };
      const result = (await handler(event)) as any;
      expect(result.reviewId).toBe('rv-1');
    });

    test('24. dispatches listProgramReviewsForProject', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      const event = {
        info: { fieldName: 'listProgramReviewsForProject' },
        arguments: { projectId: 'proj-x' },
        identity: { sub: 'user-architect', 'custom:role': 'architect' },
      };
      const result = (await handler(event)) as any;
      expect(Array.isArray(result)).toBe(true);
    });

    test('25. unknown fieldName throws', async () => {
      const event = {
        info: { fieldName: 'bogus' },
        arguments: {},
        identity: { sub: 'u', 'custom:role': 'architect' },
      };
      await expect(handler(event)).rejects.toThrow(/Unsupported field/);
    });
  });
});
