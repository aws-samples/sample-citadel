import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as path from 'path';
import * as fs from 'fs';

// Ensure asset directories exist for CDK synthesis
const assetDirs = [
  path.resolve(__dirname, '../src/schema'),
  path.resolve(__dirname, '../dist/lambda'),
  path.resolve(__dirname, '../../src/lambda/seed-organizations'),
  path.resolve(__dirname, '../src/lambda/seed-admin-user'),
  path.resolve(__dirname, '../src/lambda/seed-organizations'),
];
for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { BackendStack } from '../lib/backend-stack';

describe('BackendStack — Apps Table GroupIndex GSI (Task 1.1)', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, 'TestBackendStack', {
      environment: 'test',
      env: { account: '123456789012', region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
  });

  test('Apps table has GroupIndex GSI with groupId partition key and sortId sort key', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'citadel-apps-test',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'GroupIndex',
          KeySchema: Match.arrayWith([
            { AttributeName: 'groupId', KeyType: 'HASH' },
            { AttributeName: 'sortId', KeyType: 'RANGE' },
          ]),
          Projection: { ProjectionType: 'ALL' },
        }),
      ]),
    });
  });

  test('Apps table still has appId as primary partition key', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'citadel-apps-test',
      KeySchema: Match.arrayWith([
        { AttributeName: 'appId', KeyType: 'HASH' },
      ]),
    });
  });

  test('Apps table still has OrgIndex GSI with orgId partition key and createdAt sort key', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'citadel-apps-test',
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'OrgIndex',
          KeySchema: Match.arrayWith([
            { AttributeName: 'orgId', KeyType: 'HASH' },
            { AttributeName: 'createdAt', KeyType: 'RANGE' },
          ]),
          Projection: { ProjectionType: 'ALL' },
        }),
      ]),
    });
  });

  test('Apps table defines groupId and sortId as String attributes', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'citadel-apps-test',
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: 'groupId', AttributeType: 'S' },
        { AttributeName: 'sortId', AttributeType: 'S' },
      ]),
    });
  });
});
