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

  // --- AppResolverFunction ---
  describe('AppResolverFunction', () => {
    test('exists with Node.js 24.x runtime, 30s timeout, and correct env vars', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Handler: 'app-resolver.handler',
        Runtime: 'nodejs24.x',
        Timeout: 30,
        Environment: {
          Variables: Match.objectLike({
            APPS_TABLE: Match.anyValue(),
            WORKFLOWS_TABLE: Match.anyValue(),
            EVENT_BUS_NAME: Match.anyValue(),
            USER_POOL_ID: Match.anyValue(),
          }),
        },
      });
    });

    test('has X-Ray active tracing enabled', () => {
      const functions = template.findResources('AWS::Lambda::Function', {
        Properties: { Handler: 'app-resolver.handler' },
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

    test('AppLambdaDataSource exists', () => {
      template.hasResourceProperties('AWS::AppSync::DataSource', {
        Type: 'AWS_LAMBDA',
        Name: 'AppLambdaDataSource',
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
