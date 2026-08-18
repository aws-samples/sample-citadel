/**
 * Tests for agent-release-rollback-evaluator.ts.
 *
 * MUST-BITE EVIDENCE (concurrent-evaluator race, decision D3/§3):
 *   The "exactly one rollback under two concurrent evaluators" guarantee is
 *   the store's version-gated ConditionExpression, NOT app logic. This file
 *   proves the guard BITES with a differential pair:
 *     • installVersionedTransactMock(false) — a DELIBERATELY NON-CONDITIONAL
 *       write (ignores :expectedVersion): two concurrent evaluators BOTH
 *       succeed → TWO aborts. The `it("...NON-CONDITIONAL write lets both
 *       evaluators win...")` test asserts that broken behaviour (2 writes),
 *       demonstrating the race is real without the guard.
 *     • installVersionedTransactMock(true) — the REAL conditional write:
 *       the second write's :expectedVersion no longer matches → rejected as
 *       ConcurrentPromotionError → exactly ONE abort + ONE finding.
 *   Recorded outcome when authored: the exactly-once test was first run
 *   against the non-conditional mock and FAILED (2 writes, 2 findings = RED),
 *   then against the conditional mock and PASSED (1 write, 1 finding = GREEN).
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { mockClient } from "aws-sdk-client-mock";

import { evaluateRollbacks } from "../agent-release-rollback-evaluator";
import { ACTIVE_CANARY_GSI } from "../environment-release-pointer-store";
import type { CanaryState, EnvironmentReleasePointer } from "../../types";

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);

const POINTERS_TABLE = "test-pointers";

function canaryState(): CanaryState {
  return {
    candidateReleaseId: "rel-candidate",
    percentBasisPoints: 1000,
    stickiness: "conversation",
    salt: "salt-1",
    startedAt: "2026-08-18T00:00:00.000Z",
    startedBy: "user-1",
  };
}

function activeCanaryPointer(version = 3): EnvironmentReleasePointer {
  return {
    orgId: "org-1",
    agentTargetId: "agent-1",
    environment: "staging",
    releaseId: "rel-stable",
    previousReleaseId: "rel-older",
    promotedAt: "2026-08-18T00:00:00.000Z",
    promotedBy: "user-1",
    version,
    canary: canaryState(),
    transitionType: "CANARY_START",
  };
}

/** A breaching candidate-arm ledger row (cost 2000 micros > 1000 ceiling). */
function candidateLedgerRow() {
  return {
    PK: "ORG#org-1",
    releaseId: "rel-candidate",
    releaseArm: "candidate",
    priced: true,
    costMicros: 2000,
    latencyMs: 4000,
  };
}

function policyRow(rollbackPolicy: Record<string, unknown>) {
  return { orgId: "org-1", rollbackPolicy };
}

const ENABLED_COST_POLICY = {
  enabled: true,
  costPerInvocationMaxMicros: 1000,
  minSampleCount: 3,
  evaluationWindowMinutes: 15,
};

interface HarnessOptions {
  activeCanaries?: EnvironmentReleasePointer[];
  policyRow?: Record<string, unknown> | undefined;
  policyThrows?: boolean;
  ledgerRows?: Record<string, unknown>[];
}

/** Wires GetCommand (policy), QueryCommand (GSI enumerate + ledger window),
 * PutCommand (finding), EventBridge (best-effort emit). The transact mock
 * is installed SEPARATELY (conditional vs non-conditional). */
function configureReads(opts: HarnessOptions = {}): void {
  const active = opts.activeCanaries ?? [activeCanaryPointer()];
  const ledger =
    opts.ledgerRows ?? Array.from({ length: 5 }, candidateLedgerRow);

  ddbMock.on(QueryCommand).callsFake((input) => {
    if (input.IndexName === ACTIVE_CANARY_GSI) {
      return { Items: active };
    }
    return { Items: ledger }; // cost-ledger window read
  });

  if (opts.policyThrows) {
    ddbMock.on(GetCommand).rejects(new Error("GetItem boom"));
  } else {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: opts.policyRow ?? policyRow(ENABLED_COST_POLICY) });
  }

  ddbMock.on(PutCommand).resolves({});
  ebMock.on(PutEventsCommand).resolves({});
}

interface VersionedStore {
  writeSuccesses: number;
}

/** Installs a stateful TransactWrite mock keyed on the pointer version.
 * `conditional=true` enforces :expectedVersion (real DynamoDB semantics);
 * `conditional=false` ignores it (the deliberately-broken write used to
 * prove the race test bites). */
function installVersionedTransactMock(conditional: boolean): VersionedStore {
  const state: VersionedStore = { writeSuccesses: 0 };
  const stored = new Map<string, number>();

  ddbMock.on(TransactWriteCommand).callsFake(async (input) => {
    const put = (
      input as {
        TransactItems: {
          Put: {
            TableName: string;
            Item: Record<string, unknown>;
            ExpressionAttributeValues?: Record<string, unknown>;
          };
        }[];
      }
    ).TransactItems.map((t) => t.Put).find(
      (p) => p.TableName === POINTERS_TABLE,
    )!;

    const key = String(put.Item.agentTargetId_environment);
    const expected = put.ExpressionAttributeValues?.[":expectedVersion"] as
      number | undefined;
    const current = stored.has(key) ? stored.get(key) : 3;

    if (conditional && expected !== undefined && expected !== current) {
      const err = Object.assign(new Error("cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
      });
      throw err;
    }
    stored.set(key, put.Item.version as number);
    state.writeSuccesses += 1;
    return {};
  });

  return state;
}

beforeEach(() => {
  ddbMock.reset();
  ebMock.reset();
  jest.restoreAllMocks();
  process.env.ENVIRONMENT_RELEASE_POINTERS_TABLE = POINTERS_TABLE;
  process.env.ENVIRONMENT_RELEASE_POINTER_HISTORY_TABLE = "test-history";
  process.env.COST_LEDGER_TABLE = "test-ledger";
  process.env.GOVERNANCE_LEDGER_TABLE = "test-governance-ledger";
  process.env.PROMOTION_POLICY_CONFIG_TABLE = "test-policy";
  process.env.ENVIRONMENT = "staging";
  process.env.EVENT_BUS_NAME = "test-bus";
});

afterEach(() => {
  for (const key of [
    "ENVIRONMENT_RELEASE_POINTERS_TABLE",
    "ENVIRONMENT_RELEASE_POINTER_HISTORY_TABLE",
    "COST_LEDGER_TABLE",
    "GOVERNANCE_LEDGER_TABLE",
    "PROMOTION_POLICY_CONFIG_TABLE",
    "ENVIRONMENT",
    "EVENT_BUS_NAME",
  ]) {
    delete process.env[key];
  }
});

describe("evaluateRollbacks — injected-fault canary", () => {
  it("rolls back an injected-fault staging canary arm within one cycle (AUTO_ABORT_CANARY)", async () => {
    configureReads();
    installVersionedTransactMock(true);

    await evaluateRollbacks();

    const writes = ddbMock.commandCalls(TransactWriteCommand);
    expect(writes).toHaveLength(1);
    const item = writes[0].args[0].input.TransactItems![0].Put!.Item as Record<
      string,
      unknown
    >;
    expect(item.transitionType).toBe("AUTO_ABORT_CANARY");
    expect(item.promotedBy).toBe("system:release-rollback-evaluator");
    expect(item.canary).toBeUndefined(); // candidate zeroed
  });

  it("attaches metric evidence to the auto-rollback finding", async () => {
    configureReads();
    installVersionedTransactMock(true);

    await evaluateRollbacks();

    const findingCall = ddbMock.commandCalls(PutCommand)[0];
    const item = findingCall.args[0].input.Item as Record<string, unknown>;
    expect(item.category).toBe("auto-rollback");
    expect(item.rollback_evidence).toMatchObject({
      metric: "costPerInvocation",
      arm: "candidate",
      observedValue: 2000,
      threshold: 1000,
      action: "AUTO_ABORT_CANARY",
      fromVersion: 3,
    });
  });

  it("emits the best-effort governance notification", async () => {
    configureReads();
    installVersionedTransactMock(true);
    await evaluateRollbacks();
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(1);
  });
});

describe("evaluateRollbacks — fail-safe (never mutates on missing/thin/untrusted data)", () => {
  it("does not roll back a healthy candidate arm", async () => {
    configureReads({
      ledgerRows: Array.from({ length: 5 }, () => ({
        ...candidateLedgerRow(),
        costMicros: 100, // well under the 1000 ceiling
      })),
    });
    installVersionedTransactMock(true);
    await evaluateRollbacks();
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("does not roll back when candidate samples are below minSampleCount", async () => {
    configureReads({ ledgerRows: [candidateLedgerRow()] }); // 1 < minSampleCount 3
    installVersionedTransactMock(true);
    await evaluateRollbacks();
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("does not roll back when the rollback policy is disabled", async () => {
    configureReads({
      policyRow: policyRow({ enabled: false, costPerInvocationMaxMicros: 1 }),
    });
    installVersionedTransactMock(true);
    await evaluateRollbacks();
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("does not roll back when the policy is UNREADABLE (GetItem throws)", async () => {
    configureReads({ policyThrows: true });
    installVersionedTransactMock(true);
    await evaluateRollbacks();
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe("evaluateRollbacks — exactly-once under concurrent evaluators (MUST-BITE)", () => {
  it("NON-CONDITIONAL write lets BOTH evaluators win (proves the race is real)", async () => {
    // The bite proof: without the version guard, two stale-read evaluators
    // both succeed → TWO aborts. This is the failure the conditional write
    // exists to prevent.
    configureReads();
    const store = installVersionedTransactMock(false);

    await evaluateRollbacks();
    await evaluateRollbacks(); // second stale-read run (GSI still returns V=3)

    expect(store.writeSuccesses).toBe(2);
  });

  it("performs exactly ONE rollback + ONE finding under two concurrent evaluators", async () => {
    // The real conditional write: the second stale-read run loses the
    // version race (ConcurrentPromotionError) and no-ops.
    configureReads();
    const store = installVersionedTransactMock(true);

    await evaluateRollbacks();
    await evaluateRollbacks(); // second stale-read run, expectedVersion=3 no longer current

    expect(store.writeSuccesses).toBe(1);
    // exactly one finding (dedupe across cycles is also covered by the
    // writer's own ConditionalCheckFailed swallow).
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
  });
});

describe("evaluateRollbacks — resilience", () => {
  it("emits an alarmable metric when the post-commit finding write fails", async () => {
    configureReads();
    installVersionedTransactMock(true);
    ddbMock.on(PutCommand).rejects(new Error("ProvisionedThroughputExceeded"));
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    await evaluateRollbacks();

    const emitted = logSpy.mock.calls
      .map((c) => String(c[0]))
      .some((line) => line.includes("AutoRollbackFindingWriteFailure"));
    expect(emitted).toBe(true);
    // the move still committed despite the finding failure
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
  });

  it("isolates one canary's failure and continues evaluating the rest", async () => {
    const good = activeCanaryPointer();
    const broken = { ...activeCanaryPointer(), agentTargetId: "agent-broken" };
    configureReads({ activeCanaries: [broken, good] });

    // Bespoke transact mock: throw a NON-conditional error for the broken
    // canary (simulating an infra fault), succeed for the good one.
    const succeededKeys: string[] = [];
    ddbMock.on(TransactWriteCommand).callsFake(async (input) => {
      const put = (
        input as {
          TransactItems: {
            Put: { TableName: string; Item: Record<string, unknown> };
          }[];
        }
      ).TransactItems.map((t) => t.Put).find(
        (p) => p.TableName === POINTERS_TABLE,
      )!;
      const key = String(put.Item.agentTargetId_environment);
      if (key.startsWith("agent-broken#")) {
        throw new Error("infra fault on the broken canary");
      }
      succeededKeys.push(key);
      return {};
    });

    await evaluateRollbacks();

    // the second (good) canary still triggered its rollback despite the
    // first throwing.
    expect(succeededKeys).toEqual(["agent-1#staging"]);
  });
});
