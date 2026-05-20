import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as appsync from '@aws-cdk/aws-appsync-alpha';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import * as path from 'path';
import * as fs from 'fs';

// Ensure asset directories exist for CDK synthesis
const assetDirs = [
  path.resolve(__dirname, '../dist/lambda'),
  path.resolve(__dirname, '../src/schema'),
];
for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// PythonFunction resolves entry paths from backend/lib/ using ../../../arbiter/*
const libDir = path.resolve(__dirname, '../lib');
const pythonModules = ['supervisor', 'workerWrapper', 'fabricator', 'seedConfig', 'stepRunner'];
for (const mod of pythonModules) {
  const resolvedDir = path.resolve(libDir, `../../../arbiter/${mod}`);
  if (!fs.existsSync(resolvedDir)) fs.mkdirSync(resolvedDir, { recursive: true });
  const indexFile = path.join(resolvedDir, 'index.py');
  if (!fs.existsSync(indexFile)) {
    fs.writeFileSync(indexFile, 'def handler(event, context): pass\ndef lambda_handler(event, context): pass\n');
  }
}

import { ArbiterStack } from '../lib/arbiter-stack';

describe('ArbiterStack — Supervisor Lambda APPS_TABLE environment (Task 1.3)', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();

    const backendStack = new cdk.Stack(app, 'MockBackendStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });

    const agentEventBus = new events.EventBus(backendStack, 'AgentEventBus', {
      eventBusName: 'citadel-agents-test',
    });

    const agentConfigTable = new dynamodb.Table(backendStack, 'AgentConfigTable', {
      tableName: 'citadel-agents-test',
      partitionKey: { name: 'agentId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const codeBucket = new Bucket(backendStack, 'CodeBucket', {
      bucketName: 'citadel-code-test',
    });

    const workflowsTable = new dynamodb.Table(backendStack, 'WorkflowsTable', {
      tableName: 'citadel-workflows-test',
      partitionKey: { name: 'workflowId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const executionsTable = new dynamodb.Table(backendStack, 'ExecutionsTable', {
      tableName: 'citadel-executions-test',
      partitionKey: { name: 'executionId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fanoutFunction = new lambda.Function(backendStack, 'FanoutFunction', {
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'workflow-progress-fanout.handler',
      code: lambda.Code.fromAsset('dist/lambda'),
      timeout: cdk.Duration.seconds(30),
    });

    const appSyncApi = new appsync.GraphqlApi(backendStack, 'MockApi', {
      name: 'mock-api',
      schema: appsync.SchemaFile.fromAsset(
        path.resolve(__dirname, '../src/schema/schema.graphql')
      ),
    });

    const appsTable = new dynamodb.Table(backendStack, 'AppsTable', {
      tableName: 'citadel-apps-test',
      partitionKey: { name: 'appId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const stack = new ArbiterStack(app, 'TestArbiterStack', {
      environment: 'test',
      env: { account: '123456789012', region: 'us-east-1' },
      agentEventBus,
      agentConfigTable,
      codeBucket,
      workflowsTable,
      executionsTable,
      fanoutFunction,
      appSyncEndpoint: appSyncApi.graphqlUrl,
      appsTable,
    });

    template = Template.fromStack(stack);
  });

  test('Supervisor Lambda has APPS_TABLE environment variable', () => {
    // The Supervisor is a Python 3.14 Lambda with 30s timeout (distinguishes it from StepRunner at 300s)
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'python3.14',
      Timeout: 30,
      Environment: {
        Variables: Match.objectLike({
          APPS_TABLE: Match.anyValue(),
        }),
      },
    });
  });

  test('Supervisor Lambda has DynamoDB read access on apps table', () => {
    const resources = template.toJSON().Resources;

    // Find the Supervisor Lambda (python3.14, 30s timeout)
    const supervisorLogicalId = Object.keys(resources).find(
      (key) =>
        resources[key].Type === 'AWS::Lambda::Function' &&
        resources[key].Properties?.Runtime === 'python3.14' &&
        resources[key].Properties?.Timeout === 30
    );
    expect(supervisorLogicalId).toBeDefined();

    // Get the role reference from the supervisor
    const supervisorRole = resources[supervisorLogicalId!].Properties.Role;
    const roleRef = supervisorRole?.['Fn::GetAtt']?.[0];
    expect(roleRef).toBeDefined();

    // Find IAM policies attached to this role
    const policies = Object.values(resources).filter(
      (r: any) =>
        r.Type === 'AWS::IAM::Policy' &&
        r.Properties?.Roles?.some((role: any) => role.Ref === roleRef)
    );
    expect(policies.length).toBeGreaterThan(0);

    // Verify at least one policy has DynamoDB read actions (from grantReadData)
    // grantReadData grants: GetItem, BatchGetItem, ConditionCheckItem, Query, Scan
    // but NOT PutItem, DeleteItem, UpdateItem, BatchWriteItem
    const hasReadOnlyDynamoPermissions = policies.some((policy: any) =>
      policy.Properties.PolicyDocument.Statement.some(
        (stmt: any) =>
          stmt.Effect === 'Allow' &&
          Array.isArray(stmt.Action) &&
          stmt.Action.includes('dynamodb:GetItem') &&
          stmt.Action.includes('dynamodb:Query') &&
          !stmt.Action.includes('dynamodb:PutItem')
      )
    );
    expect(hasReadOnlyDynamoPermissions).toBe(true);
  });
});
