import { AppSyncResolverHandler, AppSyncResolverEvent } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { v4 as uuidv4 } from "uuid";
import { getUserId } from "../utils/appsync";
import { extractOrgFromEvent } from "../utils/auth-event";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const eventBridgeClient = new EventBridgeClient({});

const EXECUTIONS_TABLE = process.env.EXECUTIONS_TABLE!;
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;

/**
 * Merged view of every argument shape this resolver's fields receive.
 * `input` is an AWSJSON string for startExecution; publishWorkflowProgress
 * receives a WorkflowProgressInput object and echoes it back unchanged.
 */
interface ExecutionResolverArguments {
  executionId: string;
  workflowId: string;
  input?: string;
}

type ExecutionResolverEvent = AppSyncResolverEvent<ExecutionResolverArguments>;

interface ExecutionNodeResult {
  nodeId: string;
  agentId?: string;
  status: string;
  retryCount: number;
  /** Additive: sanitized per-node worker usage records (usage rollup). */
  usage?: unknown[];
  /** Additive: this node's precomputed usage totals (usage rollup). */
  usageTotals?: UsageTotals;
  [key: string]: unknown;
}

/** Usage rollup: per-node or execution-level aggregated token usage. */
interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  callCount: number;
}

/** Shape of an execution item persisted in the executions table. */
interface ExecutionRecord {
  executionId: string;
  workflowId: string;
  appId?: string | null;
  orgId: string;
  status: string;
  workflowVersion?: number;
  currentNode?: string | null;
  nodeResults?: Record<string, ExecutionNodeResult>;
  input?: string | null;
  output?: string | null;
  startedAt?: string;
  completedAt?: string | null;
  triggeredBy?: string;
  error?: string | null;
  /** Additive: execution-level usage totals folded from nodeResults on read. */
  usageTotals?: UsageTotals | null;
}

function _coerceNonNegativeInt(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || Number.isNaN(n) || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/**
 * Sum a single node's usage into a UsageTotals shape, or null if the node
 * carries no usage source at all. Preference order: `usageTotals` (already
 * aggregated by the step runner) → `usage` (a sanitized usage array) →
 * `output.usage` (the pre-rollup-feature location, `output` possibly a JSON
 * string). Never throws — malformed shapes at any level are skipped.
 */
function _nodeUsageTotals(node: unknown): UsageTotals | null {
  if (!node || typeof node !== "object") return null;
  const n = node as ExecutionNodeResult;

  if (n.usageTotals && typeof n.usageTotals === "object") {
    const t = n.usageTotals;
    return {
      inputTokens: _coerceNonNegativeInt(t.inputTokens),
      outputTokens: _coerceNonNegativeInt(t.outputTokens),
      totalTokens: _coerceNonNegativeInt(t.totalTokens),
      callCount: _coerceNonNegativeInt(t.callCount),
    };
  }

  const fromArray = (arr: unknown): UsageTotals | null => {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    let inputTokens = 0;
    let outputTokens = 0;
    let callCount = 0;
    for (const rec of arr) {
      if (!rec || typeof rec !== "object") continue;
      const r = rec as Record<string, unknown>;
      inputTokens += _coerceNonNegativeInt(r.inputTokens);
      outputTokens += _coerceNonNegativeInt(r.outputTokens);
      callCount += 1;
    }
    if (callCount === 0) return null;
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      callCount,
    };
  };

  const fromUsageField = fromArray(n.usage);
  if (fromUsageField) return fromUsageField;

  let output: unknown = n.output;
  if (typeof output === "string") {
    try {
      output = JSON.parse(output);
    } catch {
      return null;
    }
  }
  if (output && typeof output === "object") {
    return fromArray((output as Record<string, unknown>).usage);
  }
  return null;
}

/**
 * Pure, additive reduction: fold every node's usage into execution-level
 * totals. Returns `null` when no node in `nodeResults` carries any usage
 * source at all (legacy runs predating this feature render unchanged).
 * Never throws — a malformed `nodeResults` map, or malformed individual node
 * entries, are skipped rather than propagating an error. Idempotent: calling
 * with the same input always yields an equal result (no I/O, no mutation),
 * so redelivery of the underlying event has no bearing on this read-side
 * computation.
 */
export function computeExecutionUsageTotals(
  nodeResults: Record<string, unknown> | undefined | null,
): UsageTotals | null {
  if (!nodeResults || typeof nodeResults !== "object") return null;

  let inputTokens = 0;
  let outputTokens = 0;
  let callCount = 0;
  let sawAny = false;

  for (const node of Object.values(nodeResults)) {
    const totals = _nodeUsageTotals(node);
    if (!totals) continue;
    sawAny = true;
    inputTokens += totals.inputTokens;
    outputTokens += totals.outputTokens;
    callCount += totals.callCount;
  }

  if (!sawAny) return null;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    callCount,
  };
}

export const handler: AppSyncResolverHandler<
  ExecutionResolverArguments,
  unknown
> = async (event) => {
  console.log("Execution resolver event:", JSON.stringify(event, null, 2));

  const { info, arguments: args, identity } = event;
  const fieldName = info.fieldName;
  const userId = getUserId(identity);

  try {
    switch (fieldName) {
      case "getExecution":
        return await getExecution(args.executionId, userId, event);
      case "listExecutions":
        return await listExecutions(args.workflowId);
      case "startExecution":
        return await startExecution(args.workflowId, args.input, userId, event);
      case "cancelExecution":
        return await cancelExecution(args.executionId, userId, event);
      case "publishWorkflowProgress":
        // IAM-signed fan-out mutation: echo the input so AppSync delivers it
        // to onWorkflowProgress subscribers.
        return args.input;
      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error) {
    console.error("Execution resolver error:", error);
    throw error;
  }
};

async function getExecution(
  executionId: string,
  userId: string,
  event: ExecutionResolverEvent,
): Promise<ExecutionRecord | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: EXECUTIONS_TABLE,
      Key: { executionId },
    }),
  );

  if (!result.Item) {
    return null;
  }

  const userOrg = await extractOrgFromEvent(event);
  if (userOrg && result.Item.orgId !== userOrg) {
    throw new Error("Access denied");
  }

  const item = result.Item as ExecutionRecord;
  // Additive: fold per-node usage into an execution-level total on read.
  // Pure and idempotent — no stored/mutable counter, so redelivery of the
  // underlying node-completed events has no bearing on this computation.
  item.usageTotals = computeExecutionUsageTotals(item.nodeResults);
  return item;
}

async function listExecutions(
  workflowId: string,
): Promise<{ items: unknown[]; nextToken?: string }> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: EXECUTIONS_TABLE,
      IndexName: "WorkflowIndex",
      KeyConditionExpression: "workflowId = :workflowId",
      ExpressionAttributeValues: {
        ":workflowId": workflowId,
      },
      ScanIndexForward: false,
    }),
  );

  return {
    items: result.Items || [],
    nextToken: result.LastEvaluatedKey
      ? JSON.stringify(result.LastEvaluatedKey)
      : undefined,
  };
}

async function startExecution(
  workflowId: string,
  input: string | undefined,
  userId: string,
  event: ExecutionResolverEvent,
): Promise<unknown> {
  // 1. Get workflow, verify PUBLISHED + org access
  const workflowResult = await docClient.send(
    new GetCommand({
      TableName: WORKFLOWS_TABLE,
      Key: { workflowId },
    }),
  );

  const workflow = workflowResult.Item;
  if (!workflow) {
    throw new Error("Workflow not found");
  }

  const userOrg = await extractOrgFromEvent(event);
  if (userOrg && workflow.orgId !== userOrg) {
    throw new Error("Access denied");
  }

  if (workflow.status !== "PUBLISHED") {
    throw new Error("Only published workflows can be executed");
  }

  // 2. Parse definition, initialize nodeResults
  const definition = JSON.parse(workflow.definition);
  const nodes = definition.nodes || [];
  const nodeResults: Record<string, ExecutionNodeResult> = {};
  for (const node of nodes) {
    nodeResults[node.id] = {
      nodeId: node.id,
      agentId: node.agentId,
      status: "pending",
      retryCount: 0,
    };
  }

  // 3. Create execution item
  const now = new Date().toISOString();
  const executionId = uuidv4();

  const execution = {
    executionId,
    workflowId,
    appId: workflow.appId || null,
    orgId: workflow.orgId,
    status: "pending",
    workflowVersion: workflow.version,
    currentNode: null,
    nodeResults,
    input: input || null,
    output: null,
    startedAt: now,
    completedAt: null,
    triggeredBy: userId,
    error: null,
  };

  await docClient.send(
    new PutCommand({
      TableName: EXECUTIONS_TABLE,
      Item: execution,
    }),
  );

  // 4. Publish execution.start.requested event
  await emitEvent("execution.start.requested", {
    executionId,
    workflowId,
  });

  return execution;
}

async function cancelExecution(
  executionId: string,
  userId: string,
  event: ExecutionResolverEvent,
): Promise<unknown> {
  // 1. Get execution, verify org access
  const existing = await getExecution(executionId, userId, event);
  if (!existing) {
    throw new Error("Execution not found");
  }

  // 2. Update status to cancelled
  const now = new Date().toISOString();
  const result = await docClient.send(
    new UpdateCommand({
      TableName: EXECUTIONS_TABLE,
      Key: { executionId },
      UpdateExpression: "SET #status = :status, #completedAt = :completedAt",
      ExpressionAttributeNames: {
        "#status": "status",
        "#completedAt": "completedAt",
      },
      ExpressionAttributeValues: {
        ":status": "cancelled",
        ":completedAt": now,
      },
      ReturnValues: "ALL_NEW",
    }),
  );

  // 3. Publish execution.cancel.requested event
  await emitEvent("execution.cancel.requested", {
    executionId,
    workflowId: existing.workflowId,
  });

  return result.Attributes;
}

async function emitEvent(eventType: string, detail: unknown): Promise<void> {
  await eventBridgeClient.send(
    new PutEventsCommand({
      Entries: [
        {
          Source: "citadel.workflows",
          DetailType: eventType,
          Detail: JSON.stringify(detail),
          EventBusName: EVENT_BUS_NAME,
        },
      ],
    }),
  );
}
