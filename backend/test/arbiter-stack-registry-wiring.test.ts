/**
 * PR 2 T3 — Arbiter PythonFunction Registry wiring (cross-Lambda)
 *
 * Complements T2 (Supervisor-only) by asserting PR 2's AgentCore Registry
 * wiring coherently across all 4 arbiter PythonFunctions:
 * SupervisorAgent, WorkerAgentWrapper, FabricatorAgent, ActivatorAgent.
 *
 * Coverage axes:
 *   A. Bundling commandHooks — proxy: the 4 expected PythonFunction
 *      logical-ID patterns synthesise on both stack variants. Precise
 *      `bundling.commandHooks` assertion is not practical via the CDK
 *      `Template` helper (the Code asset is synthesised to an S3Key/hash,
 *      not to the commandHooks structure). The cp-catalog commandHook
 *      is smoke-tested by `cdk synth` / deploy.
 *   B. Registry IAM policy on Supervisor/Worker/Fabricator (present when
 *      registryArn provided; absent on all 4 PythonFunctions otherwise).
 *   C. REGISTRY_ID / REGISTRY_ENABLED env on Supervisor/Worker/Fabricator
 *      (present when registryId provided; absent on all 4 otherwise).
 *   D. Activator is untouched by PR 2 — forward-compatible scope guard
 *      that catches premature wiring in a later PR (PR 4 is the planned
 *      point to wire Activator, which will need its own test bump).
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

const REGISTRY_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:registry/test-registry';
const REGISTRY_ID = 'test-registry-id';

const PREFIXES = {
  Supervisor: 'SupervisorAgent',
  Worker: 'WorkerAgentWrapper',
  Fabricator: 'FabricatorAgent',
  Activator: 'ActivatorAgent',
} as const;

type Resources = Record<string, any>;

function buildStack(withRegistry: boolean): Resources {
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
    ...(withRegistry && { registryArn: REGISTRY_ARN, registryId: REGISTRY_ID }),
  });
  return Template.fromStack(stack).toJSON().Resources as Resources;
}

// --- Helpers over the synthesised resource graph --------------------------

function findLambdaLogicalId(resources: Resources, prefix: string): string {
  const entry = Object.entries(resources).find(
    ([key, r]) =>
      (r as any).Type === 'AWS::Lambda::Function' &&
      (r as any).Properties?.Runtime === 'python3.14' &&
      key.startsWith(prefix),
  );
  if (!entry) throw new Error(`Python 3.14 Lambda with logical-ID prefix "${prefix}" not found`);
  return entry[0];
}

function getPoliciesForLambda(resources: Resources, lambdaLogicalId: string): any[] {
  const roleRef = resources[lambdaLogicalId]?.Properties?.Role?.['Fn::GetAtt']?.[0];
  if (!roleRef) return [];
  return Object.values(resources).filter(
    (r: any) =>
      r.Type === 'AWS::IAM::Policy' &&
      Array.isArray(r.Properties?.Roles) &&
      r.Properties.Roles.some((role: any) => role.Ref === roleRef),
  );
}

function collectActions(policies: any[]): string[] {
  const actions: string[] = [];
  for (const p of policies) {
    for (const stmt of p.Properties?.PolicyDocument?.Statement ?? []) {
      const stmtActions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      for (const a of stmtActions) if (typeof a === 'string') actions.push(a);
    }
  }
  return actions;
}

function findGetRegistryRecordStatement(policies: any[]): any | undefined {
  for (const p of policies) {
    for (const stmt of p.Properties?.PolicyDocument?.Statement ?? []) {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      if (actions.includes('bedrock-agentcore:GetRegistryRecord')) return stmt;
    }
  }
  return undefined;
}

function lambdaEnv(resources: Resources, lambdaLogicalId: string): Record<string, unknown> {
  return resources[lambdaLogicalId]?.Properties?.Environment?.Variables ?? {};
}

function countPythonFunctionsByPrefix(resources: Resources, prefix: string): number {
  return Object.keys(resources).filter(
    (key) =>
      resources[key].Type === 'AWS::Lambda::Function' &&
      resources[key].Properties?.Runtime === 'python3.14' &&
      key.startsWith(prefix),
  ).length;
}

// --- Tests ----------------------------------------------------------------

const positive: ReadonlyArray<readonly [string, string]> = [
  ['Supervisor', PREFIXES.Supervisor],
  ['Worker', PREFIXES.Worker],
  ['Fabricator', PREFIXES.Fabricator],
];
const allFour: ReadonlyArray<readonly [string, string]> = [
  ...positive,
  ['Activator', PREFIXES.Activator],
];

describe('ArbiterStack — Registry wiring across arbiter PythonFunctions (PR 2 T3)', () => {
  describe('with registryArn provided', () => {
    let resources: Resources;
    beforeAll(() => { resources = buildStack(true); });

    describe('A. Bundling surface — 4 PythonFunction logical IDs present', () => {
      test.each(allFour)('%s Lambda (prefix %s) synthesises as python3.14', (_label, prefix) => {
        expect(countPythonFunctionsByPrefix(resources, prefix)).toBeGreaterThanOrEqual(1);
      });
    });

    describe('B. Registry IAM policy on Supervisor/Worker/Fabricator', () => {
      test.each(positive)('%s role statement includes bedrock-agentcore:GetRegistryRecord', (_label, prefix) => {
        const stmt = findGetRegistryRecordStatement(getPoliciesForLambda(resources, findLambdaLogicalId(resources, prefix)));
        expect(stmt).toBeDefined();
        expect(stmt.Effect).toBe('Allow');
      });

      test.each(positive)('%s role statement pins Resource to registryArn (+ /*)', (_label, prefix) => {
        const stmt = findGetRegistryRecordStatement(getPoliciesForLambda(resources, findLambdaLogicalId(resources, prefix)));
        expect(stmt).toBeDefined();
        const resourceList = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
        expect(resourceList).toEqual(expect.arrayContaining([REGISTRY_ARN, `${REGISTRY_ARN}/*`]));
      });

      test('Fabricator retains full Registry CRUD action surface (unchanged by T1)', () => {
        const actions = collectActions(getPoliciesForLambda(resources, findLambdaLogicalId(resources, PREFIXES.Fabricator)));
        for (const action of [
          'bedrock-agentcore:CreateRegistryRecord',
          'bedrock-agentcore:UpdateRegistryRecord',
          'bedrock-agentcore:UpdateRegistryRecordStatus',
          'bedrock-agentcore:DeleteRegistryRecord',
          'bedrock-agentcore:GetRegistryRecord',
          'bedrock-agentcore:ListRegistryRecords',
        ]) {
          expect(actions).toContain(action);
        }
      });
    });

    describe('C. REGISTRY_ID / REGISTRY_ENABLED env on Supervisor/Worker/Fabricator', () => {
      test.each(positive)('%s env.REGISTRY_ID === props.registryId', (_label, prefix) => {
        expect(lambdaEnv(resources, findLambdaLogicalId(resources, prefix)).REGISTRY_ID).toBe(REGISTRY_ID);
      });
      test.each(positive)('%s env.REGISTRY_ENABLED === "true"', (_label, prefix) => {
        expect(lambdaEnv(resources, findLambdaLogicalId(resources, prefix)).REGISTRY_ENABLED).toBe('true');
      });
    });
  });

  describe('without registryArn', () => {
    let resources: Resources;
    beforeAll(() => { resources = buildStack(false); });

    describe('A. Bundling surface — 4 PythonFunction logical IDs still present', () => {
      test.each(allFour)('%s Lambda (prefix %s) synthesises as python3.14', (_label, prefix) => {
        expect(countPythonFunctionsByPrefix(resources, prefix)).toBeGreaterThanOrEqual(1);
      });
    });

    describe('B. No Registry IAM on any of the 4 PythonFunctions', () => {
      test.each(allFour)('%s role has zero bedrock-agentcore:* actions', (_label, prefix) => {
        const agentcore = collectActions(getPoliciesForLambda(resources, findLambdaLogicalId(resources, prefix))).filter((a) => a.startsWith('bedrock-agentcore:'));
        expect(agentcore).toEqual([]);
      });
    });

    describe('C. No REGISTRY_ID / REGISTRY_ENABLED env on any of the 4 PythonFunctions', () => {
      test.each(allFour)('%s env has no REGISTRY_ID', (_label, prefix) => {
        expect(lambdaEnv(resources, findLambdaLogicalId(resources, prefix)).REGISTRY_ID).toBeUndefined();
      });
      test.each(allFour)('%s env has no REGISTRY_ENABLED', (_label, prefix) => {
        expect(lambdaEnv(resources, findLambdaLogicalId(resources, prefix)).REGISTRY_ENABLED).toBeUndefined();
      });
    });
  });

  describe('Activator is NOT wired to Registry (PR 2 scope guard)', () => {
    describe.each([
      ['with registryArn provided', true],
      ['without registryArn', false],
    ] as ReadonlyArray<readonly [string, boolean]>)('%s', (_label, withRegistry) => {
      let resources: Resources;
      beforeAll(() => { resources = buildStack(withRegistry); });

      test('Activator role has zero bedrock-agentcore:* actions', () => {
        const agentcore = collectActions(getPoliciesForLambda(resources, findLambdaLogicalId(resources, PREFIXES.Activator))).filter((a) => a.startsWith('bedrock-agentcore:'));
        expect(agentcore).toEqual([]);
      });
      test('Activator env has no REGISTRY_ID', () => {
        expect(lambdaEnv(resources, findLambdaLogicalId(resources, PREFIXES.Activator)).REGISTRY_ID).toBeUndefined();
      });
      test('Activator env has no REGISTRY_ENABLED', () => {
        expect(lambdaEnv(resources, findLambdaLogicalId(resources, PREFIXES.Activator)).REGISTRY_ENABLED).toBeUndefined();
      });
    });
  });
});
