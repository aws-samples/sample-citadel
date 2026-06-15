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
const pythonModules = ['supervisor', 'workerWrapper', 'fabricator', 'seedConfig', 'stepRunner', 'activator'];
for (const mod of pythonModules) {
  const resolvedDir = path.resolve(libDir, `../../../arbiter/${mod}`);
  if (!fs.existsSync(resolvedDir)) fs.mkdirSync(resolvedDir, { recursive: true });
  const indexFile = path.join(resolvedDir, 'index.py');
  if (!fs.existsSync(indexFile)) {
    fs.writeFileSync(indexFile, 'def handler(event, context): pass\ndef lambda_handler(event, context): pass\n');
  }
}

import { ArbiterStack } from '../lib/arbiter-stack';

/**
 * Helper: find the single Supervisor Lambda logical ID by its unique env signature
 * (ORCHESTRATION_TABLE + WORKER_STATE_TABLE are Supervisor-only).
 */
function findSupervisorLogicalId(template: Template): string {
  const resources = template.findResources('AWS::Lambda::Function', {
    Properties: Match.objectLike({
      Environment: {
        Variables: Match.objectLike({
          ORCHESTRATION_TABLE: Match.anyValue(),
          WORKER_STATE_TABLE: Match.anyValue(),
        }),
      },
    }),
  });
  const ids = Object.keys(resources);
  expect(ids).toHaveLength(1);
  return ids[0];
}

/**
 * Helper: find IAM policies attached to a given role logical ID.
 */
function findPoliciesForRole(template: Template, roleLogicalId: string): any[] {
  const all = template.toJSON().Resources;
  return Object.values(all).filter(
    (r: any) =>
      r.Type === 'AWS::IAM::Policy' &&
      r.Properties?.Roles?.some((role: any) => role.Ref === roleLogicalId),
  );
}

/** Shared fixture: creates the BackendStack dependencies for ArbiterStack. */
function createFixture(app: cdk.App) {
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
      path.resolve(__dirname, '../src/schema/schema.graphql'),
    ),
  });

  const appsTable = new dynamodb.Table(backendStack, 'AppsTable', {
    tableName: 'citadel-apps-test',
    partitionKey: { name: 'appId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  const executionSpecificationsTable = new dynamodb.Table(backendStack, 'ExecutionSpecificationsTable', {
    tableName: 'citadel-execution-specifications-test',
    partitionKey: { name: 'specId', type: dynamodb.AttributeType.STRING },
    billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });

  return {
    agentEventBus,
    agentConfigTable,
    codeBucket,
    workflowsTable,
    executionsTable,
    fanoutFunction,
    appSyncEndpoint: appSyncApi.graphqlUrl,
    appsTable,
    executionSpecificationsTable,
  };
}

describe('Supervisor with registryArn provided', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const fixture = createFixture(app);

    const stack = new ArbiterStack(app, 'TestArbiterStack', {
      environment: 'test',
      env: { account: '123456789012', region: 'us-east-1' },
      ...fixture,
      registryArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:registry/test-registry',
      registryId: 'test-registry',
    });

    template = Template.fromStack(stack);
  });

  test('SupervisorAgent Lambda exists exactly once (pinned by env signature)', () => {
    const id = findSupervisorLogicalId(template);
    expect(id).toMatch(/^SupervisorAgent/);
  });

  test('Supervisor has APPS_TABLE environment variable (back-compat)', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          ORCHESTRATION_TABLE: Match.anyValue(),
          WORKER_STATE_TABLE: Match.anyValue(),
          APPS_TABLE: Match.anyValue(),
        }),
      },
    });
  });

  test('Supervisor has REGISTRY_ID environment variable', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          ORCHESTRATION_TABLE: Match.anyValue(),
          WORKER_STATE_TABLE: Match.anyValue(),
          REGISTRY_ID: Match.anyValue(),
        }),
      },
    });
  });

  test('Supervisor has REGISTRY_ENABLED = true', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          ORCHESTRATION_TABLE: Match.anyValue(),
          WORKER_STATE_TABLE: Match.anyValue(),
          REGISTRY_ENABLED: 'true',
        }),
      },
    });
  });

  test('Supervisor has DynamoDB read-only IAM on AppsTable (back-compat)', () => {
    const supervisorId = findSupervisorLogicalId(template);
    const all = template.toJSON().Resources;
    const roleRef = all[supervisorId].Properties.Role['Fn::GetAtt'][0];

    const policies = findPoliciesForRole(template, roleRef);
    expect(policies.length).toBeGreaterThan(0);

    const hasDdbRead = policies.some((policy: any) =>
      policy.Properties.PolicyDocument.Statement.some(
        (stmt: any) =>
          stmt.Effect === 'Allow' &&
          Array.isArray(stmt.Action) &&
          stmt.Action.includes('dynamodb:GetItem') &&
          stmt.Action.includes('dynamodb:Query') &&
          !stmt.Action.includes('dynamodb:PutItem'),
      ),
    );
    expect(hasDdbRead).toBe(true);
  });

  test('Supervisor has Registry read IAM (GetRegistryRecord + ListRegistryRecords)', () => {
    const supervisorId = findSupervisorLogicalId(template);
    const all = template.toJSON().Resources;
    const roleRef = all[supervisorId].Properties.Role['Fn::GetAtt'][0];

    const policies = findPoliciesForRole(template, roleRef);
    expect(policies.length).toBeGreaterThan(0);

    const hasRegistryRead = policies.some((policy: any) =>
      policy.Properties.PolicyDocument.Statement.some(
        (stmt: any) =>
          stmt.Effect === 'Allow' &&
          Array.isArray(stmt.Action) &&
          stmt.Action.includes('bedrock-agentcore:GetRegistryRecord') &&
          stmt.Action.includes('bedrock-agentcore:ListRegistryRecords'),
      ),
    );
    expect(hasRegistryRead).toBe(true);
  });
});

describe('Supervisor without registryArn', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const fixture = createFixture(app);

    const stack = new ArbiterStack(app, 'TestArbiterStackNoRegistry', {
      environment: 'test',
      env: { account: '123456789012', region: 'us-east-1' },
      ...fixture,
      registryArn: undefined,
      registryId: undefined,
    });

    template = Template.fromStack(stack);
  });

  test('Supervisor does NOT have REGISTRY_ID when registryArn is absent', () => {
    const supervisorId = findSupervisorLogicalId(template);
    const all = template.toJSON().Resources;
    const envVars = all[supervisorId].Properties.Environment.Variables;

    expect(envVars).not.toHaveProperty('REGISTRY_ID');
    expect(envVars).not.toHaveProperty('REGISTRY_ENABLED');
  });

  test('Supervisor does NOT have Registry IAM when registryArn is absent', () => {
    const supervisorId = findSupervisorLogicalId(template);
    const all = template.toJSON().Resources;
    const roleRef = all[supervisorId].Properties.Role['Fn::GetAtt'][0];

    const policies = findPoliciesForRole(template, roleRef);

    const hasRegistryRead = policies.some((policy: any) =>
      policy.Properties.PolicyDocument.Statement.some(
        (stmt: any) =>
          Array.isArray(stmt.Action) &&
          stmt.Action.includes('bedrock-agentcore:GetRegistryRecord'),
      ),
    );
    expect(hasRegistryRead).toBe(false);
  });
});
