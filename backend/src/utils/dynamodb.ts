import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import * as AWSXRay from "aws-xray-sdk-core";

// Tracing foundation (architect task 5459301e-1e7b-4bfd-bccb-b106aba2748c,
// design §1(a)/§6 item 2): wrapping the client here — the single shared
// construction point every resolver imports — yields a DynamoDB subsegment
// on every resolver's X-Ray trace with zero per-handler edits.
// Explicitly pin the context-missing strategy to LOG_ERROR (not
// RUNTIME_ERROR): outside a Lambda/X-Ray-daemon context — e.g. under Jest,
// where no segment exists — captureAWSv3Client-wrapped calls must log and
// continue, never throw. aws-xray-sdk-core@3.x already defaults to
// LOG_ERROR, but pinning it here removes the dependency on that upstream
// default and documents the requirement at the call site.
AWSXRay.setContextMissingStrategy("LOG_ERROR");
const dynamoClient = AWSXRay.captureAWSv3Client(new DynamoDBClient({}));
const docClient = DynamoDBDocumentClient.from(dynamoClient);

export interface PaginationOptions {
  limit?: number;
  nextToken?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  nextToken?: string;
}

export async function getItem<T extends Record<string, unknown>>(
  tableName: string,
  key: Record<string, unknown>,
): Promise<T | null> {
  try {
    const command = new GetCommand({
      TableName: tableName,
      Key: key,
    });

    const result = await docClient.send(command);
    return (result.Item as T) || null;
  } catch (error) {
    console.error("Failed to get item from table:", { tableName, error });
    throw error;
  }
}

export async function putItem<T extends Record<string, unknown>>(
  tableName: string,
  item: T,
): Promise<void> {
  try {
    const command = new PutCommand({
      TableName: tableName,
      Item: item,
    });

    await docClient.send(command);
  } catch (error) {
    console.error("Failed to put item to table:", { tableName, error });
    throw error;
  }
}

export async function updateItem<T extends Record<string, unknown>>(
  tableName: string,
  key: Record<string, unknown>,
  updateExpression: string,
  expressionAttributeNames?: Record<string, string>,
  expressionAttributeValues?: Record<string, unknown>,
): Promise<T> {
  try {
    const command = new UpdateCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: "ALL_NEW",
    });

    const result = await docClient.send(command);
    return result.Attributes as T;
  } catch (error) {
    console.error("Failed to update item in table:", { tableName, error });
    throw error;
  }
}

export async function deleteItem(
  tableName: string,
  key: Record<string, unknown>,
): Promise<void> {
  try {
    const command = new DeleteCommand({
      TableName: tableName,
      Key: key,
    });

    await docClient.send(command);
  } catch (error) {
    console.error("Failed to delete item from table:", { tableName, error });
    throw error;
  }
}

export async function queryItems<T extends Record<string, unknown>>(
  tableName: string,
  keyConditionExpression: string,
  expressionAttributeValues: Record<string, unknown>,
  options?: PaginationOptions & {
    indexName?: string;
    filterExpression?: string;
    expressionAttributeNames?: Record<string, string>;
    scanIndexForward?: boolean;
  },
): Promise<PaginatedResult<T>> {
  try {
    const command = new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: keyConditionExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ExpressionAttributeNames: options?.expressionAttributeNames,
      FilterExpression: options?.filterExpression,
      IndexName: options?.indexName,
      Limit: options?.limit,
      ExclusiveStartKey: options?.nextToken
        ? JSON.parse(Buffer.from(options.nextToken, "base64").toString())
        : undefined,
      ScanIndexForward: options?.scanIndexForward,
    });

    const result = await docClient.send(command);

    return {
      items: (result.Items as T[]) || [],
      nextToken: result.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString(
            "base64",
          )
        : undefined,
    };
  } catch (error) {
    console.error("Failed to query items from table:", { tableName, error });
    throw error;
  }
}

export async function scanItems<T extends Record<string, unknown>>(
  tableName: string,
  options?: PaginationOptions & {
    filterExpression?: string;
    expressionAttributeNames?: Record<string, string>;
    expressionAttributeValues?: Record<string, unknown>;
  },
): Promise<PaginatedResult<T>> {
  try {
    const command = new ScanCommand({
      TableName: tableName,
      FilterExpression: options?.filterExpression,
      ExpressionAttributeNames: options?.expressionAttributeNames,
      ExpressionAttributeValues: options?.expressionAttributeValues,
      Limit: options?.limit,
      ExclusiveStartKey: options?.nextToken
        ? JSON.parse(Buffer.from(options.nextToken, "base64").toString())
        : undefined,
    });

    const result = await docClient.send(command);

    return {
      items: (result.Items as T[]) || [],
      nextToken: result.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString(
            "base64",
          )
        : undefined,
    };
  } catch (error) {
    console.error("Failed to scan items from table:", { tableName, error });
    throw error;
  }
}

export function buildUpdateExpression(updates: Record<string, unknown>): {
  updateExpression: string;
  expressionAttributeNames: Record<string, string>;
  expressionAttributeValues: Record<string, unknown>;
} {
  const setExpressions: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, unknown> = {};

  Object.entries(updates).forEach(([key, value]) => {
    const nameKey = `#${key}`;
    const valueKey = `:${key}`;

    setExpressions.push(`${nameKey} = ${valueKey}`);
    expressionAttributeNames[nameKey] = key;
    expressionAttributeValues[valueKey] = value;
  });

  return {
    updateExpression: `SET ${setExpressions.join(", ")}`,
    expressionAttributeNames,
    expressionAttributeValues,
  };
}
