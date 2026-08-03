/**
 * CIT-102 Pass A — eval-runner driver tests.
 *
 * Covers (design §1, §3, acceptance criteria):
 *  - fanOutEvalRun: enqueues one SQS dispatch message per PENDING case,
 *    selecting the adapter by caseKind, threading evalRunId/evalContext/
 *    forbiddenTools verbatim (FROZEN CONTRACT).
 *  - dispatchExecutionCase (Adapter A): writes an EXECUTIONS_TABLE row
 *    carrying evalRunId/evalContext/forbiddenTools + emits
 *    execution.start.requested with the SAME additive detail keys.
 *  - handleWorkflowCompletion: maps a workflow.completed/workflow.failed
 *    event back to its eval case-result row via executionId and records
 *    completion.
 *  - sweepTimeouts: marks any DISPATCHED/RUNNING case past its deadlineAt
 *    as TIMEOUT and records completion (so a stuck target cannot hang a
 *    run forever).
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  PutCommand,
  UpdateCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

process.env.EVAL_RUNS_TABLE = "citadel-eval-runs-test";
process.env.EVAL_RUN_CASE_RESULTS_TABLE = "citadel-eval-run-case-results-test";
process.env.EVAL_CASES_TABLE = "citadel-eval-cases-test";
process.env.EXECUTIONS_TABLE = "citadel-executions-test";
process.env.EVENT_BUS_NAME = "citadel-agents-test";
process.env.EVAL_DISPATCH_QUEUE_URL = "https://sqs.test/eval-dispatch";

const ddbMock = mockClient(DynamoDBDocumentClient);
const ebMock = mockClient(EventBridgeClient);
const sqsMock = mockClient(SQSClient);

import {
  fanOutEvalRun,
  dispatchExecutionCase,
  handleWorkflowCompletion,
  sweepTimeouts,
  handler,
} from "../eval-runner";

beforeEach(() => {
  ddbMock.reset();
  ebMock.reset();
  sqsMock.reset();
});

describe("fanOutEvalRun", () => {
  test("enqueues a CONVERSATION-kind case to SQS carrying evalRunId/evalContext/forbiddenTools/agentTargetId; dispatches an EXECUTION-kind case directly (no SQS)", async () => {
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.TableName === "citadel-eval-run-case-results-test") {
        return {
          Items: [
            {
              evalRunId: "run-1",
              caseId: "case-1",
              caseKind: "CONVERSATION",
              status: "PENDING",
            },
            {
              evalRunId: "run-1",
              caseId: "case-2",
              caseKind: "EXECUTION",
              status: "PENDING",
            },
          ],
        };
      }
      return { Items: [] };
    });
    ddbMock.on(GetCommand).resolves({
      Item: {
        suiteId: "suite-1",
        caseId: "case-1",
        forbiddenTools: ["danger"],
        input: { prompt: "hi" },
      },
    });
    ddbMock.on(UpdateCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
    ebMock.on(PutEventsCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "m1" });

    await fanOutEvalRun("run-1", "suite-1", "agent-1", "org-1", 60000);

    // getEvalCase must be keyed by the run's suiteId, not the caseId.
    const getCalls = ddbMock.commandCalls(GetCommand);
    expect(getCalls[0].args[0].input.Key).toEqual({
      suiteId: "suite-1",
      caseId: "case-1",
    });

    const sendCalls = sqsMock.commandCalls(SendMessageCommand);
    expect(sendCalls).toHaveLength(1);
    const body = JSON.parse(sendCalls[0].args[0].input.MessageBody as string);
    expect(body.evalRunId).toBe("run-1");
    expect(body.evalContext).toBe(true);
    expect(body.agentTargetId).toBe("agent-1");
    expect(Array.isArray(body.forbiddenTools)).toBe(true);

    // The EXECUTION-kind case dispatches directly via PutCommand + PutEvents,
    // not through SQS, and threads the run's agentTargetId as the workflow
    // target (NOT the caseId).
    const execPut = ddbMock
      .commandCalls(PutCommand)
      .find((c) => c.args[0].input.TableName === "citadel-executions-test");
    expect(execPut).toBeDefined();
    expect(execPut?.args[0].input.Item.workflowId).toBe("agent-1");
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(1);
  });

  test("transitions each dispatched case PENDING -> DISPATCHED via a guarded conditional update", async () => {
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.TableName === "citadel-eval-run-case-results-test") {
        return {
          Items: [
            {
              evalRunId: "run-1",
              caseId: "case-1",
              caseKind: "CONVERSATION",
              status: "PENDING",
            },
          ],
        };
      }
      return { Items: [] };
    });
    ddbMock.on(GetCommand).resolves({
      Item: {
        suiteId: "suite-1",
        caseId: "case-1",
        forbiddenTools: [],
        input: { prompt: "hi" },
      },
    });
    ddbMock.on(UpdateCommand).resolves({});
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "m1" });

    await fanOutEvalRun("run-1", "suite-1", "agent-1", "org-1", 60000);

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    const dispatchUpdate = updateCalls.find(
      (c) => c.args[0].input.TableName === "citadel-eval-run-case-results-test",
    );
    expect(dispatchUpdate?.args[0].input.ConditionExpression).toContain(
      "#status = :pending",
    );
    expect(
      (
        dispatchUpdate?.args[0].input.ExpressionAttributeValues as Record<
          string,
          unknown
        >
      )[":dispatched"],
    ).toBe("DISPATCHED");
  });

  test("a redelivered fan-out cannot double-dispatch a case already past PENDING", async () => {
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.TableName === "citadel-eval-run-case-results-test") {
        return {
          Items: [
            {
              evalRunId: "run-1",
              caseId: "case-1",
              caseKind: "CONVERSATION",
              status: "PENDING",
            },
          ],
        };
      }
      return { Items: [] };
    });
    ddbMock.on(GetCommand).resolves({
      Item: {
        suiteId: "suite-1",
        caseId: "case-1",
        forbiddenTools: [],
        input: { prompt: "hi" },
      },
    });
    const conditionalError = Object.assign(
      new Error("The conditional request failed"),
      { name: "ConditionalCheckFailedException" },
    );
    ddbMock.on(UpdateCommand).rejects(conditionalError);
    sqsMock.on(SendMessageCommand).resolves({ MessageId: "m1" });

    await fanOutEvalRun("run-1", "suite-1", "agent-1", "org-1", 60000);

    // The guarded update rejected -> no SQS send for that case.
    expect(sqsMock.commandCalls(SendMessageCommand)).toHaveLength(0);
  });
});

describe("dispatchExecutionCase (Adapter A)", () => {
  test("writes an execution row and emits execution.start.requested carrying evalRunId/evalContext/forbiddenTools", async () => {
    ddbMock.on(PutCommand).resolves({});
    ebMock.on(PutEventsCommand).resolves({});

    await dispatchExecutionCase({
      evalRunId: "run-1",
      caseId: "case-2",
      orgId: "org-1",
      agentTargetId: "workflow-1",
      forbiddenTools: ["dangerous_tool"],
      evalContext: true,
      maxLatencyMs: 60000,
    });

    const putCalls = ddbMock.commandCalls(PutCommand);
    const execPut = putCalls.find(
      (c) => c.args[0].input.TableName === "citadel-executions-test",
    );
    expect(execPut).toBeDefined();
    expect(execPut?.args[0].input.Item.evalRunId).toBe("run-1");
    expect(execPut?.args[0].input.Item.evalContext).toBe(true);
    expect(execPut?.args[0].input.Item.forbiddenTools).toEqual([
      "dangerous_tool",
    ]);

    const putEventsCalls = ebMock.commandCalls(PutEventsCommand);
    expect(putEventsCalls).toHaveLength(1);
    const entry = putEventsCalls[0].args[0].input.Entries![0];
    expect(entry.DetailType).toBe("execution.start.requested");
    const detail = JSON.parse(entry.Detail!);
    expect(detail.evalRunId).toBe("run-1");
    expect(detail.evalContext).toBe(true);
    expect(detail.forbiddenTools).toEqual(["dangerous_tool"]);
    expect(detail.runId).toBeDefined();
  });
});

describe("handleWorkflowCompletion", () => {
  test("resolves evalRunId by reading the EXECUTIONS_TABLE row (no arbiter-side change needed), maps to its case-result row via executionId, and records completion", async () => {
    ddbMock.on(GetCommand).callsFake((input) => {
      if (input.TableName === "citadel-executions-test") {
        return { Item: { executionId: "exec-1", evalRunId: "run-1" } };
      }
      return {};
    });
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          evalRunId: "run-1",
          caseId: "case-2",
          executionId: "exec-1",
          status: "RUNNING",
        },
      ],
    });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { pendingCases: 1 } });

    await handleWorkflowCompletion({ executionId: "exec-1" }, "COMPLETED");

    const caseUpdate = ddbMock
      .commandCalls(UpdateCommand)
      .find(
        (c) =>
          c.args[0].input.TableName === "citadel-eval-run-case-results-test",
      );
    expect(
      (
        caseUpdate?.args[0].input.ExpressionAttributeValues as Record<
          string,
          unknown
        >
      )?.[":status"],
    ).toBe("COMPLETED");
  });

  test("is a no-op when the execution row has no evalRunId (a normal, non-eval workflow execution)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { executionId: "exec-not-eval" } });

    await expect(
      handleWorkflowCompletion({ executionId: "exec-not-eval" }, "COMPLETED"),
    ).resolves.not.toThrow();

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  test("is a no-op when no eval case references the executionId within the resolved run", async () => {
    ddbMock
      .on(GetCommand)
      .resolves({ Item: { executionId: "exec-not-eval", evalRunId: "run-1" } });
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await expect(
      handleWorkflowCompletion({ executionId: "exec-not-eval" }, "COMPLETED"),
    ).resolves.not.toThrow();

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});

describe("sweepTimeouts", () => {
  test("marks a case past its deadlineAt as TIMEOUT and records completion", async () => {
    const past = new Date(Date.now() - 60000).toISOString();
    ddbMock
      .on(ScanCommand)
      .resolves({ Items: [{ evalRunId: "run-1", status: "RUNNING" }] });
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          evalRunId: "run-1",
          caseId: "case-1",
          status: "DISPATCHED",
          deadlineAt: past,
        },
        {
          evalRunId: "run-1",
          caseId: "case-2",
          status: "COMPLETED",
          deadlineAt: past,
        },
      ],
    });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { pendingCases: 0 } });

    await sweepTimeouts();

    // The sweep uses a status-filtered Scan (no status GSI exists) to find
    // active runs across orgs.
    const scanCall = ddbMock.commandCalls(ScanCommand)[0];
    expect(scanCall.args[0].input.TableName).toBe("citadel-eval-runs-test");
    expect(scanCall.args[0].input.FilterExpression).toContain("#status IN");

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    const timeoutUpdate = updateCalls.find(
      (c) =>
        c.args[0].input.TableName === "citadel-eval-run-case-results-test" &&
        (
          c.args[0].input.ExpressionAttributeValues as Record<string, unknown>
        )?.[":status"] === "TIMEOUT",
    );
    expect(timeoutUpdate).toBeDefined();
    expect(timeoutUpdate?.args[0].input.Key).toEqual({
      evalRunId: "run-1",
      caseId: "case-1",
    });
  });

  test("does not touch a case that is already terminal or not past its deadline", async () => {
    const future = new Date(Date.now() + 60000).toISOString();
    ddbMock
      .on(ScanCommand)
      .resolves({ Items: [{ evalRunId: "run-1", status: "RUNNING" }] });
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          evalRunId: "run-1",
          caseId: "case-1",
          status: "DISPATCHED",
          deadlineAt: future,
        },
        {
          evalRunId: "run-1",
          caseId: "case-2",
          status: "COMPLETED",
          deadlineAt: "2020-01-01T00:00:00.000Z",
        },
      ],
    });

    await sweepTimeouts();

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});

/**
 * Lambda entry-point routing (design §9/§1 F3 fix): the eval-runner Lambda
 * must actually be reachable via EventBridge for both workflow-completion
 * events and the scheduled timeout sweep.
 */
describe("handler", () => {
  test("routes workflow.completed to handleWorkflowCompletion", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { executionId: "exec-1" } });

    await handler({
      "detail-type": "workflow.completed",
      detail: { executionId: "exec-1" },
    });

    const getCalls = ddbMock.commandCalls(GetCommand);
    expect(
      getCalls.some(
        (c) => c.args[0].input.TableName === "citadel-executions-test",
      ),
    ).toBe(true);
  });

  test("routes workflow.failed to handleWorkflowCompletion", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { executionId: "exec-2" } });

    await handler({
      "detail-type": "workflow.failed",
      detail: { executionId: "exec-2" },
    });

    const getCalls = ddbMock.commandCalls(GetCommand);
    expect(
      getCalls.some(
        (c) => c.args[0].input.TableName === "citadel-executions-test",
      ),
    ).toBe(true);
  });

  test("routes an event with no detail-type (scheduled invocation) to sweepTimeouts", async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await handler({});

    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(1);
  });
});
