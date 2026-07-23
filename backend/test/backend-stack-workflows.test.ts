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

describe('BackendStack — Workflow/App/Execution Lambda functions and AppSync wiring (Task 1.5)', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, 'TestBackendStack', {
      environment: 'test',
      env: { account: '123456789012', region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
  });

  // --- WorkflowResolverFunction ---
  describe('WorkflowResolverFunction', () => {
    test('exists with Node.js 24.x runtime, 30s timeout, and correct env vars', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'workflow-resolver.handler',
        Runtime: 'nodejs24.x',
        Timeout: 30,
        Environment: {
          Variables: Match.objectLike({
            WORKFLOWS_TABLE: Match.anyValue(),
            APPS_TABLE: Match.anyValue(),
            AGENT_CONFIG_TABLE: Match.anyValue(),
            EVENT_BUS_NAME: Match.anyValue(),
            USER_POOL_ID: Match.anyValue(),
          }),
        },
      });
    });

    test('has X-Ray active tracing enabled', () => {
      // The stack applies X-Ray tracing to all Lambda functions via node.findAll()
      const functions = template.findResources('AWS::Lambda::Function', {
        Properties: { Handler: 'workflow-resolver.handler' },
      });
      const logicalId = Object.keys(functions)[0];
      expect(logicalId).toBeDefined();
      const fn = functions[logicalId];
      expect(fn.Properties.TracingConfig).toEqual({ Mode: 'Active' });
    });
  });

  // --- RegistryAgentRecordResolverFunction (PR 6a rename of the former AgentAppShimResolverFunction) ---
  describe('RegistryAgentRecordResolverFunction', () => {
    test('exists with Node.js 24.x runtime, 30s timeout, and correct env vars', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'registry-agent-record-resolver.handler',
        Runtime: 'nodejs24.x',
        Timeout: 30,
        Environment: {
          Variables: Match.objectLike({
            APPS_TABLE: Match.anyValue(),
            WORKFLOWS_TABLE: Match.anyValue(),
            AGENT_CONFIG_TABLE: Match.anyValue(),
            EVENT_BUS_NAME: Match.anyValue(),
            USER_POOL_ID: Match.anyValue(),
          }),
        },
      });
    });

    test('has X-Ray active tracing enabled', () => {
      const functions = template.findResources('AWS::Lambda::Function', {
        Properties: { Handler: 'registry-agent-record-resolver.handler' },
      });
      const logicalId = Object.keys(functions)[0];
      expect(logicalId).toBeDefined();
      expect(functions[logicalId].Properties.TracingConfig).toEqual({ Mode: 'Active' });
    });
  });

  // --- ExecutionResolverFunction ---
  describe('ExecutionResolverFunction', () => {
    test('exists with Node.js 24.x runtime, 30s timeout, and correct env vars', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'execution-resolver.handler',
        Runtime: 'nodejs24.x',
        Timeout: 30,
        Environment: {
          Variables: Match.objectLike({
            EXECUTIONS_TABLE: Match.anyValue(),
            WORKFLOWS_TABLE: Match.anyValue(),
            EVENT_BUS_NAME: Match.anyValue(),
            USER_POOL_ID: Match.anyValue(),
          }),
        },
      });
    });

    test('has X-Ray active tracing enabled', () => {
      const functions = template.findResources('AWS::Lambda::Function', {
        Properties: { Handler: 'execution-resolver.handler' },
      });
      const logicalId = Object.keys(functions)[0];
      expect(logicalId).toBeDefined();
      expect(functions[logicalId].Properties.TracingConfig).toEqual({ Mode: 'Active' });
    });
  });

  // --- WorkflowProgressFanoutFunction ---
  describe('WorkflowProgressFanoutFunction', () => {
    test('exists with Node.js 24.x runtime, 30s timeout, and APPSYNC_ENDPOINT env var', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'workflow-progress-fanout.handler',
        Runtime: 'nodejs24.x',
        Timeout: 30,
        Environment: {
          Variables: Match.objectLike({
            APPSYNC_ENDPOINT: Match.anyValue(),
          }),
        },
      });
    });

    test('has X-Ray active tracing enabled', () => {
      const functions = template.findResources('AWS::Lambda::Function', {
        Properties: { Handler: 'workflow-progress-fanout.handler' },
      });
      const logicalId = Object.keys(functions)[0];
      expect(logicalId).toBeDefined();
      expect(functions[logicalId].Properties.TracingConfig).toEqual({ Mode: 'Active' });
    });
  });

  // --- AppSync Data Sources ---
  describe('AppSync Lambda Data Sources', () => {
    test('WorkflowLambdaDataSource exists', () => {
      template.hasResourceProperties('AWS::AppSync::DataSource', {
        Type: 'AWS_LAMBDA',
        Name: 'WorkflowLambdaDataSource',
      });
    });

    test('RegistryAgentRecordLambdaDataSource exists', () => {
      template.hasResourceProperties('AWS::AppSync::DataSource', {
        Type: 'AWS_LAMBDA',
        Name: 'RegistryAgentRecordLambdaDataSource',
      });
    });

    test('ExecutionLambdaDataSource exists', () => {
      template.hasResourceProperties('AWS::AppSync::DataSource', {
        Type: 'AWS_LAMBDA',
        Name: 'ExecutionLambdaDataSource',
      });
    });
  });

  // --- AppSync Resolvers ---
  describe('AppSync Resolvers — Workflow', () => {
    const workflowQueryFields = [
      'getWorkflow', 'listWorkflows', 'listBlueprints',
      'exportWorkflow', 'getWorkflowVersion', 'listAppWorkflows',
    ];
    const workflowMutationFields = [
      'createWorkflow', 'updateWorkflow', 'deleteWorkflow',
      'publishWorkflow', 'updateWorkflowConfiguration',
      'importBlueprint', 'importWorkflow',
    ];

    test.each(workflowQueryFields)('Query resolver for %s exists', (fieldName) => {
      template.hasResourceProperties('AWS::AppSync::Resolver', {
        TypeName: 'Query',
        FieldName: fieldName,
      });
    });

    test.each(workflowMutationFields)('Mutation resolver for %s exists', (fieldName) => {
      template.hasResourceProperties('AWS::AppSync::Resolver', {
        TypeName: 'Mutation',
        FieldName: fieldName,
      });
    });
  });

  describe('AppSync Resolvers — App', () => {
    const appQueryFields = ['getApp', 'listApps'];
    const appMutationFields = [
      'createApp', 'updateApp', 'deleteApp',
      'bindWorkflowToApp', 'unbindWorkflowFromApp',
    ];

    test.each(appQueryFields)('Query resolver for %s exists', (fieldName) => {
      template.hasResourceProperties('AWS::AppSync::Resolver', {
        TypeName: 'Query',
        FieldName: fieldName,
      });
    });

    test.each(appMutationFields)('Mutation resolver for %s exists', (fieldName) => {
      template.hasResourceProperties('AWS::AppSync::Resolver', {
        TypeName: 'Mutation',
        FieldName: fieldName,
      });
    });
  });

  describe('AppSync Resolvers — Execution', () => {
    const executionQueryFields = ['getExecution', 'listExecutions'];
    const executionMutationFields = [
      'startExecution', 'cancelExecution', 'publishWorkflowProgress',
    ];

    test.each(executionQueryFields)('Query resolver for %s exists', (fieldName) => {
      template.hasResourceProperties('AWS::AppSync::Resolver', {
        TypeName: 'Query',
        FieldName: fieldName,
      });
    });

    test.each(executionMutationFields)('Mutation resolver for %s exists', (fieldName) => {
      template.hasResourceProperties('AWS::AppSync::Resolver', {
        TypeName: 'Mutation',
        FieldName: fieldName,
      });
    });
  });

  // --- IAM Policies (least-privilege per design 8.2) ---
  describe('IAM Policies — least-privilege', () => {
    test('WorkflowResolver has Cognito AdminGetUser permission', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'cognito-idp:AdminGetUser',
              Effect: 'Allow',
            }),
          ]),
        },
      });
    });

    test('RegistryAgentRecordResolver is granted EXACTLY cognito-idp:AdminGetUser, scoped to the concrete UserPool ARN (not a broader/wildcard grant)', () => {
      // Locate the resolver's own IAM role via its Lambda function properties.
      const functions = template.findResources('AWS::Lambda::Function', {
        Properties: { Handler: 'registry-agent-record-resolver.handler' },
      });
      const fnLogicalId = Object.keys(functions)[0];
      expect(fnLogicalId).toBeDefined();
      const roleRef = functions[fnLogicalId].Properties.Role;
      // Role is always `{ 'Fn::GetAtt': [ '<RoleLogicalId>', 'Arn' ] }`.
      const roleLogicalId = roleRef?.['Fn::GetAtt']?.[0];
      expect(roleLogicalId).toBeDefined();

      // Find the IAM::Policy attached to that exact role that grants
      // cognito-idp:AdminGetUser, and assert the statement is scoped to a
      // single resource referencing the UserPool construct's Arn — never a
      // wildcard ('*') and never bundled with a broader/unscoped action
      // (e.g. ListUsers) in the same statement.
      const policies = template.findResources('AWS::IAM::Policy');
      const matchingStatements = Object.values(policies).flatMap((p: any) => {
        const roles = p.Properties?.Roles || [];
        const attachedToResolver = roles.some((r: any) => r?.Ref === roleLogicalId);
        if (!attachedToResolver) return [];
        const statements = p.Properties?.PolicyDocument?.Statement || [];
        return statements.filter((s: any) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          return actions.includes('cognito-idp:AdminGetUser');
        });
      });

      expect(matchingStatements.length).toBeGreaterThan(0);
      for (const statement of matchingStatements) {
        // Exactly this one action in the statement — not broadened to
        // ListUsers or any other cognito-idp action.
        const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
        expect(actions).toEqual(['cognito-idp:AdminGetUser']);

        const resources = Array.isArray(statement.Resource)
          ? statement.Resource
          : [statement.Resource];
        // Never a bare wildcard.
        expect(resources).not.toContain('*');
        // Scoped to a concrete resource reference (GetAtt/Ref/Fn::Join off
        // the UserPool construct), not a hand-written ARN string that could
        // silently drift from the real pool.
        const isConcreteUserPoolRef = resources.some((r: any) => {
          if (typeof r === 'string') return false; // no literal ARN strings
          const getAttTarget = r?.['Fn::GetAtt']?.[0];
          const joinParts = r?.['Fn::Join']?.[1];
          const joinReferencesUserPool =
            Array.isArray(joinParts) &&
            joinParts.some((part: any) => part?.Ref?.includes('UserPool') || part?.['Fn::GetAtt']?.[0]?.includes('UserPool'));
          return (typeof getAttTarget === 'string' && getAttTarget.includes('UserPool')) || joinReferencesUserPool;
        });
        expect(isConcreteUserPoolRef).toBe(true);
      }
    });

    test('WorkflowProgressFanout has appsync:GraphQL permission for publishWorkflowProgress', () => {
      // Find all IAM policies and check that one grants appsync:GraphQL
      // with a resource referencing publishWorkflowProgress
      const policies = template.findResources('AWS::IAM::Policy');
      const hasAppSyncGraphQLPolicy = Object.values(policies).some((p: any) => {
        const statements = p.Properties?.PolicyDocument?.Statement || [];
        return statements.some((s: any) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          if (!actions.includes('appsync:GraphQL')) return false;
          const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
          return resources.some((r: any) => {
            const joinParts = r?.['Fn::Join']?.[1];
            if (!Array.isArray(joinParts)) return false;
            return joinParts.some(
              (part: any) =>
                typeof part === 'string' &&
                part.includes('/types/Mutation/fields/publishWorkflowProgress')
            );
          });
        });
      });
      expect(hasAppSyncGraphQLPolicy).toBe(true);
    });

    test('WorkflowProgressFanout can PutMetricData for the failure metric', () => {
      const functions = template.findResources('AWS::Lambda::Function', {
        Properties: { Handler: 'workflow-progress-fanout.handler' },
      });
      const fanoutLogicalId = Object.keys(functions)[0];
      expect(fanoutLogicalId).toBeDefined();

      const policies = template.findResources('AWS::IAM::Policy');
      const hasPutMetricData = Object.values(policies).some((p: any) => {
        const roles = p.Properties?.Roles || [];
        const attachedToFanout = roles.some((r: any) =>
          (r?.Ref || '').includes('WorkflowProgressFanout')
        );
        if (!attachedToFanout) return false;
        const statements = p.Properties?.PolicyDocument?.Statement || [];
        return statements.some((s: any) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          return actions.includes('cloudwatch:PutMetricData');
        });
      });
      expect(hasPutMetricData).toBe(true);
    });

    test('an alarm watches the Citadel/Workflows FanoutPublishFailure metric', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        Namespace: 'Citadel/Workflows',
        MetricName: 'FanoutPublishFailure',
      });
    });

    test('EventBus PutEvents granted to workflow, app, and execution resolvers', () => {
      // There should be multiple IAM policies granting events:PutEvents
      const policies = template.findResources('AWS::IAM::Policy');
      const putEventsPolicies = Object.values(policies).filter((p: any) => {
        const statements = p.Properties?.PolicyDocument?.Statement || [];
        return statements.some((s: any) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          return actions.includes('events:PutEvents');
        });
      });
      // At least 3 policies for workflow, app, execution resolvers (plus others)
      expect(putEventsPolicies.length).toBeGreaterThanOrEqual(3);
    });

    test('WorkflowResolver has DynamoDB read/write on Apps table (needed for importBlueprint)', () => {
      // The WorkflowResolver Lambda needs UpdateItem on the Apps table to append
      // workflowId during importBlueprint. Verify the WorkflowResolverFunction's
      // service role policy includes write actions (not just read).
      // Find the WorkflowResolverFunction by handler name
      const functions = template.findResources('AWS::Lambda::Function', {
        Properties: { Handler: 'workflow-resolver.handler' },
      });
      const wfResolverLogicalId = Object.keys(functions)[0];
      expect(wfResolverLogicalId).toBeDefined();

      // Find all IAM policies that reference this function's service role
      const policies = template.findResources('AWS::IAM::Policy');
      const wfResolverPolicies = Object.entries(policies).filter(([, p]: [string, any]) => {
        const roles = p.Properties?.Roles || [];
        return roles.some((r: any) => {
          const ref = r?.Ref || '';
          return ref.includes('WorkflowResolver');
        });
      });

      // Check that at least one policy grants DynamoDB write actions
      // AND references the Apps table (via Fn::GetAtt on AppsTable)
      const hasAppsWritePolicy = wfResolverPolicies.some(([, p]: [string, any]) => {
        const statements = p.Properties?.PolicyDocument?.Statement || [];
        return statements.some((s: any) => {
          const actions = Array.isArray(s.Action) ? s.Action : [s.Action];
          if (!actions.includes('dynamodb:UpdateItem')) return false;
          // Check resource references the Apps table
          const resources = Array.isArray(s.Resource) ? s.Resource : [s.Resource];
          return resources.some((r: any) => {
            const getAtt = r?.['Fn::GetAtt'];
            if (Array.isArray(getAtt) && getAtt[0]?.includes('AppsTable')) return true;
            const join = r?.['Fn::Join'];
            if (Array.isArray(join?.[1])) {
              return join[1].some((part: any) => {
                if (typeof part === 'string' && part.includes('AppsTable')) return true;
                const innerGetAtt = part?.['Fn::GetAtt'];
                return Array.isArray(innerGetAtt) && innerGetAtt[0]?.includes('AppsTable');
              });
            }
            return false;
          });
        });
      });
      expect(hasAppsWritePolicy).toBe(true);
    });
  });
});
