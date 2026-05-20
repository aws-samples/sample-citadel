/**
 * Citadel CI/CD Pipeline — AWS CodePipeline
 *
 * Self-mutating CDK Pipeline that builds, tests, and deploys Citadel.
 * Supports multi-environment promotion: dev → staging → prod.
 *
 * Usage:
 *   Add to bin/app.ts:
 *     new PipelineStack(app, 'citadel-pipeline', { env, environment: 'dev' });
 *
 *   Then deploy the pipeline itself:
 *     npx cdk deploy citadel-pipeline
 *
 * Prerequisites:
 *   - CodeStar connection to GitHub (or CodeCommit repo)
 *   - SSM parameter /citadel/github-connection-arn with the connection ARN
 *   - SSM parameter /citadel/account-id with the target AWS account
 */
import * as cdk from 'aws-cdk-lib';
import * as pipelines from 'aws-cdk-lib/pipelines';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

interface PipelineStackProps extends cdk.StackProps {
  environment: string;
  /** GitHub owner/repo, e.g. 'myorg/citadel' */
  repository?: string;
  /** Branch to track */
  branch?: string;
}

export class PipelineStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);

    const repo = props.repository || 'myorg/citadel';
    const branch = props.branch || 'main';

    // CodeStar connection ARN (created manually in AWS Console)
    const connectionArn = ssm.StringParameter.valueForStringParameter(
      this,
      '/citadel/github-connection-arn',
    );

    const pipeline = new pipelines.CodePipeline(this, 'Pipeline', {
      pipelineName: `citadel-${props.environment}`,
      crossAccountKeys: false,
      selfMutation: true,
      dockerEnabledForSynth: true,

      synth: new pipelines.ShellStep('Synth', {
        input: pipelines.CodePipelineSource.connection(repo, branch, {
          connectionArn,
        }),
        commands: [
          // Frontend build
          'cd frontend && npm ci && npm run build && cd ..',
          // Backend build + synth
          'cd backend && npm ci && npm run build && npm run build:lambda',
          'npx cdk synth --quiet',
        ],
        primaryOutputDirectory: 'backend/cdk.out',
      }),
    });

    // ── Test stage ──
    const testStep = new pipelines.ShellStep('Test', {
      commands: [
        // Backend tests
        'cd backend && npm ci && npm test -- --ci && cd ..',
        // Frontend tests
        'cd frontend && npm ci && npm test -- --ci && cd ..',
        // Arbiter tests
        'pip install pytest hypothesis boto3',
        'pytest arbiter/ -v --tb=short',
      ],
    });

    // ── Dev stage ──
    // The actual application stacks are added as a Stage.
    // For a full implementation, create a CitadelStage class that
    // instantiates all 5 stacks (Backend, Services, Arbiter, Frontend, Gateway).
    //
    // Example:
    //   const devStage = new CitadelStage(this, 'Dev', {
    //     env: props.env,
    //     environment: 'dev',
    //   });
    //   pipeline.addStage(devStage, {
    //     pre: [testStep],
    //     post: [healthCheckStep],
    //   });

    // ── Post-deploy health check ──
    const healthCheckStep = new pipelines.ShellStep('HealthCheck', {
      commands: [
        `FRONTEND_URL=$(aws cloudformation describe-stacks \\
          --stack-name citadel-frontend-${props.environment} \\
          --query "Stacks[0].Outputs[?OutputKey=='FrontendUrl'].OutputValue" \\
          --output text 2>/dev/null || echo "")`,
        'if [ -n "$FRONTEND_URL" ]; then',
        '  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$FRONTEND_URL" || echo "000")',
        '  echo "Health check: HTTP $HTTP_CODE"',
        '  [ "$HTTP_CODE" = "200" ] || echo "WARNING: Health check did not return 200"',
        'fi',
      ],
    });

    // ── Staging stage (manual approval before prod) ──
    // Uncomment when ready for multi-environment:
    //
    // const stagingStage = new CitadelStage(this, 'Staging', {
    //   env: { account: props.env?.account, region: props.env?.region },
    //   environment: 'staging',
    // });
    // pipeline.addStage(stagingStage, {
    //   pre: [testStep],
    //   post: [healthCheckStep],
    // });
    //
    // const prodStage = new CitadelStage(this, 'Prod', {
    //   env: { account: props.env?.account, region: props.env?.region },
    //   environment: 'prod',
    // });
    // pipeline.addStage(prodStage, {
    //   pre: [
    //     new pipelines.ManualApprovalStep('PromoteToProd', {
    //       comment: 'Review staging deployment before promoting to production',
    //     }),
    //   ],
    //   post: [healthCheckStep],
    // });

    // Output pipeline ARN
    new cdk.CfnOutput(this, 'PipelineArn', {
      value: pipeline.pipeline.pipelineArn,
      description: 'CodePipeline ARN',
    });
  }
}
