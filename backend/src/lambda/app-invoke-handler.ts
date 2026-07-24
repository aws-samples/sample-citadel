/**
 * App Invoke Handler — EventBridge consumer for the per-app invoke path.
 *
 * Consumes `app.invoke.requested` events (source: citadel.app.invoke)
 * emitted by the per-app API Gateway's EventBridge-PutEvents integration
 * (see app-publish-handler.ts provisionApiGateway). Resolves the
 * AUTHORITATIVE appId, selects and validates the target workflow, writes an
 * execution record mirroring execution-resolver.ts startExecution semantics,
 * and emits `execution.start.requested` (source: citadel.workflows) so the
 * Step Runner picks it up.
 *
 * Security:
 *  - appId is read EXCLUSIVELY from `event.resources[0]`, which the
 *    integration populates from `$context.authorizer.appId` (Lambda
 *    authorizer output). The client-supplied request body is UNTRUSTED and
 *    is never used to resolve appId — only an optional `workflowId` and
 *    `input` are read from it, both sanitized.
 *  - orgId always comes from the app's own METADATA row, never the client.
 *  - Every branch that cannot establish a valid, bound, PUBLISHED workflow
 *    fails closed (drops the event; no execution is created).
 */
import { EventBridgeEvent } from "aws-lambda";
import { v4 as uuidv4 } from "uuid";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { IdempotencyGuard } from "../utils/idempotency";
import { sanitizeUntrustedJson } from "../utils/sanitize-untrusted-json";

// ── Types ───────────────────────────────────────────────────

export interface AppInvokeEventDetail {
  /** Optional — required only when the app has >1 bound workflow. */
  workflowId?: string;
  /** Untrusted client payload forwarded to the execution's `input` field. */
  input?: Record<string, unknown>;
  [key: string]: unknown;
}

interface AppMetadataItem {
  appId: string;
  status: string;
  workflowIds?: string[];
  orgId?: string;
  [key: string]: unknown;
}

interface WorkflowItem {
  workflowId: string;
  orgId: string;
  status: string;
  appId?: string;
  definition: string;
  version?: number;
  [key: string]: unknown;
}

interface WorkflowDefinitionNode {
  id: string;
  agentId?: string;
  [key: string]: unknown;
}

interface ExecutionNodeResult {
  nodeId: string;
  agentId?: string;
  status: string;
  retryCount: number;
  [key: string]: unknown;
}

// ── Constants ────────────────────────────────────────────────

const MAX_BODY_BYTES = 64 * 1024;

const APPS_TABLE = process.env.APPS_TABLE || "citadel-apps-dev";
const WORKFLOWS_TABLE = process.env.WORKFLOWS_TABLE || "citadel-workflows-dev";
const EXECUTIONS_TABLE =
  process.env.EXECUTIONS_TABLE || "citadel-executions-dev";
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME || "citadel-agents-dev";
const IDEMPOTENCY_TABLE =
  process.env.IDEMPOTENCY_TABLE || "citadel-idempotency-dev";

// ── SDK Clients (lazy-initialized) ──────────────────────────

let _docClient: DynamoDBDocumentClient | undefined;
let _eventBridgeClient: EventBridgeClient | undefined;
let _idempotencyGuard: IdempotencyGuard | undefined;

function getDocClient(): DynamoDBDocumentClient {
  if (!_docClient)
    _docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return _docClient;
}
function getEventBridgeClient(): EventBridgeClient {
  if (!_eventBridgeClient) _eventBridgeClient = new EventBridgeClient({});
  return _eventBridgeClient;
}
function getIdempotencyGuard(): IdempotencyGuard {
  if (!_idempotencyGuard)
    _idempotencyGuard = new IdempotencyGuard(IDEMPOTENCY_TABLE);
  return _idempotencyGuard;
}

// ── Pure Utility ─────────────────────────────────────────────

/**
 * Selects the target workflowId given the app's bound workflowIds and an
 * optional client-requested workflowId. Pure — no I/O, no PUBLISHED/org
 * validation (that happens after the workflow record is fetched).
 *
 * - 0 bound → undefined (no_bound_workflow)
 * - 1 bound → that workflow, but if a requested id is given it must match
 * - many bound → the requested id is REQUIRED and must be one of the bound set
 */
export function selectWorkflowId(
  boundWorkflowIds: string[],
  requestedWorkflowId: string | undefined,
): string | undefined {
  if (boundWorkflowIds.length === 0) {
    return undefined;
  }
  if (boundWorkflowIds.length === 1) {
    const only = boundWorkflowIds[0];
    if (requestedWorkflowId && requestedWorkflowId !== only) {
      return undefined;
    }
    return only;
  }
  // Many bound: requested id is required and must be in the set.
  if (!requestedWorkflowId || !boundWorkflowIds.includes(requestedWorkflowId)) {
    return undefined;
  }
  return requestedWorkflowId;
}

// ── Handler ──────────────────────────────────────────────────

export async function handler(
  event: EventBridgeEvent<"app.invoke.requested", AppInvokeEventDetail>,
  deps: {
    docClient: DynamoDBDocumentClient;
    eventBridgeClient: EventBridgeClient;
    idempotencyGuard: IdempotencyGuard;
    appsTable: string;
    workflowsTable: string;
    executionsTable: string;
    eventBusName: string;
  } = {
    docClient: getDocClient(),
    eventBridgeClient: getEventBridgeClient(),
    idempotencyGuard: getIdempotencyGuard(),
    appsTable: APPS_TABLE,
    workflowsTable: WORKFLOWS_TABLE,
    executionsTable: EXECUTIONS_TABLE,
    eventBusName: EVENT_BUS_NAME,
  },
): Promise<void> {
  const correlationId = event.id;

  try {
    const { executed } = await deps.idempotencyGuard.withIdempotency(
      correlationId,
      async () => {
        await processAppInvoke(event, correlationId, deps);
      },
    );

    if (!executed) {
      console.log("app-invoke-handler: skipping duplicate event", {
        correlationId,
      });
    }
  } catch (error: unknown) {
    console.error("app-invoke-handler: unhandled error", {
      correlationId,
      err: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function processAppInvoke(
  event: EventBridgeEvent<"app.invoke.requested", AppInvokeEventDetail>,
  correlationId: string,
  deps: {
    docClient: DynamoDBDocumentClient;
    eventBridgeClient: EventBridgeClient;
    appsTable: string;
    workflowsTable: string;
    executionsTable: string;
    eventBusName: string;
  },
): Promise<void> {
  // 1. Resolve the AUTHORITATIVE appId — resources[0] ONLY, never the body.
  const appId = event.resources?.[0];
  if (!appId) {
    console.warn(
      "app-invoke-handler: dropping event with no trusted appId in resources",
      {
        correlationId,
      },
    );
    return;
  }

  // 2. Bound the untrusted body BEFORE any further processing (size cap +
  // recursive sanitization). Oversized/malformed bodies fail closed.
  const rawDetail = (event.detail ?? {}) as AppInvokeEventDetail;
  const bodyBytes = Buffer.byteLength(JSON.stringify(rawDetail), "utf8");
  if (bodyBytes > MAX_BODY_BYTES) {
    console.warn("app-invoke-handler: dropping event exceeding size cap", {
      correlationId,
      appId,
      bodyBytes,
    });
    return;
  }
  const sanitized = sanitizeUntrustedJson(rawDetail);
  const detail = (sanitized.value ?? {}) as AppInvokeEventDetail;
  const requestedWorkflowId =
    typeof detail.workflowId === "string" ? detail.workflowId : undefined;

  // 3. Load app METADATA (GroupIndex APP#{appId} / sortId METADATA).
  const appQuery = await deps.docClient.send(
    new QueryCommand({
      TableName: deps.appsTable,
      IndexName: "GroupIndex",
      KeyConditionExpression: "groupId = :gid AND sortId = :sk",
      ExpressionAttributeValues: {
        ":gid": `APP#${appId}`,
        ":sk": "METADATA",
      },
    }),
  );
  const app = (appQuery.Items || [])[0] as AppMetadataItem | undefined;

  if (!app) {
    console.warn("app-invoke-handler: dropping event — app not found", {
      correlationId,
      appId,
    });
    return;
  }
  if (app.status !== "PUBLISHED") {
    console.warn("app-invoke-handler: dropping event — app not published", {
      correlationId,
      appId,
      status: app.status,
    });
    return;
  }

  // 4. Select the target workflow from the app's bound set.
  const boundWorkflowIds = app.workflowIds || [];
  const workflowId = selectWorkflowId(boundWorkflowIds, requestedWorkflowId);
  if (!workflowId) {
    console.warn(
      "app-invoke-handler: dropping event — no bound/ambiguous workflow",
      {
        correlationId,
        appId,
        boundCount: boundWorkflowIds.length,
        requestedWorkflowId,
      },
    );
    return;
  }

  // 5. Load and validate the workflow: PUBLISHED, same org as the app, and
  // (if set) bound to this exact app — fail closed on any mismatch.
  const workflowResult = await deps.docClient.send(
    new GetCommand({
      TableName: deps.workflowsTable,
      Key: { workflowId },
    }),
  );
  const workflow = workflowResult.Item as WorkflowItem | undefined;

  if (!workflow) {
    console.warn("app-invoke-handler: dropping event — workflow not found", {
      correlationId,
      appId,
      workflowId,
    });
    return;
  }
  if (workflow.status !== "PUBLISHED") {
    console.warn(
      "app-invoke-handler: dropping event — workflow not published",
      {
        correlationId,
        appId,
        workflowId,
        status: workflow.status,
      },
    );
    return;
  }
  if (workflow.orgId !== app.orgId) {
    console.warn("app-invoke-handler: dropping event — org mismatch", {
      correlationId,
      appId,
      workflowId,
    });
    return;
  }
  if (workflow.appId && workflow.appId !== appId) {
    console.warn("app-invoke-handler: dropping event — cross-app workflow", {
      correlationId,
      appId,
      workflowId,
      workflowAppId: workflow.appId,
    });
    return;
  }

  // 6. Initialize nodeResults from the workflow definition (mirrors
  // execution-resolver.ts startExecution).
  let definition: { nodes?: WorkflowDefinitionNode[] };
  try {
    definition = JSON.parse(workflow.definition);
  } catch (error: unknown) {
    console.error(
      "app-invoke-handler: dropping event — malformed workflow definition",
      {
        correlationId,
        appId,
        workflowId,
        err: error instanceof Error ? error.message : String(error),
      },
    );
    return;
  }
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

  // 7. Strip workflowId out of the sanitized detail before persisting as
  // execution input — the selector already consumed it.
  const { workflowId: _omit, ...inputRest } = detail;
  const executionInput = Object.keys(inputRest).length > 0 ? inputRest : null;

  // 8. Write the execution record — byte-identical shape to
  // execution-resolver.ts startExecution, with app-invoke-specific
  // triggeredBy/appId/orgId.
  const now = new Date().toISOString();
  const executionId = uuidv4();

  const execution = {
    executionId,
    workflowId,
    appId,
    orgId: app.orgId,
    status: "pending",
    workflowVersion: workflow.version,
    currentNode: null,
    nodeResults,
    input: executionInput,
    output: null,
    startedAt: now,
    completedAt: null,
    triggeredBy: `app-invoke:${appId}`,
    error: null,
  };

  await deps.docClient.send(
    new PutCommand({
      TableName: deps.executionsTable,
      Item: execution,
    }),
  );

  // 9. Emit execution.start.requested — Step Runner (StepRunnerStartRule)
  // matches on detail-type only, so this is picked up identically to the
  // AppSync startExecution mutation path.
  await deps.eventBridgeClient.send(
    new PutEventsCommand({
      Entries: [
        {
          Source: "citadel.workflows",
          DetailType: "execution.start.requested",
          Detail: JSON.stringify({
            executionId,
            workflowId,
            correlationId,
          }),
          EventBusName: deps.eventBusName,
        },
      ],
    }),
  );
}
