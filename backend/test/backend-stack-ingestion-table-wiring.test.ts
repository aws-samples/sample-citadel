/**
 * Phase 1 activation — document-upload resolver jobs-table read path.
 *
 * The authoritative DynamoDB jobs table `citadel-document-ingestion-${env}` is
 * created in ServicesStack. The document-upload resolver (handler
 * 'document-upload-resolver.handler') reads it as source of truth via the
 * INGESTION_TABLE env var, falling back to a direct Bedrock KB query when the
 * var/table is absent.
 *
 * These assertions verify that BackendStack ACTIVATES that path:
 *  - INGESTION_TABLE is set to the deterministic table name.
 *  - The resolver role has a scoped, READ-ONLY dynamodb policy
 *    (GetItem/Query) on the table ARN and its `status-index` GSI ARN.
 *  - No write actions are granted on the jobs table (least privilege).
 *
 * The ARNs are built from account/region/name (NOT a cross-stack construct
 * import) to avoid a circular dependency: ServicesStack already depends ON
 * BackendStack (it consumes props.documentBucket / props.agentEventBus), so
 * BackendStack must not reference a ServicesStack construct.
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as path from 'path';
import * as fs from 'fs';

// Ensure asset directories exist for CDK synthesis
const assetDirs = [
  path.resolve(__dirname, '../src/schema'),
  path.resolve(__dirname, '../dist/lambda'),
  path.resolve(__dirname, '../src/lambda/seed-admin-user'),
  path.resolve(__dirname, '../src/lambda/seed-organizations'),
];
for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { BackendStack } from '../lib/backend-stack';

describe('BackendStack — document-upload resolver jobs-table read path', () => {
  const account = '123456789012';
  const region = 'us-east-1';
  const tableName = 'citadel-document-ingestion-test';
  const tableArn = `arn:aws:dynamodb:${region}:${account}:table/${tableName}`;
  const gsiArn = `${tableArn}/index/status-index`;

  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, 'TestBackendStackIngestionWiring', {
      environment: 'test',
      env: { account, region },
    });
    template = Template.fromStack(stack);
  });

  test('document-upload resolver has INGESTION_TABLE set to the deterministic jobs-table name', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'document-upload-resolver.handler',
      Environment: {
        Variables: Match.objectLike({
          INGESTION_TABLE: tableName,
        }),
      },
    });
  });

  test('document-upload resolver role grants read-only dynamodb on the jobs table + status-index GSI', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith(['dynamodb:GetItem', 'dynamodb:Query']),
            Resource: Match.arrayWith([tableArn, gsiArn]),
          }),
        ]),
      },
    });
  });

  test('document-upload resolver jobs-table policy grants NO write actions (least privilege)', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const hasWriteOnJobsTable = Object.values(policies).some((policy: any) =>
      (policy.Properties.PolicyDocument.Statement as any[]).some((stmt) => {
        const resourceStr = JSON.stringify(stmt.Resource ?? '');
        if (!resourceStr.includes(tableName)) return false;
        const actions: string[] = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        return actions.some((a) =>
          ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem'].includes(a),
        );
      }),
    );
    expect(hasWriteOnJobsTable).toBe(false);
  });
});
