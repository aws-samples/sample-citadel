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
  path.resolve(__dirname, '../../arbiter/stepRunner'),
];
for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// PythonFunction resolves entry paths from backend/lib/ using ../../../arbiter/*
// which goes outside the workspace. Create stubs at those resolved paths for synthesis.
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

describe('ArbiterStack — Step Runner Lambda and EventBridge rules (Task 1.6)', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();

    // Create a mock BackendStack to provide cross-stack references
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

    // executionSpecificationsTable is now a required prop.
    // Provide a mock table so the stack synthesises. The test body doesn't
    // interrogate this table's wiring — it's just a dependency the
    // fabricator/worker Lambdas need.
    const executionSpecificationsTable = new dynamodb.Table(backendStack, 'ExecutionSpecificationsTable', {
      tableName: 'citadel-execution-specifications-test',
      partitionKey: { name: 'specId', type: dynamodb.AttributeType.STRING },
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
      executionSpecificationsTable,
    });

    template = Template.fromStack(stack);
  });

  // --- StepRunnerFunction ---
  describe('StepRunnerFunction', () => {
    test('exists with Python 3.14 runtime, 300s timeout, 1024MB memory', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'python3.14',
        Timeout: 300,
        MemorySize: 1024,
        Handler: 'index.handler',
      });
    });

    test('has X-Ray active tracing enabled', () => {
      const functions = template.findResources('AWS::Lambda::Function', {
        Properties: { Handler: 'index.handler', Runtime: 'python3.14', Timeout: 300 },
      });
      const logicalIds = Object.keys(functions);
      expect(logicalIds.length).toBeGreaterThanOrEqual(1);
      // Find the step runner specifically (300s timeout, python3.14)
      const stepRunnerEntry = Object.entries(functions).find(
        ([, fn]: [string, any]) =>
          fn.Properties.Timeout === 300 && fn.Properties.Runtime === 'python3.14'
      );
      expect(stepRunnerEntry).toBeDefined();
      expect(stepRunnerEntry![1].Properties.TracingConfig).toEqual({ Mode: 'Active' });
    });

    test('has correct environment variables', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'python3.14',
        Timeout: 300,
        Environment: {
          Variables: Match.objectLike({
            EXECUTIONS_TABLE: Match.anyValue(),
            WORKFLOWS_TABLE: Match.anyValue(),
            AGENT_CONFIG_TABLE: Match.anyValue(),
            TOOLS_CONFIG_TABLE: Match.anyValue(),
            EVENT_BUS_NAME: Match.anyValue(),
            APPSYNC_ENDPOINT: Match.anyValue(),
          }),
        },
      });
    });

    test('has the shared arbiter catalog layer attached', () => {
      // Resolve the catalog layer's logical id from its LayerName so the
      // shared `common`/`catalog` packages resolve at runtime.
      const layers = template.findResources('AWS::Lambda::LayerVersion', {
        Properties: { LayerName: 'citadel-arbiter-catalog-test' },
      });
      const catalogLayerId = Object.keys(layers)[0];
      expect(catalogLayerId).toBeDefined();

      // Find the step runner function (python3.14, 300s timeout) and assert it
      // references the catalog layer.
      const functions = template.findResources('AWS::Lambda::Function', {
        Properties: { Handler: 'index.handler', Runtime: 'python3.14', Timeout: 300 },
      });
      const stepRunnerEntry = Object.entries(functions).find(
        ([, fn]: [string, any]) =>
          fn.Properties.Timeout === 300 && fn.Properties.Runtime === 'python3.14'
      );
      expect(stepRunnerEntry).toBeDefined();
      const stepRunnerLayers = (stepRunnerEntry![1] as any).Properties.Layers || [];
      const referencesCatalogLayer = stepRunnerLayers.some(
        (l: any) => l && l.Ref === catalogLayerId
      );
      expect(referencesCatalogLayer).toBe(true);
    });
  });

  // --- EventBridge Rules targeting StepRunner ---
  describe('EventBridge Rules — StepRunner targets', () => {
    test('StepRunnerStartRule matches execution.start.requested', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: {
          'detail-type': ['execution.start.requested'],
        },
      });
    });

    test('StepRunnerNodeCompletedRule matches workflow.node.completed', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: {
          'detail-type': ['workflow.node.completed'],
        },
      });
    });

    test('StepRunnerNodeFailedRule matches workflow.node.failed', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: {
          'detail-type': ['workflow.node.failed'],
        },
      });
    });

    test('StepRunnerCancelRule matches execution.cancel.requested', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: {
          'detail-type': ['execution.cancel.requested'],
        },
      });
    });
  });

  // --- WorkflowProgressFanoutRule ---
  describe('WorkflowProgressFanoutRule', () => {
    test('matches workflow.* events from citadel.workflows source', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: {
          source: ['citadel.workflows'],
          'detail-type': Match.arrayWith([
            'workflow.started',
            'workflow.node.started',
            'workflow.node.completed',
            'workflow.node.failed',
            'workflow.node.retrying',
            'workflow.completed',
            'workflow.failed',
          ]),
        },
      });
    });
  });

  // --- IAM Policies (least-privilege per design 8.2) ---
  describe('IAM Policies — Step Runner least-privilege', () => {
    test('Step Runner has DynamoDB read/write on executions table', () => {
      // Cross-stack table refs use Fn::ImportValue, so we check that a policy
      // grants DynamoDB read/write actions (grantReadWriteData generates these)
      const policies = template.findResources('AWS::IAM::Policy');
      const hasDynamoDBReadWrite = Object.values(policies).some((p: any) => {
        const statements = p.Properties?.PolicyDocument?.Statement || [];
        return statements.some((s: any) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          return (
            actions.includes('dynamodb:BatchGetItem') &&
            actions.includes('dynamodb:BatchWriteItem') &&
            actions.includes('dynamodb:PutItem') &&
            actions.includes('dynamodb:DeleteItem') &&
            actions.includes('dynamodb:GetItem')
          );
        });
      });
      expect(hasDynamoDBReadWrite).toBe(true);
    });

    test('Step Runner has DynamoDB read on workflows table', () => {
      // grantReadData generates GetItem, BatchGetItem, Query, Scan, etc.
      const policies = template.findResources('AWS::IAM::Policy');
      const hasDynamoDBRead = Object.values(policies).some((p: any) => {
        const statements = p.Properties?.PolicyDocument?.Statement || [];
        return statements.some((s: any) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          // grantReadData includes these actions but NOT PutItem/DeleteItem
          return (
            actions.includes('dynamodb:GetItem') &&
            actions.includes('dynamodb:Query') &&
            actions.includes('dynamodb:Scan') &&
            !actions.includes('dynamodb:PutItem')
          );
        });
      });
      expect(hasDynamoDBRead).toBe(true);
    });

    test('Step Runner has EventBridge PutEvents permission', () => {
      const policies = template.findResources('AWS::IAM::Policy');
      const hasPutEvents = Object.values(policies).some((p: any) => {
        const statements = p.Properties?.PolicyDocument?.Statement || [];
        return statements.some((s: any) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          return actions.includes('events:PutEvents');
        });
      });
      expect(hasPutEvents).toBe(true);
    });

    test('Step Runner has DynamoDB read on agent config table', () => {
      // The agent config table is also cross-stack, so check for read-only actions
      // We verify there are at least 2 read-only policies (workflows + agent config)
      const policies = template.findResources('AWS::IAM::Policy');
      const readOnlyPolicies = Object.values(policies).filter((p: any) => {
        const statements = p.Properties?.PolicyDocument?.Statement || [];
        return statements.some((s: any) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          return (
            actions.includes('dynamodb:GetItem') &&
            actions.includes('dynamodb:Query') &&
            !actions.includes('dynamodb:PutItem')
          );
        });
      });
      // At least 2 read-only DynamoDB policies: workflows table + agent config table
      // (tools config table also gets grantReadData, so could be 3+)
      expect(readOnlyPolicies.length).toBeGreaterThanOrEqual(2);
    });
  });
});
