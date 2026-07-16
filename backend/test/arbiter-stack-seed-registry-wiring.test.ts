/**
 * Seed Lambda — AgentCore Registry wiring (dual-store agent seam)
 *
 * The seedConfig custom-resource Lambda must be able to create the
 * demo-echo-agent's AgentCore Registry record (in addition to its DDB row)
 * so the out-of-box demo flow can pass the app-publish readiness gate
 * (agent binding DESIGN→READY resolves the agent by name in the registry).
 *
 * Asserts on SeedAgentConfigFunction:
 *   A. Catalog layer attached (unconditional — enables the
 *      catalog.registry_client import used for the idempotency lookup).
 *   B. REGISTRY_ID / REGISTRY_ENABLED env present only when props.registryId
 *      is provided (same conditional pattern as the fabricator).
 *   C. Minimal bedrock-agentcore grants (CreateRegistryRecord +
 *      ListRegistryRecords ONLY) scoped to props.registryArn (+ /*), only
 *      when props.registryArn is provided. No mutation surface beyond
 *      create (no Update/Delete/Submit/status actions).
 *   D. SeedAgentConfigResource Version bumped so the seed re-runs on the
 *      next deploy and creates the registry record in existing envs.
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

function findSeedLambdaId(resources: Resources): string {
  const entry = Object.entries(resources).find(
    ([key, r]) =>
      (r as any).Type === 'AWS::Lambda::Function' &&
      key.startsWith('SeedAgentConfigFunction'),
  );
  if (!entry) throw new Error('SeedAgentConfigFunction not found');
  return entry[0];
}

function seedEnv(resources: Resources): Record<string, unknown> {
  return resources[findSeedLambdaId(resources)]?.Properties?.Environment?.Variables ?? {};
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

function collectAgentcoreStatements(policies: any[]): any[] {
  const statements: any[] = [];
  for (const p of policies) {
    for (const stmt of p.Properties?.PolicyDocument?.Statement ?? []) {
      const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
      if (actions.some((a: unknown) => typeof a === 'string' && a.startsWith('bedrock-agentcore:'))) {
        statements.push(stmt);
      }
    }
  }
  return statements;
}

function findSeedCustomResource(resources: Resources): any {
  const entry = Object.entries(resources).find(
    ([key, r]) =>
      (r as any).Type === 'AWS::CloudFormation::CustomResource' &&
      key.startsWith('SeedAgentConfigResource'),
  );
  if (!entry) throw new Error('SeedAgentConfigResource not found');
  return entry[1];
}

describe('ArbiterStack — seed Lambda registry wiring (dual-store agent seam)', () => {
  describe('with registryArn/registryId provided', () => {
    let resources: Resources;
    beforeAll(() => { resources = buildStack(true); });

    test('A. seed Lambda has the catalog layer attached', () => {
      const layers = resources[findSeedLambdaId(resources)]?.Properties?.Layers;
      expect(Array.isArray(layers)).toBe(true);
      const layerRefs = layers.map((l: any) => l.Ref).filter(Boolean);
      expect(
        layerRefs.some((ref: string) => ref.startsWith('ArbiterCatalogLayer')),
      ).toBe(true);
    });

    test('B. seed env carries REGISTRY_ID and REGISTRY_ENABLED', () => {
      const env = seedEnv(resources);
      expect(env.REGISTRY_ID).toBe(REGISTRY_ID);
      expect(env.REGISTRY_ENABLED).toBe('true');
    });

    test('C1. seed role grants CreateRegistryRecord + ListRegistryRecords scoped to registryArn', () => {
      const statements = collectAgentcoreStatements(
        getPoliciesForLambda(resources, findSeedLambdaId(resources)),
      );
      expect(statements.length).toBeGreaterThanOrEqual(1);
      const actions = statements.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
      expect(actions).toContain('bedrock-agentcore:CreateRegistryRecord');
      expect(actions).toContain('bedrock-agentcore:ListRegistryRecords');
      for (const stmt of statements) {
        const resourceList = Array.isArray(stmt.Resource) ? stmt.Resource : [stmt.Resource];
        expect(resourceList).toEqual(
          expect.arrayContaining([REGISTRY_ARN, `${REGISTRY_ARN}/*`]),
        );
      }
    });

    test('C2. seed role has NO registry mutation actions beyond create (least privilege)', () => {
      const actions = collectAgentcoreStatements(
        getPoliciesForLambda(resources, findSeedLambdaId(resources)),
      ).flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
      for (const forbidden of [
        'bedrock-agentcore:UpdateRegistryRecord',
        'bedrock-agentcore:UpdateRegistryRecordStatus',
        'bedrock-agentcore:SubmitRegistryRecordForApproval',
        'bedrock-agentcore:DeleteRegistryRecord',
      ]) {
        expect(actions).not.toContain(forbidden);
      }
    });

    test('D. SeedAgentConfigResource Version bumped to v1.3.0', () => {
      expect(findSeedCustomResource(resources).Properties?.Version).toBe('v1.3.0');
    });
  });

  describe('without registryArn/registryId', () => {
    let resources: Resources;
    beforeAll(() => { resources = buildStack(false); });

    test('A. catalog layer still attached (unconditional)', () => {
      const layers = resources[findSeedLambdaId(resources)]?.Properties?.Layers;
      expect(Array.isArray(layers)).toBe(true);
      const layerRefs = layers.map((l: any) => l.Ref).filter(Boolean);
      expect(
        layerRefs.some((ref: string) => ref.startsWith('ArbiterCatalogLayer')),
      ).toBe(true);
    });

    test('B. seed env has no REGISTRY_ID / REGISTRY_ENABLED', () => {
      const env = seedEnv(resources);
      expect(env.REGISTRY_ID).toBeUndefined();
      expect(env.REGISTRY_ENABLED).toBeUndefined();
    });

    test('C. seed role has zero bedrock-agentcore actions', () => {
      const statements = collectAgentcoreStatements(
        getPoliciesForLambda(resources, findSeedLambdaId(resources)),
      );
      expect(statements).toEqual([]);
    });
  });
});
