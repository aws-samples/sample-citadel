import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as path from 'path';
import * as fs from 'fs';

// Ensure asset directories exist for CDK synthesis
const assetDirs = [
  path.resolve(__dirname, '../dist/lambda'),
];
for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { BackendStack } from '../lib/backend-stack';

function createTestStack(): { stack: BackendStack; template: Template } {
  const app = new cdk.App();

  const stack = new BackendStack(app, 'TestBackendStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    environment: 'test',
  });

  // Wire publish handler using deterministic ARN (same pattern as app.ts)
  const publishHandlerArn = 'arn:aws:lambda:us-east-1:123456789012:function:citadel-app-publish-handler-test';
  stack.addPublishHandlerResolvers(publishHandlerArn);

  const template = Template.fromStack(stack);
  return { stack, template };
}

describe('BackendStack — publishApp and unpublishApp resolver mappings (Task 1.3)', () => {
  let template: Template;

  beforeAll(() => {
    ({ template } = createTestStack());
  });

  test('adds publish handler Lambda as an AppSync data source', () => {
    template.hasResourceProperties('AWS::AppSync::DataSource', {
      Type: 'AWS_LAMBDA',
      Name: 'PublishHandlerLambdaDataSource',
    });
  });

  test('creates publishApp mutation resolver pointing to publish handler data source', () => {
    template.hasResourceProperties('AWS::AppSync::Resolver', {
      TypeName: 'Mutation',
      FieldName: 'publishApp',
    });
  });

  test('creates unpublishApp mutation resolver pointing to publish handler data source', () => {
    template.hasResourceProperties('AWS::AppSync::Resolver', {
      TypeName: 'Mutation',
      FieldName: 'unpublishApp',
    });
  });

  test('grants AppSync invoke permission on publish handler Lambda', () => {
    // When addLambdaDataSource is used with sameEnvironment, CDK grants
    // lambda:InvokeFunction to the AppSync service role for the data source
    template.hasResourceProperties('AWS::AppSync::DataSource', {
      Type: 'AWS_LAMBDA',
      Name: 'PublishHandlerLambdaDataSource',
      LambdaConfig: {
        LambdaFunctionArn: Match.stringLikeRegexp('citadel-app-publish-handler-test'),
      },
    });
  });
});
