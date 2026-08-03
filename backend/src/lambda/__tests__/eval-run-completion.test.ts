/**
 * CIT-102 Pass A — eval-run-completion tests.
 *
 * Shared helper (design §2): each terminal case transition does a
 * conditional atomic `UpdateItem ... ADD pendingCases :neg1` on the run
 * row, idempotent via a per-case `completionRecorded` guard flag on the
 * case row so a duplicate completion event can't double-decrement.
 * Reaching 0 finalizes the run (COMPLETED) and emits
 * `governance.eval.run.completed`.
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  UpdateCommand,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";

process.env.EVAL_RUNS_TABLE = "citadel-eval-runs-test";
process.env.EVAL_RUN_CASE_RESULTS_TABLE = "citadel-eval-run-case-results-test";
process.env.EVENT_BUS_NAME = "citadel-agents-test";

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);

jest.mock("../utils/eval-artifact-store", () => ({
  materializeEvalCaseArtifact: jest.fn(),
}));

import { recordCaseCompletion } from "../eval-run-completion";
import { materializeEvalCaseArtifact } from "../utils/eval-artifact-store";

beforeEach(() => {
  ddbMock.reset();
  ebMock.reset();
  (materializeEvalCaseArtifact as jest.Mock).mockReset();
});

describe("recordCaseCompletion", () => {
  test("decrements pendingCases and sets completionRecorded on the case row", async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { evalRunId: "run-1", pendingCases: 1 },
    });
    ddbMock.on(GetCommand).resolves({
      Item: { evalRunId: "run-1", orgId: "org-1", suiteId: "s1", caseCount: 2 },
    });

    await recordCaseCompletion("run-1", "case-1");

    const caseUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find(
        (c) =>
          c.args[0].input.TableName === "citadel-eval-run-case-results-test",
      );
    expect(caseUpdate?.args[0].input.ConditionExpression).toContain(
      "attribute_not_exists(completionRecorded)",
    );

    const runUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.TableName === "citadel-eval-runs-test");
    expect(runUpdate?.args[0].input.UpdateExpression).toContain(
      "ADD pendingCases :neg1",
    );
  });

  test("a duplicate completion event (case already completionRecorded) is a no-op — no pendingCases double-decrement", async () => {
    const conditionalError = Object.assign(
      new Error("The conditional request failed"),
      { name: "ConditionalCheckFailedException" },
    );
    ddbMock.on(UpdateCommand).callsFake((input) => {
      if (input.TableName === "citadel-eval-run-case-results-test") {
        throw conditionalError;
      }
      return { Attributes: { pendingCases: 1 } };
    });

    await expect(
      recordCaseCompletion("run-1", "case-1"),
    ).resolves.not.toThrow();

    const runUpdates = ddbMock
      .commandCalls(UpdateCommand)
      .filter((c) => c.args[0].input.TableName === "citadel-eval-runs-test");
    expect(runUpdates).toHaveLength(0);
  });

  test("finalizes the run and emits governance.eval.run.completed when pendingCases reaches zero", async () => {
    ddbMock.on(UpdateCommand).callsFake((input) => {
      if (input.TableName === "citadel-eval-run-case-results-test") {
        return { Attributes: {} };
      }
      // Run-row ADD pendingCases :neg1 -> 0
      return {
        Attributes: {
          evalRunId: "run-1",
          orgId: "org-1",
          suiteId: "s1",
          pendingCases: 0,
          caseCount: 3,
          startedAt: "2026-01-01T00:00:00.000Z",
        },
      };
    });
    ebMock.on(PutEventsCommand).resolves({});

    // caseCounts breakdown query.
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { status: "COMPLETED" },
        { status: "COMPLETED" },
        { status: "FAILED" },
      ],
    });

    await recordCaseCompletion("run-1", "case-3");

    const finalizeUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find(
        (c) =>
          c.args[0].input.TableName === "citadel-eval-runs-test" &&
          (
            c.args[0].input.ExpressionAttributeValues as Record<string, unknown>
          )?.[":completedStatus"] === "COMPLETED",
      );
    expect(finalizeUpdate).toBeDefined();

    const putEventsCalls = ebMock.commandCalls(PutEventsCommand);
    expect(putEventsCalls).toHaveLength(1);
    const detail = JSON.parse(
      putEventsCalls[0].args[0].input.Entries![0].Detail!,
    );
    expect(putEventsCalls[0].args[0].input.Entries![0].DetailType).toBe(
      "governance.eval.run.completed",
    );
    expect(detail.evalRunId).toBe("run-1");
    expect(detail.caseCounts.total).toBe(3);
  });

  test("does NOT finalize when pendingCases is still above zero", async () => {
    ddbMock.on(UpdateCommand).callsFake((input) => {
      if (input.TableName === "citadel-eval-run-case-results-test") {
        return { Attributes: {} };
      }
      return { Attributes: { evalRunId: "run-1", pendingCases: 1 } };
    });

    await recordCaseCompletion("run-1", "case-1");

    const putEventsCalls = ebMock.commandCalls(PutEventsCommand);
    expect(putEventsCalls).toHaveLength(0);
  });
});

describe("recordCaseCompletion — F4 artifact materialization", () => {
  function stubRunRowUpdate(pendingCases: number): void {
    ddbMock.on(UpdateCommand).callsFake((input) => {
      if (input.TableName === "citadel-eval-run-case-results-test") {
        return { Attributes: {} };
      }
      return {
        Attributes: {
          evalRunId: "run-1",
          orgId: "org-1",
          suiteId: "s1",
          pendingCases,
        },
      };
    });
  }

  test("materializes and stamps artifactRef/artifactKind for a COMPLETED EXECUTION-kind case", async () => {
    stubRunRowUpdate(1);
    ddbMock.on(GetCommand).resolves({
      Item: {
        evalRunId: "run-1",
        caseId: "case-1",
        orgId: "org-1",
        status: "COMPLETED",
        caseKind: "EXECUTION",
        executionId: "exec-1",
      },
    });
    (materializeEvalCaseArtifact as jest.Mock).mockResolvedValue({
      artifactRef: "eval-runs/run-1/case-1.json",
      artifactKind: "execution",
    });

    await recordCaseCompletion("run-1", "case-1");

    expect(materializeEvalCaseArtifact).toHaveBeenCalledWith(
      "run-1",
      "case-1",
      "org-1",
      "execution",
      "exec-1",
    );
    const artifactStamp = ddbMock
      .commandCalls(UpdateCommand)
      .find(
        (c) =>
          c.args[0].input.TableName === "citadel-eval-run-case-results-test" &&
          c.args[0].input.UpdateExpression ===
            "SET artifactRef = :ref, artifactKind = :kind",
      );
    expect(artifactStamp).toBeDefined();
    expect(artifactStamp?.args[0].input.ExpressionAttributeValues).toEqual({
      ":ref": "eval-runs/run-1/case-1.json",
      ":kind": "execution",
    });
  });

  test("materializes a COMPLETED CONVERSATION-kind case using conversationId as the source id", async () => {
    stubRunRowUpdate(1);
    ddbMock.on(GetCommand).resolves({
      Item: {
        evalRunId: "run-1",
        caseId: "case-2",
        orgId: "org-1",
        status: "COMPLETED",
        caseKind: "CONVERSATION",
        conversationId: "case-2",
      },
    });
    (materializeEvalCaseArtifact as jest.Mock).mockResolvedValue({
      artifactRef: "eval-runs/run-1/case-2.json",
      artifactKind: "conversation",
    });

    await recordCaseCompletion("run-1", "case-2");

    expect(materializeEvalCaseArtifact).toHaveBeenCalledWith(
      "run-1",
      "case-2",
      "org-1",
      "conversation",
      "case-2",
    );
  });

  test("does NOT materialize (and does not stamp artifactRef) for a FAILED case", async () => {
    stubRunRowUpdate(1);
    ddbMock.on(GetCommand).resolves({
      Item: {
        evalRunId: "run-1",
        caseId: "case-3",
        orgId: "org-1",
        status: "FAILED",
        caseKind: "EXECUTION",
        executionId: "exec-3",
      },
    });

    await recordCaseCompletion("run-1", "case-3");

    expect(materializeEvalCaseArtifact).not.toHaveBeenCalled();
    const artifactStamp = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.UpdateExpression?.includes("artifactRef"));
    expect(artifactStamp).toBeUndefined();
  });

  test("does NOT materialize (and does not stamp artifactRef) for a TIMEOUT case", async () => {
    stubRunRowUpdate(1);
    ddbMock.on(GetCommand).resolves({
      Item: {
        evalRunId: "run-1",
        caseId: "case-4",
        orgId: "org-1",
        status: "TIMEOUT",
        caseKind: "EXECUTION",
        executionId: "exec-4",
      },
    });

    await recordCaseCompletion("run-1", "case-4");

    expect(materializeEvalCaseArtifact).not.toHaveBeenCalled();
  });

  test("graceful degradation: does NOT stamp artifactRef when materializeEvalCaseArtifact returns nulls, and never throws", async () => {
    stubRunRowUpdate(1);
    ddbMock.on(GetCommand).resolves({
      Item: {
        evalRunId: "run-1",
        caseId: "case-5",
        orgId: "org-1",
        status: "COMPLETED",
        caseKind: "EXECUTION",
        executionId: "exec-5",
      },
    });
    (materializeEvalCaseArtifact as jest.Mock).mockResolvedValue({
      artifactRef: null,
      artifactKind: null,
    });

    await expect(
      recordCaseCompletion("run-1", "case-5"),
    ).resolves.not.toThrow();

    const artifactStamp = ddbMock
      .commandCalls(UpdateCommand)
      .find((c) => c.args[0].input.UpdateExpression?.includes("artifactRef"));
    expect(artifactStamp).toBeUndefined();
  });

  test("does NOT materialize when the COMPLETED case row has no source id for its kind, and never throws", async () => {
    stubRunRowUpdate(1);
    ddbMock.on(GetCommand).resolves({
      Item: {
        evalRunId: "run-1",
        caseId: "case-6",
        orgId: "org-1",
        status: "COMPLETED",
        caseKind: "EXECUTION",
        // executionId deliberately absent.
      },
    });

    await expect(
      recordCaseCompletion("run-1", "case-6"),
    ).resolves.not.toThrow();
    expect(materializeEvalCaseArtifact).not.toHaveBeenCalled();
  });

  test("a materializeEvalCaseArtifact rejection never propagates out of recordCaseCompletion", async () => {
    stubRunRowUpdate(1);
    ddbMock.on(GetCommand).resolves({
      Item: {
        evalRunId: "run-1",
        caseId: "case-7",
        orgId: "org-1",
        status: "COMPLETED",
        caseKind: "EXECUTION",
        executionId: "exec-7",
      },
    });
    (materializeEvalCaseArtifact as jest.Mock).mockRejectedValue(
      new Error("boom"),
    );

    await expect(
      recordCaseCompletion("run-1", "case-7"),
    ).resolves.not.toThrow();
  });
});
