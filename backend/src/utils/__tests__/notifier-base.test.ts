// ---------------------------------------------------------------------------
// R8 — buildGovernanceNotification: whitelist projection, redaction,
// Subject length cap, deep-link assembly (finding e396a7ee, design §2).
// ---------------------------------------------------------------------------

describe("R8: buildGovernanceNotification — whitelist projection + redaction", () => {
  test("R8a: builds Subject <=100 chars and whitelisted body for governance.release.auto_rollback", () => {
    const { subject, body } = buildGovernanceNotification(
      "governance.release.auto_rollback",
      {
        orgId: "org_ACME",
        agentTargetId: "agent-1",
        environment: "prod",
        action: "AUTO_ABORT_CANARY",
        metric: "error_rate",
        observedValue: 0.42,
        threshold: 0.05,
        sampleCount: 500,
        fromReleaseId: "rel-1",
        toReleaseId: "rel-2",
        candidateReleaseId: "rel-2",
        fromVersion: 3,
      },
      {
        env: "prod",
        eventId: "evt-1",
        eventTime: "2026-09-03T00:00:00Z",
        correlationId: "corr-1",
        runId: undefined,
        governanceUiBaseUrl: "https://ui.example.com",
      },
    );
    expect(subject.length).toBeLessThanOrEqual(100);
    expect(subject).toContain("org_ACME");
    expect(body).toContain("governance.release.auto_rollback");
    expect(body).toContain("org_ACME");
    expect(body).toContain("corr-1");
    expect(body).toContain("https://ui.example.com");
    expect(body).toContain("evt-1");
  });

  test("R8b: NEVER includes a non-whitelisted field injected into detail", () => {
    const { body } = buildGovernanceNotification(
      "governance.offfrontier.escalated",
      {
        projectId: "p1",
        agentId: "agent-1",
        reason: "drifted",
        // @ts-expect-error — simulating an attacker/bug adding an extra field
        secretToken: "sk-super-secret-value",
      },
      {
        env: "prod",
        eventId: "evt-2",
        eventTime: "2026-09-03T00:00:00Z",
      },
    );
    expect(body).not.toContain("sk-super-secret-value");
    expect(body).not.toContain("secretToken");
  });

  test("R8c: strips <script> tags and length-caps free-text fields (e.g. reason)", () => {
    const longReason = "x".repeat(500) + "<script>alert(1)</script>";
    const { body } = buildGovernanceNotification(
      "governance.offfrontier.escalated",
      {
        projectId: "p1",
        agentId: "agent-1",
        reason: longReason,
      },
      {
        env: "prod",
        eventId: "evt-3",
        eventTime: "2026-09-03T00:00:00Z",
      },
    );
    expect(body).not.toContain("<script>");
    // capped well below the raw 500+26 char input
    const reasonLine = body
      .split("\n")
      .find((l) => l.toLowerCase().includes("summary"));
    expect(reasonLine).toBeDefined();
    expect(reasonLine!.length).toBeLessThan(400);
  });

  test("R8d: omits deep-link URL text gracefully when governanceUiBaseUrl is not configured", () => {
    const { body } = buildGovernanceNotification(
      "governance.offfrontier.escalated",
      { projectId: "p1", agentId: "agent-1", reason: "drift" },
      { env: "prod", eventId: "evt-4", eventTime: "2026-09-03T00:00:00Z" },
    );
    expect(body).toMatch(/governance UI URL not configured/i);
  });

  test("R8e: Subject truncates to <=100 chars for a long org id", () => {
    const { subject } = buildGovernanceNotification(
      "governance.offfrontier.escalated",
      {
        projectId: "p1",
        agentId: "agent-1",
        reason: "x".repeat(200),
      },
      {
        env: "prod",
        eventId: "evt-5",
        eventTime: "2026-09-03T00:00:00Z",
        org: "org_" + "y".repeat(200),
      },
    );
    expect(subject.length).toBeLessThanOrEqual(100);
  });
});

// ---------------------------------------------------------------------------
// R9 — lock-step: every CRITICAL_GOVERNANCE_DETAIL_TYPES member must be
// present in GOVERNANCE_DETAIL_TYPES (routing gap guard, finding 163d4776).
// The rule-list half of the lock-step lives in
// backend/test/governance-notifier-durable-destination.test.ts (needs a
// CDK synth of GovernanceEventsRule).
// ---------------------------------------------------------------------------

describe("R9: CRITICAL_GOVERNANCE_DETAIL_TYPES lock-step with GOVERNANCE_DETAIL_TYPES", () => {
  test("R9a: every CRITICAL type is a member of GOVERNANCE_DETAIL_TYPES", () => {
    const all = new Set<string>(GOVERNANCE_DETAIL_TYPES);
    for (const critical of CRITICAL_GOVERNANCE_DETAIL_TYPES) {
      expect(all.has(critical)).toBe(true);
    }
  });

  test("R9b: CRITICAL_GOVERNANCE_DETAIL_TYPES contains exactly the designed set", () => {
    expect([...CRITICAL_GOVERNANCE_DETAIL_TYPES].sort()).toEqual(
      [
        "governance.offfrontier.escalated",
        "governance.release.auto_rollback",
      ].sort(),
    );
  });

  test("R9c: CRITICAL_GOVERNANCE_DETAIL_TYPES has no duplicate entries", () => {
    expect(new Set(CRITICAL_GOVERNANCE_DETAIL_TYPES).size).toBe(
      CRITICAL_GOVERNANCE_DETAIL_TYPES.length,
    );
  });
});
import { mockClient } from "aws-sdk-client-mock";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import * as fc from "fast-check";
import {
  emitGovernanceEvent,
  __resetGovernanceNotifierForTest,
  GOVERNANCE_DETAIL_TYPES,
  CRITICAL_GOVERNANCE_DETAIL_TYPES,
  buildGovernanceNotification,
  type GovernanceDetailType,
} from "../notifier-base";

const ebMock = mockClient(EventBridgeClient);

describe("notifier-base emitGovernanceEvent", () => {
  beforeEach(() => {
    ebMock.reset();
    ebMock
      .on(PutEventsCommand)
      .resolves({ FailedEntryCount: 0, Entries: [{ EventId: "evt-1" }] });
    __resetGovernanceNotifierForTest();
    process.env.EVENT_BUS_NAME = "citadel-agents-test";
  });

  test("emits governance.adr.locked with correct Source, DetailType, Detail", async () => {
    await emitGovernanceEvent(
      "governance.adr.locked",
      {
        projectId: "p1",
        adrId: "a1",
        title: "Use Postgres",
        sourceRoundIds: ["r1", "r2"],
      },
      "corr-1",
    );
    const calls = ebMock.commandCalls(PutEventsCommand);
    expect(calls).toHaveLength(1);
    const entry = calls[0].args[0].input.Entries![0];
    expect(entry.Source).toBe("citadel.backend");
    expect(entry.DetailType).toBe("governance.adr.locked");
    expect(entry.EventBusName).toBe("citadel-agents-test");
    const detail = JSON.parse(entry.Detail!);
    expect(detail.projectId).toBe("p1");
    expect(detail.adrId).toBe("a1");
    expect(detail.title).toBe("Use Postgres");
    expect(detail.sourceRoundIds).toEqual(["r1", "r2"]);
    expect(detail.correlationId).toBe("corr-1");
    expect(detail.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  test("emits without correlationId when omitted", async () => {
    await emitGovernanceEvent("governance.round.started", {
      projectId: "p1",
      roundN: 1,
    });
    const calls = ebMock.commandCalls(PutEventsCommand);
    const detail = JSON.parse(calls[0].args[0].input.Entries![0].Detail!);
    expect(detail.correlationId).toBeUndefined();
  });

  test("strips <script> tags from string fields", async () => {
    await emitGovernanceEvent("governance.specification.rejected", {
      projectId: "p1",
      specId: "s1",
      reason: "nope<script>alert(1)</script>bad",
      rejectedBy: "user-1",
    });
    const detail = JSON.parse(
      ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0]
        .Detail!,
    );
    expect(detail.reason).toBe("nopebad");
    expect(detail.reason).not.toContain("<script>");
  });

  test("strips <iframe> tags from string fields", async () => {
    await emitGovernanceEvent("governance.specification.rejected", {
      projectId: "p1",
      specId: "s1",
      reason: 'foo<iframe src="evil"></iframe>bar',
      rejectedBy: "user-1",
    });
    const detail = JSON.parse(
      ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0]
        .Detail!,
    );
    expect(detail.reason).toBe("foobar");
  });

  test("strips <object> tags from string fields", async () => {
    await emitGovernanceEvent("governance.specification.rejected", {
      projectId: "p1",
      specId: "s1",
      reason: 'a<object data="x"></object>b',
      rejectedBy: "user-1",
    });
    const detail = JSON.parse(
      ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0]
        .Detail!,
    );
    expect(detail.reason).toBe("ab");
  });

  test("preserves non-string fields (numbers, booleans, arrays) without mutation", async () => {
    await emitGovernanceEvent("governance.round.transcript.overflow", {
      projectId: "p1",
      roundN: 3,
      sizeBytes: 5242880,
    });
    const detail = JSON.parse(
      ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0]
        .Detail!,
    );
    expect(detail.roundN).toBe(3);
    expect(detail.sizeBytes).toBe(5242880);
  });

  test("GOVERNANCE_DETAIL_TYPES contains exactly 26 values", () => {
    expect(GOVERNANCE_DETAIL_TYPES).toHaveLength(26);
    expect(new Set(GOVERNANCE_DETAIL_TYPES).size).toBe(26);
  });

  test("GovernanceDetailType union matches GOVERNANCE_DETAIL_TYPES array", () => {
    const expected: GovernanceDetailType[] = [
      "governance.adr.locked",
      "governance.adr.reopen.attempted",
      "governance.specification.created",
      "governance.specification.approved",
      "governance.specification.rejected",
      "governance.round.started",
      "governance.round.completed",
      "governance.round.transcript.overflow",
      "governance.archetype.classified",
      "governance.offfrontier.escalated",
      "governance.grandfathered.bypass",
      "governance.mode.transition",
      "governance.constitutional.rule.changed",
      "governance.caselaw.changed",
      "governance.eval.suite.frozen",
      "governance.eval.run.started",
      "governance.eval.run.completed",
      "governance.eval.case.completed",
      "governance.eval.case.judge.requested",
      "governance.eval.case.judged",
      "governance.eval.sample.captured",
      "governance.eval.drift.detected",
      "governance.eval.baseline.designated",
      "governance.eval.comparison.completed",
      "governance.eval.seed.heal.blocked",
      "governance.release.auto_rollback",
    ];
    expect([...GOVERNANCE_DETAIL_TYPES].sort()).toEqual([...expected].sort());
  });

  test("emits governance.eval.case.completed with evalRunId/caseId/orgId/caseKind", async () => {
    await emitGovernanceEvent("governance.eval.case.completed", {
      evalRunId: "run-1",
      caseId: "case-1",
      orgId: "org-1",
      caseKind: "CONVERSATION",
      artifactRef: "eval-runs/run-1/case-1.json",
    });
    const detail = JSON.parse(
      ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0]
        .Detail!,
    );
    expect(detail.evalRunId).toBe("run-1");
    expect(detail.caseId).toBe("case-1");
    expect(detail.caseKind).toBe("CONVERSATION");
    expect(detail.artifactRef).toBe("eval-runs/run-1/case-1.json");
  });

  test("emits governance.eval.case.completed without artifactRef when materialization was skipped", async () => {
    await emitGovernanceEvent("governance.eval.case.completed", {
      evalRunId: "run-1",
      caseId: "case-2",
      orgId: "org-1",
      caseKind: "EXECUTION",
    });
    const detail = JSON.parse(
      ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0]
        .Detail!,
    );
    expect(detail.artifactRef).toBeUndefined();
  });

  test("emits governance.eval.case.judge.requested with judgeDimensions + judgeSlot", async () => {
    await emitGovernanceEvent("governance.eval.case.judge.requested", {
      evalRunId: "run-1",
      caseId: "case-1",
      orgId: "org-1",
      artifactRef: "eval-runs/run-1/case-1.json",
      judgeDimensions: [
        { dimension: "task_success", rubric: "match target text" },
      ],
      judgeSlot: "judge",
    });
    const detail = JSON.parse(
      ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0]
        .Detail!,
    );
    expect(detail.judgeSlot).toBe("judge");
    expect(detail.judgeDimensions).toEqual([
      { dimension: "task_success", rubric: "match target text" },
    ]);
  });

  test("emits governance.eval.case.judged with SCORED status and full reproducibility stamp", async () => {
    await emitGovernanceEvent("governance.eval.case.judged", {
      evalRunId: "run-1",
      caseId: "case-1",
      orgId: "org-1",
      dimension: "task_success",
      status: "SCORED",
      verdict: { kind: "score", score: 0.9 },
      judgeModelId: "us.anthropic.claude-sonnet-4-6",
      judgeModelVersion: "judge-v1:us.anthropic.claude-sonnet-4-6",
      judgePromptHash: "sha256:deadbeef",
    });
    const detail = JSON.parse(
      ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0]
        .Detail!,
    );
    expect(detail.status).toBe("SCORED");
    expect(detail.verdict).toEqual({ kind: "score", score: 0.9 });
    expect(detail.judgeModelId).toBe("us.anthropic.claude-sonnet-4-6");
    expect(detail.judgeModelVersion).toBe(
      "judge-v1:us.anthropic.claude-sonnet-4-6",
    );
    expect(detail.judgePromptHash).toBe("sha256:deadbeef");
  });

  test("emits governance.eval.case.judged with UNKNOWN status and no verdict", async () => {
    await emitGovernanceEvent("governance.eval.case.judged", {
      evalRunId: "run-1",
      caseId: "case-1",
      orgId: "org-1",
      dimension: "groundedness_faithfulness",
      status: "UNKNOWN",
      judgeModelId: "us.anthropic.claude-sonnet-4-6",
      judgeModelVersion: "judge-v1:us.anthropic.claude-sonnet-4-6",
      judgePromptHash: "sha256:deadbeef",
    });
    const detail = JSON.parse(
      ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0]
        .Detail!,
    );
    expect(detail.status).toBe("UNKNOWN");
    expect(detail.verdict).toBeUndefined();
  });

  test("falls back to default event bus when EVENT_BUS_NAME is unset", async () => {
    delete process.env.EVENT_BUS_NAME;
    __resetGovernanceNotifierForTest();
    await emitGovernanceEvent("governance.round.started", {
      projectId: "p1",
      roundN: 1,
    });
    const entry =
      ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0];
    // Falls back to 'default' or the agent bus name; implementation choice.
    expect(entry.EventBusName).toBeDefined();
  });

  test("emits archetype.classified with archetype + confidence", async () => {
    await emitGovernanceEvent("governance.archetype.classified", {
      projectId: "p1",
      archetype: "MONOLITHIC_DB",
      archetypeConfidence: 0.85,
    });
    const detail = JSON.parse(
      ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0]
        .Detail!,
    );
    expect(detail.archetype).toBe("MONOLITHIC_DB");
    expect(detail.archetypeConfidence).toBe(0.85);
  });

  test("emits grandfathered.bypass with gate metadata", async () => {
    await emitGovernanceEvent("governance.grandfathered.bypass", {
      projectId: "p1",
      bypassedGate: "C7_adr_required",
      projectCreatedAt: "2026-04-01T00:00:00Z",
      effectiveAt: "2026-05-15T00:00:00Z",
    });
    const detail = JSON.parse(
      ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0]
        .Detail!,
    );
    expect(detail.bypassedGate).toBe("C7_adr_required");
  });

  test("propagates EventBridge errors to the caller", async () => {
    ebMock.reset();
    ebMock.on(PutEventsCommand).rejects(new Error("ThrottlingException"));
    await expect(
      emitGovernanceEvent("governance.round.started", {
        projectId: "p1",
        roundN: 1,
      }),
    ).rejects.toThrow("ThrottlingException");
  });

  test("property: sanitisation is idempotent — emitting same sanitised payload twice produces same Detail", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          projectId: fc
            .string({ minLength: 1, maxLength: 20 })
            .filter((s) => !s.includes("<") && !s.includes(">")),
          specId: fc
            .string({ minLength: 1, maxLength: 20 })
            .filter((s) => !s.includes("<") && !s.includes(">")),
          reason: fc.string({ maxLength: 100 }),
          rejectedBy: fc
            .string({ minLength: 1, maxLength: 20 })
            .filter((s) => !s.includes("<") && !s.includes(">")),
        }),
        async (payload) => {
          ebMock.reset();
          ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });
          await emitGovernanceEvent(
            "governance.specification.rejected",
            payload,
          );
          const firstDetail = JSON.parse(
            ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0]
              .Detail!,
          );
          ebMock.reset();
          ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });
          await emitGovernanceEvent("governance.specification.rejected", {
            projectId: firstDetail.projectId,
            specId: firstDetail.specId,
            reason: firstDetail.reason,
            rejectedBy: firstDetail.rejectedBy,
          });
          const secondDetail = JSON.parse(
            ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0]
              .Detail!,
          );
          // Everything except timestamp must be identical — sanitisation is idempotent.
          return (
            secondDetail.projectId === firstDetail.projectId &&
            secondDetail.specId === firstDetail.specId &&
            secondDetail.reason === firstDetail.reason &&
            secondDetail.rejectedBy === firstDetail.rejectedBy
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  test("property: no <script>/<iframe>/<object> tags survive sanitisation across 200 random reasons", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 200 }), async (raw) => {
        ebMock.reset();
        ebMock.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });
        const withTag = `prefix<script>${raw}</script>suffix<iframe>${raw}</iframe><object>${raw}</object>end`;
        await emitGovernanceEvent("governance.specification.rejected", {
          projectId: "p1",
          specId: "s1",
          reason: withTag,
          rejectedBy: "u1",
        });
        const detail = JSON.parse(
          ebMock.commandCalls(PutEventsCommand)[0].args[0].input.Entries![0]
            .Detail!,
        );
        return (
          !/<script/i.test(detail.reason) &&
          !/<iframe/i.test(detail.reason) &&
          !/<object/i.test(detail.reason)
        );
      }),
      { numRuns: 200 },
    );
  });
});
