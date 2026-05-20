/**
 * Tests for organization-resolver Lambda
 */
import { DynamoDBDocumentClient, PutCommand, DeleteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

const dynamoMock = mockClient(DynamoDBDocumentClient);

jest.mock('uuid', () => ({ v4: jest.fn().mockReturnValue('org-uuid-123') }));

import { handler } from '../organization-resolver';

describe('organization-resolver', () => {
  beforeEach(() => {
    dynamoMock.reset();
    process.env.ORGANIZATIONS_TABLE = 'test-orgs';
  });

  afterEach(() => {
    delete process.env.ORGANIZATIONS_TABLE;
  });

  const makeEvent = (fieldName: string, args: any) => ({
    fieldName,
    arguments: args,
  });

  describe('createOrganization', () => {
    test('creates organization when name is unique', async () => {
      dynamoMock.on(ScanCommand).resolves({ Items: [] });
      dynamoMock.on(PutCommand).resolves({});

      const result = await handler(makeEvent('createOrganization', {
        input: { name: 'New Org', description: 'A test org' },
      }));

      expect(result.orgId).toBe('org-uuid-123');
      expect(result.name).toBe('New Org');
      expect(result.createdAt).toBeDefined();
    });

    test('throws when organization name already exists', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [{ orgId: 'existing', name: 'Duplicate' }],
      });

      await expect(
        handler(makeEvent('createOrganization', {
          input: { name: 'Duplicate' },
        }))
      ).rejects.toThrow('already exists');
    });
  });

  describe('deleteOrganization', () => {
    test('deletes existing organization', async () => {
      dynamoMock.on(ScanCommand).resolves({
        Items: [{ orgId: 'org-1', name: 'Org' }],
      });
      dynamoMock.on(DeleteCommand).resolves({});

      const result = await handler(makeEvent('deleteOrganization', { orgId: 'org-1' }));
      expect(result.success).toBe(true);
    });

    test('throws when organization not found', async () => {
      dynamoMock.on(ScanCommand).resolves({ Items: [] });

      await expect(
        handler(makeEvent('deleteOrganization', { orgId: 'missing' }))
      ).rejects.toThrow('not found');
    });
  });

  test('throws on unknown field', async () => {
    await expect(handler(makeEvent('unknownField', {}))).rejects.toThrow('Unknown field');
  });
});
