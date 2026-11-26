/**
 * Idempotency utility for EventBridge-triggered Lambda handlers.
 *
 * Uses a DynamoDB table to track processed event IDs with a TTL.
 * If an event has already been processed, the handler is skipped.
 *
 * Usage:
 *   const guard = new IdempotencyGuard(tableName);
 *   await guard.withIdempotency(eventId, async () => { ... });
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24 hours

export class IdempotencyGuard {
  private tableName: string;
  private ttlSeconds: number;

  constructor(tableName: string, ttlSeconds: number = DEFAULT_TTL_SECONDS) {
    this.tableName = tableName;
    this.ttlSeconds = ttlSeconds;
  }

  /**
   * Execute `fn` only if `eventId` has not been processed before.
   * Returns true if the handler executed, false if it was a duplicate.
   */
  async withIdempotency<T>(eventId: string, fn: () => Promise<T>): Promise<{ executed: boolean; result?: T }> {
    const now = Math.floor(Date.now() / 1000);
    const ttl = now + this.ttlSeconds;

    try {
      // Conditional put — fails if the eventId already exists and hasn't expired
      await ddbClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          eventId,
          processedAt: new Date().toISOString(),
          ttl,
        },
        ConditionExpression: 'attribute_not_exists(eventId)',
      }));
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
        console.log(`Idempotency: skipping duplicate event ${eventId}`);
        return { executed: false };
      }
      // Unexpected error — let it propagate so the event is retried
      throw error;
    }

    const result = await fn();
    return { executed: true, result };
  }
}
