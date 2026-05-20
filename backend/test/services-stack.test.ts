import * as cdk from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as path from 'path';
import * as fs from 'fs';

// Ensure asset directories exist for CDK synthesis
const assetDirs = [
  path.resolve(__dirname, '../../src/schema'),
  path.resolve(__dirname, '../../src/lambda/cognito-secret-handler'),
  path.resolve(__dirname, '../../../service/hld_pdf_generator'),
  path.resolve(__dirname, '../../../service/agent_intake_single'),
];
for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Ensure Dockerfiles exist for DockerImageFunction constructs
const dockerStub = 'FROM public.ecr.aws/lambda/python:3.12\nCMD ["handler.handler"]\n';
for (const dockerDir of [
  path.resolve(__dirname, '../../../service/hld_pdf_generator'),
  path.resolve(__dirname, '../../../service/agent_intake_single'),
]) {
  const df = path.join(dockerDir, 'Dockerfile');
  if (!fs.existsSync(df)) fs.writeFileSync(df, dockerStub);
}

import { ServicesStack } from '../lib/services-stack';

describe('ServicesStack', () => {
  let app: cdk.App;
  let stack: ServicesStack;
  let template: cdk.assertions.Template;

  beforeAll(() => {
    app = new cdk.App();

    const prereqStack = new cdk.Stack(app, 'PrereqStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const agentEventBus = new events.EventBus(prereqStack, 'TestEventBus', {
      eventBusName: 'test-bus',
    });
    const documentBucket = new s3.Bucket(prereqStack, 'TestDocBucket');

    stack = new ServicesStack(app, 'TestServicesStack', {
      environment: 'test',
      agentEventBus,
      documentBucket,
      env: { account: '123456789012', region: 'us-east-1' },
    });

    template = cdk.assertions.Template.fromStack(stack);
  });

  test('stack synthesizes without errors', () => {
    expect(template).toBeDefined();
  });

  test('has no duplicate Construct imports (compiles successfully)', () => {
    expect(stack).toBeInstanceOf(ServicesStack);
  });

  test('creates OpenSearch Serverless collection for KB', () => {
    template.hasResourceProperties('AWS::OpenSearchServerless::Collection', {
      Name: 'citadel-kb-test',
      Type: 'VECTORSEARCH',
    });
  });

  test('creates OpenSearch Serverless encryption policy', () => {
    template.hasResourceProperties('AWS::OpenSearchServerless::SecurityPolicy', {
      Type: 'encryption',
    });
  });

  test('creates OpenSearch Serverless network policy', () => {
    template.hasResourceProperties('AWS::OpenSearchServerless::SecurityPolicy', {
      Type: 'network',
    });
  });

  test('creates PDF notifier Lambda function', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'pdf-created-notifier.handler',
    });
  });

  test('creates session memory DynamoDB table', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'citadel-session-memory-test',
    });
  });

  test('creates session S3 bucket with lifecycle rules', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: [
          {
            Id: 'DeleteOldSessions',
            Status: 'Enabled',
            ExpirationInDays: 90,
          },
        ],
      },
    });
  });

  test('creates Bedrock Knowledge Base', () => {
    template.hasResourceProperties('AWS::Bedrock::KnowledgeBase', {
      Name: 'citadel-kb-sessions-test',
    });
  });

  test('creates Gateway Cognito User Pool', () => {
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'citadel-gateway-test',
    });
  });

  test('does not reference undefined agent1Runtime', () => {
    // The agent1Parameter SSM block was removed since agent1Runtime was undefined.
    // Verify no SSM parameter references agent1 in its name.
    const ssmParams = template.findResources('AWS::SSM::Parameter');
    const agent1Params = Object.entries(ssmParams).filter(([_, r]: [string, any]) => {
      const name = r.Properties?.Name;
      return typeof name === 'string' && name.includes('agent1');
    });
    expect(agent1Params).toHaveLength(0);
  });

  test('DynamoDB tables use pointInTimeRecoverySpecification instead of deprecated pointInTimeRecovery', () => {
    // Verify no deprecation warnings are emitted during synthesis.
    // The deprecated pointInTimeRecovery: true triggers a console.warn.
    const warnSpy = jest.spyOn(console, 'warn');
    
    // Re-synthesize to capture warnings
    const testApp = new cdk.App();
    const prereq = new cdk.Stack(testApp, 'DeprecPrereq', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const bus = new events.EventBus(prereq, 'Bus');
    const bucket = new s3.Bucket(prereq, 'Bucket');
    
    new ServicesStack(testApp, 'DeprecTestStack', {
      environment: 'test',
      agentEventBus: bus,
      documentBucket: bucket,
      env: { account: '123456789012', region: 'us-east-1' },
    });
    
    const warnings = warnSpy.mock.calls
      .map(call => call.join(' '))
      .filter(msg => msg.includes('pointInTimeRecovery is deprecated'));
    
    warnSpy.mockRestore();
    expect(warnings).toHaveLength(0);
  });

  test('no Lambda functions use deprecated logRetention property', () => {
    // When logGroup is used instead of logRetention, CDK creates a separate
    // AWS::Logs::LogGroup resource rather than a Custom::LogRetention resource.
    const customLogRetention = template.findResources('Custom::LogRetention');
    expect(Object.keys(customLogRetention)).toHaveLength(0);
  });
});
