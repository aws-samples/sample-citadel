import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as path from 'path';
import * as fs from 'fs';

// Ensure asset directories / Dockerfile stub exist for CDK synthesis (mirrors
// services-stack.test.ts bootstrap so this file runs standalone).
const assetDirs = [
  path.resolve(__dirname, '../../src/schema'),
  path.resolve(__dirname, '../../src/lambda/cognito-secret-handler'),
  path.resolve(__dirname, '../dist/lambda'),
  path.resolve(__dirname, '../../../service/hld_pdf_generator'),
  path.resolve(__dirname, '../../../service/agent_intake_single'),
];
for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
const dockerStub = 'FROM public.ecr.aws/lambda/python:3.12\nCMD ["handler.handler"]\n';
for (const dockerDir of [
  path.resolve(__dirname, '../../../service/hld_pdf_generator'),
  path.resolve(__dirname, '../../../service/agent_intake_single'),
]) {
  const df = path.join(dockerDir, 'Dockerfile');
  if (!fs.existsSync(df)) fs.writeFileSync(df, dockerStub);
}

import { ServicesStack } from '../lib/services-stack';

const APPSYNC_API_ID = 'api123abc';
const APPSYNC_API_ARN = `arn:aws:appsync:us-west-2:123456789012:apis/${APPSYNC_API_ID}`;
const APPSYNC_URL = 'https://api123abc.appsync-api.us-west-2.amazonaws.com/graphql';
const REGISTRY_ID = 'reg-orch123';
const REGISTRY_ARN = 'arn:aws:bedrock-agentcore:us-west-2:123456789012:registry/reg-orch123';
const USER_POOL_ID = 'us-west-2_orchpool';
const USER_POOL_ARN = `arn:aws:cognito-idp:us-west-2:123456789012:userpool/${USER_POOL_ID}`;

const INTAKE_FIELDS = [
  'intakeActivateProjectAgents',
  'intakeCreateApp',
  'intakeCreateBlueprint',
  'intakeImportBlueprintToApp',
];

const INTAKE_FIELD_ARNS = INTAKE_FIELDS.map(
  (f) => `${APPSYNC_API_ARN}/types/Mutation/fields/${f}`,
);

function buildStack(withAppSync: boolean, withUserPool = withAppSync): cdk.assertions.Template {
  const app = new cdk.App();
  const variant = `${withAppSync ? 'A' : 'B'}${withUserPool ? '' : 'NoPool'}`;
  const prereq = new cdk.Stack(app, `IntakeOrchPrereq${variant}`, {
    env: { account: '123456789012', region: 'us-west-2' },
  });
  const bus = new events.EventBus(prereq, 'Bus', { eventBusName: 'orch-bus' });
  const bucket = new s3.Bucket(prereq, 'DocBucket');

  const stack = new ServicesStack(app, `citadel-services-orchtest${variant}`, {
    environment: 'test',
    agentEventBus: bus,
    documentBucket: bucket,
    registryArn: REGISTRY_ARN,
    registryId: REGISTRY_ID,
    ...(withAppSync && {
      appSyncApiArn: APPSYNC_API_ARN,
      appSyncApiId: APPSYNC_API_ID,
      appSyncGraphqlUrl: APPSYNC_URL,
    }),
    ...(withUserPool && {
      userPoolId: USER_POOL_ID,
      userPoolArn: USER_POOL_ARN,
    }),
    env: { account: '123456789012', region: 'us-west-2' },
  });
  return cdk.assertions.Template.fromStack(stack);
}

describe('ServicesStack — intake post-fabrication orchestration wiring', () => {
  let template: cdk.assertions.Template;

  beforeAll(() => {
    template = buildStack(true);
  });

  // ─── intake runtime role/env (R3) ───────────────────────────────────

  test('the intake runtime has APPSYNC_GRAPHQL_URL env wired from props', () => {
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      EnvironmentVariables: cdk.assertions.Match.objectLike({
        APPSYNC_GRAPHQL_URL: APPSYNC_URL,
      }),
    });
  });

  test('the intake runtime role can call appsync:GraphQL on exactly the 4 intake field ARNs', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: cdk.assertions.Match.arrayWith([
          cdk.assertions.Match.objectLike({
            Effect: 'Allow',
            Action: 'appsync:GraphQL',
            Resource: INTAKE_FIELD_ARNS,
          }),
        ]),
      },
    });
  });

  test('no appsync grant is broader than the 4 field ARNs', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const flat = JSON.stringify(policies);
    expect(flat).not.toContain('/types/Mutation/fields/*');
    expect(flat).not.toContain(`${APPSYNC_API_ARN}/*`);
  });

  test('the intake runtime role can Query/GetItem the fabrication-jobs table', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: cdk.assertions.Match.arrayWith([
          cdk.assertions.Match.objectLike({
            Effect: 'Allow',
            Action: ['dynamodb:Query', 'dynamodb:GetItem'],
            Resource:
              'arn:aws:dynamodb:us-west-2:123456789012:table/citadel-fabrication-jobs-test',
          }),
        ]),
      },
    });
  });

  // ─── intake-orchestration resolver Lambda ───────────────────────────

  test('defines the intake-orchestration resolver Lambda with server-side derivation env', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'intake-orchestration-resolver.handler',
      Runtime: 'nodejs24.x',
      Environment: {
        Variables: cdk.assertions.Match.objectLike({
          PROJECTS_TABLE: 'citadel-projects-test',
          CONVERSATIONS_TABLE: 'citadel-conversations-test',
          WORKFLOWS_TABLE: 'citadel-workflows-test',
          APPS_TABLE: 'citadel-apps-test',
          AGENT_CONFIG_TABLE: 'citadel-agents-test',
          EVENT_BUS_NAME: cdk.assertions.Match.anyValue(),
          REGISTRY_ID,
          REGISTRY_ENABLED: 'true',
          AUTHORITY_UNITS_TABLE: 'citadel-authority-units-test',
        }),
      },
    });
  });

  test('adds the intake-orchestration Lambda as an AppSync data source on the backend API', () => {
    template.hasResourceProperties('AWS::AppSync::DataSource', {
      ApiId: APPSYNC_API_ID,
      Type: 'AWS_LAMBDA',
      Name: 'IntakeOrchestrationLambdaDataSource',
    });
  });

  test.each(INTAKE_FIELDS)('attaches a Mutation resolver for %s', (fieldName) => {
    template.hasResourceProperties('AWS::AppSync::Resolver', {
      ApiId: APPSYNC_API_ID,
      TypeName: 'Mutation',
      FieldName: fieldName,
    });
  });

  test('grants the resolver read access to projects and conversations tables', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: cdk.assertions.Match.arrayWith([
          cdk.assertions.Match.objectLike({
            Effect: 'Allow',
            Action: ['dynamodb:GetItem', 'dynamodb:Scan'],
            Resource: [
              'arn:aws:dynamodb:us-west-2:123456789012:table/citadel-projects-test',
              'arn:aws:dynamodb:us-west-2:123456789012:table/citadel-conversations-test',
            ],
          }),
        ]),
      },
    });
  });

  // ─── owner-org Cognito fallback (org-less project self-healing) ─────

  test('wires USER_POOL_ID into the resolver env for the owner-org Cognito fallback', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'intake-orchestration-resolver.handler',
      Environment: {
        Variables: cdk.assertions.Match.objectLike({
          USER_POOL_ID,
        }),
      },
    });
  });

  test('grants the resolver cognito-idp:AdminGetUser scoped to exactly the user pool ARN', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: cdk.assertions.Match.arrayWith([
          cdk.assertions.Match.objectLike({
            Effect: 'Allow',
            Action: 'cognito-idp:AdminGetUser',
            Resource: USER_POOL_ARN,
          }),
        ]),
      },
    });
    // Never the broad userpool/* fallback scope.
    expect(JSON.stringify(template.findResources('AWS::IAM::Policy'))).not.toContain(
      'userpool/*',
    );
  });

  test('without user pool props, no USER_POOL_ID env and no AdminGetUser grant are synthesized', () => {
    const noPool = buildStack(true, false);
    const fns = Object.values(noPool.findResources('AWS::Lambda::Function')).filter(
      (fn) =>
        (fn.Properties as { Handler?: string }).Handler ===
        'intake-orchestration-resolver.handler',
    );
    expect(fns).toHaveLength(1);
    const envVars =
      (fns[0].Properties as { Environment?: { Variables?: Record<string, unknown> } })
        .Environment?.Variables ?? {};
    expect(envVars).not.toHaveProperty('USER_POOL_ID');
    expect(JSON.stringify(noPool.findResources('AWS::IAM::Policy'))).not.toContain(
      'cognito-idp:AdminGetUser',
    );
  });

  test('grants the resolver registry record actions WITHOUT the delete action', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const intakePolicies = Object.values(policies).filter((policy) => {
      const roles: Array<{ Ref?: string }> =
        (policy.Properties as { Roles?: Array<{ Ref?: string }> }).Roles ?? [];
      return roles.some((r) =>
        (r.Ref ?? '').includes('IntakeOrchestrationResolverFunctionServiceRole'),
      );
    });
    expect(intakePolicies.length).toBeGreaterThanOrEqual(1);

    const statements = intakePolicies.flatMap(
      (policy) =>
        (policy.Properties as { PolicyDocument?: { Statement?: Array<Record<string, unknown>> } })
          .PolicyDocument?.Statement ?? [],
    );
    const registryStatement = statements.find((stmt) => {
      const action = stmt.Action;
      return Array.isArray(action) && action.includes('bedrock-agentcore:ListRegistryRecords');
    });
    expect(registryStatement).toBeDefined();
    expect(registryStatement?.Action).toEqual(
      expect.arrayContaining([
        'bedrock-agentcore:CreateRegistryRecord',
        'bedrock-agentcore:UpdateRegistryRecord',
        'bedrock-agentcore:UpdateRegistryRecordStatus',
        'bedrock-agentcore:SubmitRegistryRecordForApproval',
        'bedrock-agentcore:GetRegistryRecord',
        'bedrock-agentcore:ListRegistryRecords',
      ]),
    );
    // No delete path exists in this resolver — the grant must stay narrower
    // than the general registry-agent-record resolver's.
    expect(registryStatement?.Action).not.toEqual(
      expect.arrayContaining(['bedrock-agentcore:DeleteRegistryRecord']),
    );
  });

  // ─── conditional wiring ─────────────────────────────────────────────

  test('without AppSync props, no intake orchestration surface is synthesized', () => {
    const bare = buildStack(false);
    const flatRuntimes = JSON.stringify(bare.findResources('AWS::BedrockAgentCore::Runtime'));
    expect(flatRuntimes).not.toContain('APPSYNC_GRAPHQL_URL');
    expect(JSON.stringify(bare.findResources('AWS::IAM::Policy'))).not.toContain(
      'appsync:GraphQL',
    );
    bare.resourceCountIs('AWS::AppSync::DataSource', 0);
    bare.resourceCountIs('AWS::AppSync::Resolver', 0);
    const lambdas = JSON.stringify(bare.findResources('AWS::Lambda::Function'));
    expect(lambdas).not.toContain('intake-orchestration-resolver.handler');
  });
});
