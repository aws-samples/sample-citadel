/**
 * CIT-105 per-case artifact read path — getEvalCaseArtifactDiff handler
 * tests (memory projects/cit-105-artifacts-design). Structural mirror of
 * eval-comparison-resolver.test.ts's conventions: mocked DDB/S3 clients,
 * authContext fixtures per role, direct handler-function calls.
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { sdkStreamMixin } from "@smithy/util-stream";
import { Readable } from "stream";
import type { AuthContext, EvalRun, EvalRunCaseResult } from "../../types";

process.env.EVAL_BASELINES_TABLE = "citadel-eval-baselines-test";
process.env.EVAL_COMPARISONS_TABLE = "citadel-eval-comparisons-test";
process.env.EVAL_COMPARISON_CONFIG_TABLE =
  "citadel-eval-comparison-config-test";
process.env.EVAL_SUITES_TABLE = "citadel-eval-suites-test";
process.env.EVAL_CASES_TABLE = "citadel-eval-cases-test";
process.env.EVAL_RUNS_TABLE = "citadel-eval-runs-test";
process.env.EVAL_RUN_CASE_RESULTS_TABLE = "citadel-eval-run-case-results-test";
process.env.EVENT_BUS_NAME = "citadel-agents-test";
process.env.ENVIRONMENT = "test";

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

jest.mock("../../utils/notifier-base", () => ({
  emitGovernanceEvent: jest.fn(),
}));
jest.mock("../utils/eval-artifact-store", () => ({
  resolveReplayBucketName: jest.fn(),
}));

import { resolveReplayBucketName } from "../utils/eval-artifact-store";
import * as replaySanitize from "../utils/replay-sanitize";
import { getEvalCaseArtifactDiff, handler } from "../eval-comparison-resolver";
import { CrossOrgRowError } from "../eval-comparison-resolver";
import { ArtifactCursorError } from "../utils/eval-artifact-view";

function authContextFor(role: string): AuthContext {
  return { userId: `user-${role}`, username: role, groups: [], roles: [role] };
}

function completedRun(overrides: Partial<EvalRun> = {}): EvalRun {
  return {
    evalRunId: "run-1",
    orgId: "org-1",
    suiteId: "suite-1",
    suiteVersion: 1,
    agentTargetId: "agent-1",
    agentTargetVersion: "v1",
    status: "COMPLETED",
    caseCount: 1,
    pendingCases: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    startedBy: "architect-1",
    idempotencyKey: "key-1",
    ...overrides,
  };
}

function caseResultRow(
  overrides: Partial<EvalRunCaseResult> = {},
): EvalRunCaseResult {
  return {
    evalRunId: "run-1",
    caseId: "case-1",
    orgId: "org-1",
    caseKind: "CONVERSATION",
    targetAdapter: "conversation",
    status: "COMPLETED",
    artifactKind: "conversation",
    artifactRef: "eval-runs/run-1/case-1.json",
    ...overrides,
  };
}

function envelopeBody(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    producerCommit: null,
    kind: "conversation",
    correlationId: "corr-1",
    orgId: "org-1",
    sanitisation: {
      redactPiiVersion: "1",
      secretPatternsVersion: "1",
      gate: "passed",
    },
    sections: {
      agentConfig: null,
      workflow: null,
      execSpec: null,
      modelConfig: null,
      governanceMode: null,
      nodes: [],
      toolResults: { partial: true, results: [], provenance: "" },
      findings: [],
      messages: [
        { role: "user", content: "hello", timestamp: "2026-01-01T00:00:00Z" },
        {
          role: "assistant",
          content: "hi there",
          timestamp: "2026-01-01T00:00:01Z",
        },
      ],
      usageTotals: {},
      traceIds: { correlationId: "corr-1" },
    },
    ...overrides,
  };
}

function s3Body(payload: unknown) {
  const stream = new Readable();
  stream.push(JSON.stringify(payload));
  stream.push(null);
  return sdkStreamMixin(stream);
}

function mockArtifact(key: string, body: unknown) {
  s3Mock
    .on(GetObjectCommand, { Bucket: "replay-bucket", Key: key })
    .callsFake(() => ({ Body: s3Body(body) }));
}

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  (resolveReplayBucketName as jest.Mock).mockReset();
  (resolveReplayBucketName as jest.Mock).mockResolvedValue("replay-bucket");
});

function mockRun(evalRunId: string, run: EvalRun | undefined) {
  ddbMock
    .on(GetCommand, {
      TableName: "citadel-eval-runs-test",
      Key: { evalRunId },
    })
    .resolves({ Item: run as Record<string, unknown> | undefined });
}

function mockCaseRow(
  evalRunId: string,
  caseId: string,
  row: EvalRunCaseResult | undefined,
) {
  ddbMock
    .on(GetCommand, {
      TableName: "citadel-eval-run-case-results-test",
      Key: { evalRunId, caseId },
    })
    .resolves({ Item: row as Record<string, unknown> | undefined });
}

const baseArgs = {
  orgId: "org-1",
  suiteId: "suite-1",
  caseId: "case-1",
  baselineEvalRunId: "baseline-run",
  candidateEvalRunId: "candidate-run",
};

// ── Test 1/2: happy path ─────────────────────────────────────────────────────
describe("getEvalCaseArtifactDiff — happy path", () => {
  test("both sides OK (conversation kind): transcript in order, sanitisation populated, availability=OK", async () => {
    mockRun("baseline-run", completedRun({ evalRunId: "baseline-run" }));
    mockRun("candidate-run", completedRun({ evalRunId: "candidate-run" }));
    mockCaseRow(
      "baseline-run",
      "case-1",
      caseResultRow({ evalRunId: "baseline-run" }),
    );
    mockCaseRow(
      "candidate-run",
      "case-1",
      caseResultRow({ evalRunId: "candidate-run" }),
    );
    mockArtifact("eval-runs/run-1/case-1.json", envelopeBody());

    const result = await getEvalCaseArtifactDiff(
      baseArgs,
      authContextFor("developer"),
    );

    expect(result.baseline.availability).toBe("OK");
    expect(result.candidate.availability).toBe("OK");
    expect(result.baseline.transcript.map((m) => m.content)).toEqual([
      "hello",
      "hi there",
    ]);
    expect(result.baseline.sanitisation).toEqual({
      redactPiiVersion: "1",
      secretPatternsVersion: "1",
      gate: "passed",
    });
  });

  test("caseKind/artifactKind correct for execution-kind case (empty transcript, populated trajectory)", async () => {
    mockRun("baseline-run", completedRun({ evalRunId: "baseline-run" }));
    mockRun("candidate-run", completedRun({ evalRunId: "candidate-run" }));
    mockCaseRow(
      "baseline-run",
      "case-1",
      caseResultRow({
        evalRunId: "baseline-run",
        caseKind: "EXECUTION",
        targetAdapter: "execution",
        artifactKind: "execution",
      }),
    );
    mockCaseRow(
      "candidate-run",
      "case-1",
      caseResultRow({
        evalRunId: "candidate-run",
        caseKind: "EXECUTION",
        targetAdapter: "execution",
        artifactKind: "execution",
      }),
    );
    mockArtifact(
      "eval-runs/run-1/case-1.json",
      envelopeBody({
        kind: "execution",
        sections: {
          ...envelopeBody().sections,
          messages: undefined,
          nodes: [
            {
              nodeId: "n1",
              inputs: {},
              outputs: { ok: true },
              status: "COMPLETED",
              retries: 0,
              usage: {},
              startedAt: "2026-01-01T00:00:00Z",
              completedAt: "2026-01-01T00:00:01Z",
              agentId: "agent-1",
            },
          ],
        },
      }),
    );

    const result = await getEvalCaseArtifactDiff(
      baseArgs,
      authContextFor("developer"),
    );

    expect(result.baseline.caseKind).toBe("EXECUTION");
    expect(result.baseline.artifactKind).toBe("execution");
    expect(result.baseline.transcript).toEqual([]);
    expect(result.baseline.trajectory.length).toBe(1);
    expect(result.baseline.trajectory[0].nodeId).toBe("n1");
  });
});

// ── Org scoping ──────────────────────────────────────────────────────────────
describe("getEvalCaseArtifactDiff — org scoping", () => {
  test("candidate run.orgId mismatch -> CrossOrgRowError, whole request rejected", async () => {
    mockRun("baseline-run", completedRun({ evalRunId: "baseline-run" }));
    mockRun(
      "candidate-run",
      completedRun({ evalRunId: "candidate-run", orgId: "org-EVIL" }),
    );

    await expect(
      getEvalCaseArtifactDiff(baseArgs, authContextFor("developer")),
    ).rejects.toThrow(CrossOrgRowError);
  });

  test("caseRow.orgId mismatch -> CrossOrgRowError", async () => {
    mockRun("baseline-run", completedRun({ evalRunId: "baseline-run" }));
    mockRun("candidate-run", completedRun({ evalRunId: "candidate-run" }));
    mockCaseRow(
      "baseline-run",
      "case-1",
      caseResultRow({ evalRunId: "baseline-run", orgId: "org-EVIL" }),
    );

    await expect(
      getEvalCaseArtifactDiff(baseArgs, authContextFor("developer")),
    ).rejects.toThrow(CrossOrgRowError);
  });

  test("row-level: artifact envelope.orgId mismatch -> CrossOrgRowError (defence in depth)", async () => {
    mockRun("baseline-run", completedRun({ evalRunId: "baseline-run" }));
    mockRun("candidate-run", completedRun({ evalRunId: "candidate-run" }));
    mockCaseRow(
      "baseline-run",
      "case-1",
      caseResultRow({ evalRunId: "baseline-run" }),
    );
    mockCaseRow(
      "candidate-run",
      "case-1",
      caseResultRow({ evalRunId: "candidate-run" }),
    );
    mockArtifact(
      "eval-runs/run-1/case-1.json",
      envelopeBody({ orgId: "org-EVIL" }),
    );

    await expect(
      getEvalCaseArtifactDiff(baseArgs, authContextFor("developer")),
    ).rejects.toThrow(CrossOrgRowError);
  });
});

// ── Honest absence states ────────────────────────────────────────────────────
describe("getEvalCaseArtifactDiff — honest absence states", () => {
  test("candidate has no case row (present on baseline only) -> CASE_ABSENT, baseline OK, result not null", async () => {
    mockRun("baseline-run", completedRun({ evalRunId: "baseline-run" }));
    mockRun("candidate-run", completedRun({ evalRunId: "candidate-run" }));
    mockCaseRow(
      "baseline-run",
      "case-1",
      caseResultRow({ evalRunId: "baseline-run" }),
    );
    mockCaseRow("candidate-run", "case-1", undefined);
    mockArtifact("eval-runs/run-1/case-1.json", envelopeBody());

    const result = await getEvalCaseArtifactDiff(
      baseArgs,
      authContextFor("developer"),
    );
    expect(result.baseline.availability).toBe("OK");
    expect(result.candidate.availability).toBe("CASE_ABSENT");
    expect(result).not.toBeNull();
  });

  test("artifactRef unset -> ARTIFACT_MISSING (not CASE_ABSENT, not OK)", async () => {
    mockRun("baseline-run", completedRun({ evalRunId: "baseline-run" }));
    mockRun("candidate-run", completedRun({ evalRunId: "candidate-run" }));
    mockCaseRow(
      "baseline-run",
      "case-1",
      caseResultRow({ evalRunId: "baseline-run", artifactRef: undefined }),
    );
    mockCaseRow(
      "candidate-run",
      "case-1",
      caseResultRow({ evalRunId: "candidate-run" }),
    );
    mockArtifact("eval-runs/run-1/case-1.json", envelopeBody());

    const result = await getEvalCaseArtifactDiff(
      baseArgs,
      authContextFor("developer"),
    );
    expect(result.baseline.availability).toBe("ARTIFACT_MISSING");
  });

  test("artifactRef set, S3 GetObject throws NoSuchKey -> ARTIFACT_UNRESOLVED (distinct from ARTIFACT_MISSING)", async () => {
    mockRun("baseline-run", completedRun({ evalRunId: "baseline-run" }));
    mockRun("candidate-run", completedRun({ evalRunId: "candidate-run" }));
    mockCaseRow(
      "baseline-run",
      "case-1",
      caseResultRow({ evalRunId: "baseline-run" }),
    );
    mockCaseRow(
      "candidate-run",
      "case-1",
      caseResultRow({ evalRunId: "candidate-run" }),
    );
    s3Mock
      .on(GetObjectCommand, {
        Bucket: "replay-bucket",
        Key: "eval-runs/run-1/case-1.json",
      })
      .rejects(Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" }));

    const result = await getEvalCaseArtifactDiff(
      baseArgs,
      authContextFor("developer"),
    );
    expect(result.baseline.availability).toBe("ARTIFACT_UNRESOLVED");
    expect(result.candidate.availability).toBe("ARTIFACT_UNRESOLVED");
  });

  test("run absent -> RUN_ABSENT; run exists but not COMPLETED -> RUN_NOT_COMPLETED", async () => {
    mockRun("baseline-run", undefined);
    mockRun(
      "candidate-run",
      completedRun({ evalRunId: "candidate-run", status: "RUNNING" }),
    );

    const result = await getEvalCaseArtifactDiff(
      baseArgs,
      authContextFor("developer"),
    );
    expect(result.baseline.availability).toBe("RUN_ABSENT");
    expect(result.candidate.availability).toBe("RUN_NOT_COMPLETED");
  });

  test("both sides ARTIFACT_MISSING -> well-formed diff returned (not null/throw)", async () => {
    mockRun("baseline-run", completedRun({ evalRunId: "baseline-run" }));
    mockRun("candidate-run", completedRun({ evalRunId: "candidate-run" }));
    mockCaseRow(
      "baseline-run",
      "case-1",
      caseResultRow({ evalRunId: "baseline-run", artifactRef: undefined }),
    );
    mockCaseRow(
      "candidate-run",
      "case-1",
      caseResultRow({ evalRunId: "candidate-run", artifactRef: undefined }),
    );

    const result = await getEvalCaseArtifactDiff(
      baseArgs,
      authContextFor("developer"),
    );
    expect(result.baseline.availability).toBe("ARTIFACT_MISSING");
    expect(result.candidate.availability).toBe("ARTIFACT_MISSING");
    expect(result.suiteId).toBe("suite-1");
    expect(result.caseId).toBe("case-1");
  });
});

// ── Sanitisation (adversarial) ───────────────────────────────────────────────
describe("getEvalCaseArtifactDiff — sanitisation reuse", () => {
  test("stored artifact with embedded PII (AWS access key id) is redacted; gate passes", async () => {
    mockRun("baseline-run", completedRun({ evalRunId: "baseline-run" }));
    mockRun("candidate-run", completedRun({ evalRunId: "candidate-run" }));
    mockCaseRow(
      "baseline-run",
      "case-1",
      caseResultRow({ evalRunId: "baseline-run" }),
    );
    mockCaseRow(
      "candidate-run",
      "case-1",
      caseResultRow({ evalRunId: "candidate-run" }),
    );
    mockArtifact(
      "eval-runs/run-1/case-1.json",
      envelopeBody({
        sections: {
          ...envelopeBody().sections,
          messages: [
            {
              role: "user",
              content: "my aws key is AKIAABCDEFGHIJKLMNOP",
              timestamp: "2026-01-01T00:00:00Z",
            },
          ],
        },
      }),
    );

    const result = await getEvalCaseArtifactDiff(
      baseArgs,
      authContextFor("developer"),
    );
    expect(result.baseline.availability).toBe("OK");
    expect(result.baseline.transcript[0].content).not.toContain(
      "AKIAABCDEFGHIJKLMNOP",
    );
    expect(result.baseline.transcript[0].content).toContain(
      "[REDACTED:aws-access-key-id]",
    );
  });

  test("mutation-kill: sanitizeBundle stubbed to identity, secret still present -> assertBundleSecretFree throws -> ARTIFACT_WITHHELD_SANITISATION, no raw content leaks", async () => {
    const spy = jest
      .spyOn(replaySanitize, "sanitizeBundle")
      .mockImplementation((x: unknown) => x); // identity stub — mutation-kill

    mockRun("baseline-run", completedRun({ evalRunId: "baseline-run" }));
    mockRun("candidate-run", completedRun({ evalRunId: "candidate-run" }));
    mockCaseRow(
      "baseline-run",
      "case-1",
      caseResultRow({ evalRunId: "baseline-run" }),
    );
    mockCaseRow(
      "candidate-run",
      "case-1",
      caseResultRow({ evalRunId: "candidate-run" }),
    );
    mockArtifact(
      "eval-runs/run-1/case-1.json",
      envelopeBody({
        sections: {
          ...envelopeBody().sections,
          messages: [
            {
              role: "user",
              content: "raw secret: aB3dEf6HiJ9kLmN0pQrS2tUvW4xY7zA1b",
              timestamp: "2026-01-01T00:00:00Z",
            },
          ],
        },
      }),
    );

    const result = await getEvalCaseArtifactDiff(
      baseArgs,
      authContextFor("developer"),
    );
    expect(result.baseline.availability).toBe("ARTIFACT_WITHHELD_SANITISATION");
    expect(JSON.stringify(result.baseline)).not.toContain(
      "aB3dEf6HiJ9kLmN0pQrS2tUvW4xY7zA1b",
    );

    spy.mockRestore();
  });

  test("a withheld side does not withhold the other side", async () => {
    mockRun("baseline-run", completedRun({ evalRunId: "baseline-run" }));
    mockRun("candidate-run", completedRun({ evalRunId: "candidate-run" }));
    mockCaseRow(
      "baseline-run",
      "case-1",
      caseResultRow({ evalRunId: "baseline-run", artifactRef: undefined }),
    );
    mockCaseRow(
      "candidate-run",
      "case-1",
      caseResultRow({ evalRunId: "candidate-run" }),
    );
    mockArtifact("eval-runs/run-1/case-1.json", envelopeBody());

    const result = await getEvalCaseArtifactDiff(
      baseArgs,
      authContextFor("developer"),
    );
    expect(result.baseline.availability).toBe("ARTIFACT_MISSING");
    expect(result.candidate.availability).toBe("OK");
  });
});

// ── Bounding via handler-level integration ───────────────────────────────────
describe("getEvalCaseArtifactDiff — bounding, pagination, cursor tampering", () => {
  test("malformed cursor -> ValidationError (not a crash, not a full dump)", async () => {
    mockRun("baseline-run", completedRun({ evalRunId: "baseline-run" }));
    mockRun("candidate-run", completedRun({ evalRunId: "candidate-run" }));
    mockCaseRow(
      "baseline-run",
      "case-1",
      caseResultRow({ evalRunId: "baseline-run" }),
    );
    mockCaseRow(
      "candidate-run",
      "case-1",
      caseResultRow({ evalRunId: "candidate-run" }),
    );
    mockArtifact("eval-runs/run-1/case-1.json", envelopeBody());

    await expect(
      getEvalCaseArtifactDiff(
        { ...baseArgs, transcriptCursor: "!!!tampered###" },
        authContextFor("developer"),
      ),
    ).rejects.toThrow(ArtifactCursorError);
  });
});

// ── Auth ──────────────────────────────────────────────────────────────────────
describe("getEvalCaseArtifactDiff — auth", () => {
  test("authContext lacking eval:run -> UnauthorizedError, no data returned", async () => {
    await expect(
      getEvalCaseArtifactDiff(baseArgs, authContextFor("project_manager")),
    ).rejects.toThrow(/UnauthorizedError/);
    expect(ddbMock.calls().length).toBe(0);
  });

  test.each(["developer", "architect", "admin"])(
    "%s role is permitted",
    async (role) => {
      mockRun("baseline-run", completedRun({ evalRunId: "baseline-run" }));
      mockRun("candidate-run", completedRun({ evalRunId: "candidate-run" }));
      mockCaseRow(
        "baseline-run",
        "case-1",
        caseResultRow({ evalRunId: "baseline-run", artifactRef: undefined }),
      );
      mockCaseRow(
        "candidate-run",
        "case-1",
        caseResultRow({ evalRunId: "candidate-run", artifactRef: undefined }),
      );

      await expect(
        getEvalCaseArtifactDiff(baseArgs, authContextFor(role)),
      ).resolves.toBeDefined();
    },
  );
});

// ── Read-only invariant ───────────────────────────────────────────────────────
describe("getEvalCaseArtifactDiff — read-only invariant", () => {
  test("issues no PutItem/UpdateItem on any path", async () => {
    mockRun("baseline-run", completedRun({ evalRunId: "baseline-run" }));
    mockRun("candidate-run", completedRun({ evalRunId: "candidate-run" }));
    mockCaseRow(
      "baseline-run",
      "case-1",
      caseResultRow({ evalRunId: "baseline-run" }),
    );
    mockCaseRow(
      "candidate-run",
      "case-1",
      caseResultRow({ evalRunId: "candidate-run" }),
    );
    mockArtifact("eval-runs/run-1/case-1.json", envelopeBody());

    await getEvalCaseArtifactDiff(baseArgs, authContextFor("developer"));

    expect(ddbMock.commandCalls(PutCommand).length).toBe(0);
    expect(ddbMock.commandCalls(UpdateCommand).length).toBe(0);
  });
});

// ── Handler dispatch ──────────────────────────────────────────────────────────
describe("handler dispatch — getEvalCaseArtifactDiff field", () => {
  test("routes Query.getEvalCaseArtifactDiff to getEvalCaseArtifactDiff", async () => {
    mockRun("baseline-run", completedRun({ evalRunId: "baseline-run" }));
    mockRun("candidate-run", completedRun({ evalRunId: "candidate-run" }));
    mockCaseRow(
      "baseline-run",
      "case-1",
      caseResultRow({ evalRunId: "baseline-run", artifactRef: undefined }),
    );
    mockCaseRow(
      "candidate-run",
      "case-1",
      caseResultRow({ evalRunId: "candidate-run", artifactRef: undefined }),
    );

    const result = (await handler({
      info: { fieldName: "getEvalCaseArtifactDiff" },
      arguments: baseArgs,
      identity: { sub: "user-1", "custom:role": "developer" },
    } as never)) as { baseline: { availability: string } };

    expect(result.baseline.availability).toBe("ARTIFACT_MISSING");
  });
});
