/**
 * Fabricator pipeline reliability (hardening)
 *
 * Two SQS->Lambda invariants that previously caused duplicate fabrication
 * and premature DLQ delivery:
 *
 *   1. The fabricator queue's visibilityTimeout MUST strictly exceed the
 *      FabricatorAgent Lambda's function timeout. Equal values guarantee an
 *      SQS redelivery whenever an invocation runs near the timeout (a single
 *      fabrication was observed at ~11 min against a 15-min timeout), which
 *      stacks duplicate fabrications and prematurely drains the DLQ.
 *
 *   2. The SqsEventSource batchSize MUST be 1 so each Lambda invocation
 *      processes exactly ONE fabrication message, bounding invocation
 *      duration to a single agent rather than up to 10 stacked agents under
 *      the SQS default batch size.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import * as path from 'path';
import * as fs from 'fs';

// CI + clean-checkout safety: stub the asset dirs that ArbiterStack expects.
const assetDirs = [
  path.resolve(__dirname, '../dist/lambda'),
  path.resolve(__dirname, '../src/schema'),
];
for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
const libDir = path.resolve(__dirname, '../lib');
for (const mod of ['supervisor', 'workerWrapper', 'fabricator', 'seedConfig', 'stepRunner', 'activator']) {
  const resolvedDir = path.resolve(libDir, `../../../arbiter/${mod}`);
  if (!fs.existsSync(resolvedDir)) fs.mkdirSync(resolvedDir, { recursive: true });
  const indexFile = path.join(resolvedDir, 'index.py');
  if (!fs.existsSync(indexFile)) {
    fs.writeFileSync(indexFile, 'def handler(event, context): pass\ndef lambda_handler(event, context): pass\n');
  }
}

import { ArbiterStack } from '../lib/arbiter-stack';

type Resources = Record<string, any>;

function buildResources(): Resources {
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
  const codeBucket = new Bucket(backendStack, 'CodeBucket', { bucketName: 'citadel-code-test' });
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
    executionSpecificationsTable,
  });
  return Template.fromStack(stack).toJSON().Resources as Resources;
}

function findFabricatorFunctionTimeout(resources: Resources): number {
  // The FabricatorAgent PythonFunction is the python3.14 Lambda whose
  // logical id starts with "FabricatorAgent".
  const entry = Object.entries(resources).find(
    ([key, r]) =>
      (r as any).Type === 'AWS::Lambda::Function' &&
      (r as any).Properties?.Runtime === 'python3.14' &&
      key.startsWith('FabricatorAgent'),
  );
  if (!entry) throw new Error('FabricatorAgent Lambda not found');
  const timeout = (entry[1] as any).Properties?.Timeout;
  if (typeof timeout !== 'number') throw new Error('FabricatorAgent timeout not a number');
  return timeout;
}

function findFabricatorQueueLogicalId(resources: Resources): string {
  const entry = Object.entries(resources).find(
    ([, r]) =>
      (r as any).Type === 'AWS::SQS::Queue' &&
      (r as any).Properties?.QueueName === 'citadel-fabricator-queue-test',
  );
  if (!entry) throw new Error('fabricator queue not found');
  return entry[0];
}

function findFabricatorQueueVisibility(resources: Resources): number {
  const logicalId = findFabricatorQueueLogicalId(resources);
  const vt = (resources[logicalId] as any).Properties?.VisibilityTimeout;
  if (typeof vt !== 'number') throw new Error('fabricator queue VisibilityTimeout not a number');
  return vt;
}

function findFabricatorEventSourceBatchSize(resources: Resources): number {
  const queueLogicalId = findFabricatorQueueLogicalId(resources);
  const entry = Object.entries(resources).find(([, r]) => {
    if ((r as any).Type !== 'AWS::Lambda::EventSourceMapping') return false;
    const arn = (r as any).Properties?.EventSourceArn;
    // Queue ARN is emitted as { 'Fn::GetAtt': [<queueLogicalId>, 'Arn'] }.
    return arn?.['Fn::GetAtt']?.[0] === queueLogicalId;
  });
  if (!entry) throw new Error('fabricator queue event source mapping not found');
  return (entry[1] as any).Properties?.BatchSize;
}

describe('ArbiterStack — fabricator pipeline reliability', () => {
  let resources: Resources;
  beforeAll(() => { resources = buildResources(); });

  test('fabricator queue visibilityTimeout strictly exceeds the FabricatorAgent function timeout', () => {
    const functionTimeout = findFabricatorFunctionTimeout(resources);
    const queueVisibility = findFabricatorQueueVisibility(resources);
    expect(queueVisibility).toBeGreaterThan(functionTimeout);
  });

  test('fabricator SqsEventSource batchSize is 1', () => {
    expect(findFabricatorEventSourceBatchSize(resources)).toBe(1);
  });
});
