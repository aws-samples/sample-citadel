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

describe('BackendStack — Registration Handler Lambda and EventBridge Rule (Task 1.2)', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, 'TestBackendStack', {
      environment: 'test',
      env: { account: '123456789012', region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
  });

  test('Registration handler Lambda function exists with correct runtime and handler', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'app-component-registration-handler.handler',
      Runtime: 'nodejs24.x',
    });
  });

  test('Registration handler has APPS_TABLE environment variable', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'app-component-registration-handler.handler',
      Environment: {
        Variables: Match.objectLike({
          APPS_TABLE: Match.objectLike({}),
        }),
      },
    });
  });

  test('EventBridge rule exists matching agent.fabricated and tool.fabricated detail types', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        'detail-type': ['agent.fabricated', 'tool.fabricated'],
      },
    });
  });

  test('EventBridge rule targets the registration handler Lambda', () => {
    // Verify the rule has a Lambda target
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: {
        'detail-type': ['agent.fabricated', 'tool.fabricated'],
      },
      Targets: Match.arrayWith([
        Match.objectLike({
          Arn: Match.objectLike({}),
        }),
      ]),
    });
  });

  test('Registration handler has IAM permissions for apps table read/write', () => {
    // Find the registration handler's role and verify it has DynamoDB permissions
    const resources = template.toJSON().Resources;
    
    // Find the registration handler Lambda
    const handlerLogicalId = Object.keys(resources).find(
      (key) =>
        resources[key].Type === 'AWS::Lambda::Function' &&
        resources[key].Properties?.Handler === 'app-component-registration-handler.handler'
    );
    expect(handlerLogicalId).toBeDefined();

    // Get the role reference from the handler
    const handlerRole = resources[handlerLogicalId!].Properties.Role;
    const roleRef = handlerRole?.['Fn::GetAtt']?.[0];
    expect(roleRef).toBeDefined();

    // Find IAM policies attached to this role
    const policies = Object.values(resources).filter(
      (r: any) =>
        r.Type === 'AWS::IAM::Policy' &&
        r.Properties?.Roles?.some((role: any) => role.Ref === roleRef)
    );
    expect(policies.length).toBeGreaterThan(0);

    // Verify at least one policy has DynamoDB read/write actions
    const hasDynamoPermissions = policies.some((policy: any) =>
      policy.Properties.PolicyDocument.Statement.some(
        (stmt: any) =>
          stmt.Effect === 'Allow' &&
          Array.isArray(stmt.Action) &&
          stmt.Action.includes('dynamodb:PutItem') &&
          stmt.Action.includes('dynamodb:GetItem') &&
          stmt.Action.includes('dynamodb:Query')
      )
    );
    expect(hasDynamoPermissions).toBe(true);
  });
});
