import { AppSyncResolverEvent } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { assertRowOrg, isAdminFromEvent } from "../utils/auth-event";

/**
 * Shared subscription-connect authorization resolver for the two
 * backend-stack subscription fields that were previously ungated:
 *
 *   - onWorkflowProgress(executionId: ID!)
 *     Loads the execution row → delegates to assertProjectAccess via the
 *     execution's projectId.
 *
 *   - onAppStatusChange(appId: ID!)
 *     Loads the app metadata row → delegates to assertRowOrg via the
 *     app's orgId.
 *
 * A single Lambda with a field-name switch handles both. Unknown field
 * names and missing/empty arguments fail closed.
 */
export class BackendSubscriptionError extends Error {
  constructor(message = "Access denied: cross-tenant subscription") {
    super(message);
    this.name = "BackendSubscriptionError";
  }
}

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

interface SubscriptionArgs {
  executionId?: string;
  appId?: string;
}

type SubscriptionAuthEvent = AppSyncResolverEvent<SubscriptionArgs>;

async function authorizeWorkflowProgress(
  event: SubscriptionAuthEvent,
): Promise<null> {
  const executionId = event.arguments?.executionId;
  if (!executionId) {
    throw new BackendSubscriptionError();
  }

  if (isAdminFromEvent(event)) {
    return null;
  }

  if (isAdminFromEvent(event)) {
    return null;
  }

  const executionsTable = process.env.EXECUTIONS_TABLE;
  if (!executionsTable) {
    throw new BackendSubscriptionError();
  }

  let execution: Record<string, unknown> | undefined;
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: executionsTable,
        Key: { executionId },
      }),
    );
    execution = result.Item as Record<string, unknown> | undefined;
  } catch (err) {
    console.error("onWorkflowProgress: execution lookup failed", {
      executionId,
      err,
    });
    throw new BackendSubscriptionError();
  }

  if (!execution) {
    throw new BackendSubscriptionError();
  }

  // Executions carry orgId — use assertRowOrg for org-level check
  try {
    await assertRowOrg(execution as { orgId?: unknown }, event);
  } catch {
    console.warn("onWorkflowProgress subscription refused", { executionId });
    throw new BackendSubscriptionError();
  }

  return null;
}

async function authorizeAppStatusChange(
  event: SubscriptionAuthEvent,
): Promise<null> {
  const appId = event.arguments?.appId;
  if (!appId) {
    throw new BackendSubscriptionError();
  }

  if (isAdminFromEvent(event)) {
    return null;
  }

  const appsTable = process.env.APPS_TABLE;
  if (!appsTable) {
    throw new BackendSubscriptionError();
  }

  let app: Record<string, unknown> | undefined;
  try {
    const result = await docClient.send(
      new GetCommand({
        TableName: appsTable,
        Key: { appId },
      }),
    );
    app = result.Item as Record<string, unknown> | undefined;
  } catch (err) {
    console.error("onAppStatusChange: app lookup failed", { appId, err });
    throw new BackendSubscriptionError();
  }

  if (!app) {
    throw new BackendSubscriptionError();
  }

  try {
    await assertRowOrg(app as { orgId?: unknown }, event);
  } catch {
    console.warn("onAppStatusChange subscription refused", { appId });
    throw new BackendSubscriptionError();
  }

  return null;
}

export const handler = async (event: SubscriptionAuthEvent): Promise<null> => {
  const fieldName = event.info?.fieldName;

  switch (fieldName) {
    case "onWorkflowProgress":
      return authorizeWorkflowProgress(event);
    case "onAppStatusChange":
      return authorizeAppStatusChange(event);
    default:
      throw new BackendSubscriptionError();
  }
};
