/**
 * Tests for the one-time backfill-project-org Lambda.
 *
 * Coverage:
 *  - Scans the projects table and updates only items missing `organization`
 *    (or where it is explicitly null) to 'Default'.
 *  - Leaves items that already carry an organization untouched.
 *  - Paginates through LastEvaluatedKey across multiple scan pages.
 *  - Tolerates a concurrent write (ConditionalCheckFailedException) without
 *    treating it as a failure.
 *  - Surfaces genuine update errors in `failedIds` without throwing.
 */
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

import { backfillProjectOrg, handler } from '../backfill-project-org';

const dynamoMock = mockClient(DynamoDBDocumentClient);

describe('backfill-project-org', () => {
  beforeEach(() => {
    dynamoMock.reset();
    process.env.PROJECTS_TABLE = 'test-projects';
  });

  afterEach(() => {
    delete process.env.PROJECTS_TABLE;
  });

  test('updates every item the Scan page returns to Default (server-side FilterExpression already excludes scoped rows)', async () => {
    // Real DynamoDB applies FilterExpression server-side, so a Scan page
    // only ever contains rows missing `organization` (or explicitly null).
    // The handler itself does not re-filter client-side — it just updates
    // whatever the page contains — so this fixture only includes rows that
    // DynamoDB's filter would actually let through.
    dynamoMock.on(ScanCommand).resolves({
      Items: [
        { id: 'proj-missing-org' }, // no organization attribute at all
        { id: 'proj-null-org', organization: null }, // explicit null
      ],
    });
    dynamoMock.on(UpdateCommand).resolves({});

    const result = await backfillProjectOrg();

    // Assert the FilterExpression sent to DynamoDB is the one that excludes
    // already-scoped rows in the first place.
    const scanCalls = dynamoMock.commandCalls(ScanCommand);
    expect(scanCalls[0].args[0].input.FilterExpression).toBe(
      'attribute_not_exists(organization) OR organization = :nullVal',
    );

    const updateCalls = dynamoMock.commandCalls(UpdateCommand);
    const updatedIdsFromCalls = updateCalls.map((c) => (c.args[0].input.Key as { id: string }).id);

    expect(result.scanned).toBe(2);
    expect(result.updatedIds.sort()).toEqual(['proj-missing-org', 'proj-null-org']);
    expect(updatedIdsFromCalls.sort()).toEqual(['proj-missing-org', 'proj-null-org']);
    expect(result.failedIds).toHaveLength(0);

    for (const call of updateCalls) {
      const values = call.args[0].input.ExpressionAttributeValues as Record<string, unknown>;
      expect(values[':org']).toBe('Default');
      // Regression: the ConditionExpression references :nullVal — it must
      // be bound in ExpressionAttributeValues or every UpdateCommand throws
      // ValidationException at runtime (undefined attribute value token).
      expect(values).toHaveProperty(':nullVal');
      expect(values[':nullVal']).toBeNull();
    }
  });

  test('paginates through multiple scan pages via LastEvaluatedKey', async () => {
    dynamoMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: [{ id: 'proj-page-1' }],
        LastEvaluatedKey: { id: 'proj-page-1' },
      })
      .resolvesOnce({
        Items: [{ id: 'proj-page-2' }],
      });
    dynamoMock.on(UpdateCommand).resolves({});

    const result = await backfillProjectOrg();

    expect(dynamoMock.commandCalls(ScanCommand)).toHaveLength(2);
    expect(result.scanned).toBe(2);
    expect(result.updatedIds.sort()).toEqual(['proj-page-1', 'proj-page-2']);
  });

  test('a concurrent write (ConditionalCheckFailedException) is treated as already-scoped, not a failure', async () => {
    dynamoMock.on(ScanCommand).resolves({ Items: [{ id: 'proj-race' }] });

    const conflict = new Error('The conditional request failed');
    conflict.name = 'ConditionalCheckFailedException';
    dynamoMock.on(UpdateCommand).rejects(conflict);

    const result = await backfillProjectOrg();

    expect(result.updatedIds).toHaveLength(0);
    expect(result.failedIds).toHaveLength(0);
  });

  test('a genuine update error is recorded in failedIds without throwing', async () => {
    dynamoMock.on(ScanCommand).resolves({ Items: [{ id: 'proj-broken' }] });
    dynamoMock.on(UpdateCommand).rejects(new Error('ProvisionedThroughputExceededException'));

    const result = await backfillProjectOrg();

    expect(result.updatedIds).toHaveLength(0);
    expect(result.failedIds).toEqual(['proj-broken']);
  });

  test('items without an id are skipped entirely', async () => {
    dynamoMock.on(ScanCommand).resolves({ Items: [{ notAnId: 'x' }] });

    const result = await backfillProjectOrg();

    expect(dynamoMock.commandCalls(UpdateCommand)).toHaveLength(0);
    expect(result.updatedIds).toHaveLength(0);
    expect(result.failedIds).toHaveLength(0);
  });

  test('handler wraps backfillProjectOrg and returns its result', async () => {
    dynamoMock.on(ScanCommand).resolves({ Items: [{ id: 'proj-handler' }] });
    dynamoMock.on(UpdateCommand).resolves({});

    const result = await handler();

    expect(result.updatedIds).toEqual(['proj-handler']);
  });
});
