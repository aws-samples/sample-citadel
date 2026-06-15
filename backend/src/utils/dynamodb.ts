import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

export interface PaginationOptions {
  limit?: number;
  nextToken?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  nextToken?: string;
}

export async function getItem<T extends Record<string, any>>(tableName: string, key: Record<string, any>): Promise<T | null> {
  try {
    const command = new GetCommand({
      TableName: tableName,
      Key: key,
    });

    const result = await docClient.send(command);
    return result.Item as T || null;
  } catch (error) {
    console.error(`Failed to get item from ${tableName}:`, error);
    throw error;
  }
}

export async function putItem<T extends Record<string, any>>(tableName: string, item: T): Promise<void> {
  try {
    const command = new PutCommand({
      TableName: tableName,
      Item: item,
    });

    await docClient.send(command);
  } catch (error) {
    console.error(`Failed to put item to ${tableName}:`, error);
    throw error;
  }
}

export async function updateItem<T extends Record<string, any>>(
  tableName: string,
  key: Record<string, any>,
  updateExpression: string,
  expressionAttributeNames?: Record<string, string>,
  expressionAttributeValues?: Record<string, any>
): Promise<T> {
  try {
    const command = new UpdateCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    });

    const result = await docClient.send(command);
    return result.Attributes as T;
  } catch (error) {
    console.error(`Failed to update item in ${tableName}:`, error);
    throw error;
  }
}

export async function deleteItem(tableName: string, key: Record<string, any>): Promise<void> {
  try {
    const command = new DeleteCommand({
      TableName: tableName,
      Key: key,
    });

    await docClient.send(command);
  } catch (error) {
    console.error(`Failed to delete item from ${tableName}:`, error);
    throw error;
  }
}

export async function queryItems<T extends Record<string, any>>(
  tableName: string,
  keyConditionExpression: string,
  expressionAttributeValues: Record<string, any>,
  options?: PaginationOptions & {
    indexName?: string;
    filterExpression?: string;
    expressionAttributeNames?: Record<string, string>;
    scanIndexForward?: boolean;
  }
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
      ExclusiveStartKey: options?.nextToken ? JSON.parse(Buffer.from(options.nextToken, 'base64').toString()) : undefined,
      ScanIndexForward: options?.scanIndexForward,
    });

    const result = await docClient.send(command);
    
    return {
      items: result.Items as T[] || [],
      nextToken: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64') : undefined,
    };
  } catch (error) {
    console.error(`Failed to query items from ${tableName}:`, error);
    throw error;
  }
}

export async function scanItems<T extends Record<string, any>>(
  tableName: string,
  options?: PaginationOptions & {
    filterExpression?: string;
    expressionAttributeNames?: Record<string, string>;
    expressionAttributeValues?: Record<string, any>;
  }
): Promise<PaginatedResult<T>> {
  try {
    const command = new ScanCommand({
      TableName: tableName,
      FilterExpression: options?.filterExpression,
      ExpressionAttributeNames: options?.expressionAttributeNames,
      ExpressionAttributeValues: options?.expressionAttributeValues,
      Limit: options?.limit,
      ExclusiveStartKey: options?.nextToken ? JSON.parse(Buffer.from(options.nextToken, 'base64').toString()) : undefined,
    });

    const result = await docClient.send(command);
    
    return {
      items: result.Items as T[] || [],
      nextToken: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64') : undefined,
    };
  } catch (error) {
    console.error(`Failed to scan items from ${tableName}:`, error);
    throw error;
  }
}

export function buildUpdateExpression(updates: Record<string, any>): {
  updateExpression: string;
  expressionAttributeNames: Record<string, string>;
  expressionAttributeValues: Record<string, any>;
} {
  const setExpressions: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, any> = {};

  Object.entries(updates).forEach(([key, value]) => {
    const nameKey = `#${key}`;
    const valueKey = `:${key}`;
    
    setExpressions.push(`${nameKey} = ${valueKey}`);
    expressionAttributeNames[nameKey] = key;
    expressionAttributeValues[valueKey] = value;
  });

  return {
    updateExpression: `SET ${setExpressions.join(', ')}`,
    expressionAttributeNames,
    expressionAttributeValues,
  };
}