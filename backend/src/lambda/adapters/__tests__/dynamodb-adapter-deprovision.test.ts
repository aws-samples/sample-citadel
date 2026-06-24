/**
 * TDD Tests for DynamoDBAdapter.deprovision
 *
 * When a DynamoDB data store is deleted and was provisioned (CREATE_NEW mode),
 * the underlying DynamoDB table should be deleted.
 */
import { DynamoDBClient, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const dynamoMock = mockClient(DynamoDBClient);

import { DynamoDBAdapter } from '../dynamodb-adapter';

describe('DynamoDBAdapter.deprovision', () => {
  const adapter = new DynamoDBAdapter();

  beforeEach(() => {
    dynamoMock.reset();
  });

  test('deprovision method exists', () => {
    expect(adapter.deprovision).toBeDefined();
    expect(typeof adapter.deprovision).toBe('function');
  });

  test('calls DeleteTableCommand with the table name', async () => {
    dynamoMock.on(DeleteTableCommand).resolves({});

    await adapter.deprovision!({ tableName: 'my-table' });

    const calls = dynamoMock.commandCalls(DeleteTableCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.TableName).toBe('my-table');
  });

  test('succeeds gracefully if table already deleted', async () => {
    const notFoundError = new Error('Table not found');
    notFoundError.name = 'ResourceNotFoundException';
    dynamoMock.on(DeleteTableCommand).rejects(notFoundError);

    await expect(
      adapter.deprovision!({ tableName: 'gone-table' })
    ).resolves.toBeUndefined();
  });

  test('uses scoped credentials when provided', async () => {
    dynamoMock.on(DeleteTableCommand).resolves({});

    await adapter.deprovision!(
      { tableName: 'my-table' },
      { accessKeyId: 'AKIA...', secretAccessKey: 'secret', sessionToken: 'token' }
    );

    const calls = dynamoMock.commandCalls(DeleteTableCommand);
    expect(calls).toHaveLength(1);
  });

  test('propagates unexpected errors', async () => {
    const internalError = new Error('Internal failure');
    internalError.name = 'InternalServerError';
    dynamoMock.on(DeleteTableCommand).rejects(internalError);

    await expect(
      adapter.deprovision!({ tableName: 'my-table' })
    ).rejects.toThrow('Internal failure');
  });
});
