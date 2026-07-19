/**
 * Unit tests for seed-model-catalog Lambda (CloudFormation Custom Resource).
 * Exercises the exported seedModelCatalog function directly (no CFN plumbing):
 * baseline catalog + config Puts, idempotency conditions, and error handling.
 */

import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

import { seedModelCatalog } from '../index';

const ddbMock = mockClient(DynamoDBDocumentClient);

const CATALOG_TABLE = 'citadel-model-catalog-test';
const CONFIG_TABLE = 'citadel-model-config-test';

function makeDoc(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}));
}

describe('seed-model-catalog Lambda', () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  test('seeds catalog item with modelKey and attribute_not_exists condition', async () => {
    ddbMock.on(PutCommand).resolves({});

    await seedModelCatalog(makeDoc(), CATALOG_TABLE, CONFIG_TABLE);

    const catalogPut = ddbMock
      .commandCalls(PutCommand)
      .find((c) => c.args[0].input.TableName === CATALOG_TABLE);
    expect(catalogPut).toBeDefined();

    const input = catalogPut!.args[0].input;
    expect(input.Item!.modelKey).toBe('anthropic-claude-sonnet-5');
    expect(input.ConditionExpression).toContain('attribute_not_exists');
  });

  test('seeds config item with scope=platform and globalDefaultKey', async () => {
    ddbMock.on(PutCommand).resolves({});

    await seedModelCatalog(makeDoc(), CATALOG_TABLE, CONFIG_TABLE);

    const configPut = ddbMock
      .commandCalls(PutCommand)
      .find((c) => c.args[0].input.TableName === CONFIG_TABLE);
    expect(configPut).toBeDefined();

    const input = configPut!.args[0].input;
    expect(input.Item!.scope).toBe('platform');
    expect(input.Item!.globalDefaultKey).toBe('anthropic-claude-sonnet-5');
    // Regression guard: `scope` is a DynamoDB reserved word, so the condition
    // must use an escaped #scope alias. aws-sdk-client-mock does not validate
    // reserved words, so assert the escaped form explicitly.
    expect(input.ConditionExpression).toBe('attribute_not_exists(#scope)');
    expect(input.ExpressionAttributeNames).toEqual({ '#scope': 'scope' });
  });

  test('swallows ConditionalCheckFailedException so re-runs never clobber operator changes', async () => {
    const conditionalError = new Error('The conditional request failed');
    conditionalError.name = 'ConditionalCheckFailedException';
    ddbMock.on(PutCommand).rejects(conditionalError);

    // Should not throw — idempotent behavior on re-deploy.
    await expect(
      seedModelCatalog(makeDoc(), CATALOG_TABLE, CONFIG_TABLE),
    ).resolves.not.toThrow();
  });

  test('re-throws non-ConditionalCheckFailedException errors', async () => {
    ddbMock.on(PutCommand).rejects(new Error('InternalServerError'));

    await expect(
      seedModelCatalog(makeDoc(), CATALOG_TABLE, CONFIG_TABLE),
    ).rejects.toThrow('InternalServerError');
  });
});
