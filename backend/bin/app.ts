#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
// (Aspects accessed via cdk.Aspects)
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag';
import { ServicesStack } from '../lib/services-stack';
import { BackendStack } from '../lib/backend-stack';
import { ArbiterStack } from '../lib/arbiter-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { GatewayStack } from '../lib/gateway-stack';
import { GovernanceStack } from '../lib/governance-stack';

const app = new cdk.App();

const environment = process.env.ENVIRONMENT || 'dev';
if (!environment) {
  throw new Error('ENVIRONMENT variable must be set (test, dev, staging, or prod)');
}

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'ap-southeast-2',
};

const stackProps = {
  env,
  environment: environment,
};

// Backend infrastructure stack (deployed first)
const backendStack = new BackendStack(app, `citadel-backend-${environment}`, {
  ...stackProps,
  description: `Backend infrastructure for Citadel - ${environment}`,
});

// Services stack (depends on backend)
const servicesStack = new ServicesStack(app, `citadel-services-${environment}`, {
  ...stackProps,
  description: `Agent services for Citadel - ${environment}`,
  agentEventBus: backendStack.agentEventBus,
  documentBucket: backendStack.documentBucket,
  // Registry handles so the intake runtime can read the factory catalog from
  // the AgentCore Registry (conditionally wired in the stack).
  registryArn: backendStack.registryArn,
  registryId: backendStack.registryId,
});

// Governance stack — AI-Accelerated Modernization Governance.
// Depends on BackendStack for the GraphQL API, event bus, access-logs bucket
// and 6 governance DynamoDB tables. Kept separate from BackendStack so the
// governance surface (resolvers, KMS, S3, SSM, notifier rule) can be
// redeployed without cycling the data plane.
const governanceStack = new GovernanceStack(app, `citadel-governance-${environment}`, {
  ...stackProps,
  description: `Governance for Citadel - ${environment}`,
  appSyncApi: backendStack.appSyncApi,
  agentEventBus: backendStack.agentEventBus,
  accessLogsBucket: backendStack.accessLogsBucket,
  adrsTable: backendStack.adrsTable,
  adrReopenAttemptsTable: backendStack.adrReopenAttemptsTable,
  executionSpecificationsTable: backendStack.executionSpecificationsTable,
  interrogationRoundsTable: backendStack.interrogationRoundsTable,
  agentDesignAssessmentsTable: backendStack.agentDesignAssessmentsTable,
  programReviewsTable: backendStack.programReviewsTable,
  projectsTable: backendStack.projectsTable,
});

const arbiterStack = new ArbiterStack(app, `citadel-arbiter-${environment}`, {
  ...stackProps,
  description: `Arbiter infrastructure for Citadel - ${environment}`,
  agentEventBus: backendStack.agentEventBus,
  agentConfigTable: backendStack.agentConfigTable,
  codeBucket: backendStack.codeBucket,
  workflowsTable: backendStack.workflowsTable,
  executionsTable: backendStack.executionsTable,
  fanoutFunction: backendStack.workflowProgressFanoutFunction,
  appSyncEndpoint: backendStack.appSyncApi.graphqlUrl,
  appsTable: backendStack.appsTable,
  // QT3-6: shared read-only access for fabricator + worker
  // dispatch-time spec-status validation.
  executionSpecificationsTable: backendStack.executionSpecificationsTable,
  // forward-compatible wiring for the fabricator's
  // design-assessment precondition gate.
  agentDesignAssessmentsTable: backendStack.agentDesignAssessmentsTable,
  registryArn: backendStack.registryArn,
  registryId: backendStack.registryId,
  // Governance UI Wave 1: the new governance-ui-resolver lives in
  // ArbiterStack (next to the ledger table) and attaches to BackendStack's
  // GraphQL API via the L1 CfnDataSource cross-stack pattern. Passing the
  // API + user pool ARN here keeps that wiring centralised in app.ts.
  appSyncApi: backendStack.appSyncApi,
  userPoolArn: backendStack.userPool.userPoolArn,
})

// Frontend hosting stack
const frontendStack = new FrontendStack(app, `citadel-frontend-${environment}`, {
  ...stackProps,
  description: `Frontend hosting infrastructure - ${environment}`,
  appSyncApi: backendStack.appSyncApi,
  userPool: backendStack.userPool,
  userPoolClient: backendStack.userPoolClient,
  agentEventBus: backendStack.agentEventBus,
});

// Gateway stack (depends on backend — receives shared resources)
const gatewayStack = new GatewayStack(app, `citadel-gateway-${environment}`, {
  ...stackProps,
  description: `App Publishing Gateway for Citadel - ${environment}`,
  appsTable: backendStack.appsTable,
  eventBus: backendStack.agentEventBus,
  idempotencyTable: backendStack.idempotencyTable,
});

// Add dependencies
servicesStack.addDependency(backendStack);
governanceStack.addDependency(backendStack);
arbiterStack.addDependency(servicesStack);
frontendStack.addDependency(arbiterStack);
gatewayStack.addDependency(backendStack);

// Wire publish handler from GatewayStack as AppSync data source in BackendStack
// Uses deterministic ARN to avoid circular cross-stack dependency
const publishHandlerArn = `arn:aws:lambda:${env.region}:${env.account}:function:citadel-app-publish-handler-${environment}`;
backendStack.addPublishHandlerResolvers(publishHandlerArn);

// Note: Backend stack will be updated after services stack to get the gateway ID
// This creates a circular dependency that CDK will handle by deploying in two phases

// O-06: Tagging strategy — apply consistent tags across all stacks
cdk.Tags.of(app).add('Project', 'Citadel');
cdk.Tags.of(app).add('Environment', environment);
cdk.Tags.of(app).add('Team', 'platform');
cdk.Tags.of(app).add('CostCenter', 'citadel');
cdk.Tags.of(app).add('ManagedBy', 'cdk');

// cdk-nag: AwsSolutions pack. Errors fail `cdk synth`. Escape hatch: -c nag=false
if (app.node.tryGetContext('nag')!== 'false') {
  cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true, reports: true }));

  // Framework-generated constructs (CDK-owned). Scoped to exact paths, not stack-wide.
  const frameworkSuppressions = [
    { id: 'AwsSolutions-IAM4', reason: 'CDK framework Lambda uses AWSLambdaBasicExecutionRole; not controlled by application code.' },
    { id: 'AwsSolutions-IAM5', reason: 'CDK framework Lambda uses wildcards against CloudWatch Logs and CDK asset bucket; not controlled by application code.' },
    { id: 'AwsSolutions-L1', reason: 'CDK framework manages this Lambda runtime version; will update on next CDK bump.' },
  ];
  const frameworkPaths: Array<[cdk.Stack, string]> = [
    [backendStack, `/${backendStack.stackName}/LogRetentionaae0aa3c5b4d4f87b02d85b201efdd8a`],
    [servicesStack, `/${servicesStack.stackName}/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C`],
    [servicesStack, `/${servicesStack.stackName}/BucketNotificationsHandler050a0587b7544547bf325f094a3db834`],
    [servicesStack, `/${servicesStack.stackName}/AWS679f53fac002430cb0da5b7982bd2287`],
    [frontendStack, `/${frontendStack.stackName}/Custom::CDKBucketDeployment8693BB64968944B69AAFB0CC9EB8756C`],
  ];
  for (const [stack, path] of frameworkPaths) {
      NagSuppressions.addResourceSuppressionsByPath(stack, path, frameworkSuppressions, true);
    }

    // Legitimate repeated patterns across app Lambdas. `appliesTo` narrows each
    // suppression so unrelated wildcards still fire. Track-for-followup:
    // AAF-TODO replace AWSLambdaBasicExecutionRole with explicit inline logs
    // policies and narrow grant-generated wildcards.
    const appLambdaSuppressions = [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'AWSLambdaBasicExecutionRole is the documented default for CloudWatch Logs; scope is logs:CreateLogGroup/Stream/PutLogEvents on the function\'s own log group. Tracked: AAF-NAG-IAM4.',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole', 'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSAppSyncPushToCloudWatchLogs'],
      },
      {
        id: 'AwsSolutions-IAM5',
        reason: 'Scoped wildcards required by AWS APIs and CDK patterns: DynamoDB GSI /index/*, CloudWatch Logs, Lambda version wildcards (:*), S3 path prefixes, citadel-scoped Secrets/SSM/IAM/bedrock-agentcore ARNs. Each pattern is narrow; unscoped Resource::* is still flagged. Tracked: AAF-NAG-IAM5.',
        appliesTo: [
          { regex: '/^Resource::<.+\\.Arn>\\/index\\/\\*$/g' },
          { regex: '/^Resource::arn:<AWS::Partition>:logs:.*:.*:log-group:\\/aws\\/lambda\\/\\*.*$/g' },
          { regex: '/^Resource::arn:aws:logs:.*:.*:log-group:\\*.*$/g' },
                    { regex: '/^Resource::<.+\\.Arn>:\\*$/g' },
                    { regex: '/^Resource::arn:aws:lambda:.*:.*:function:.+:\\*$/g' },
                    { regex: '/^Resource::arn:aws:s3:::.+\\/\\*$/g' },
                    { regex: '/^Resource::arn:aws:secretsmanager:.*:.*:secret:\\/citadel\\/.+\\/\\*$/g' },
                    { regex: '/^Resource::arn:aws:ssm:.*:.*:parameter\\/citadel\\/.+\\*$/g' },
                    { regex: '/^Resource::arn:aws:bedrock-agentcore:.*:.*:.+\\/\\*$/g' },
                    { regex: '/^Resource::arn:aws:iam::.*:role\\/citadel-.+\\*$/g' },
                              { regex: '/^Action::s3:(GetBucket|GetObject|List|Abort|DeleteObject|PutObject)\\*$/g' },
                              { regex: '/^Resource::arn:aws:bedrock:.*::foundation-model\\/.+\\*$/g' },
                              { regex: '/^Resource::arn:aws:bedrock:.*:.*:inference-profile\\/\\*$/g' },
                              { regex: '/^Resource::arn:aws:logs:.*:.*:log-group:\\/aws\\/bedrock-agentcore\\/.+.*$/g' },
                              { regex: '/^Resource::arn:aws:secretsmanager:.*:.*:secret:bedrock-agentcore-identity!.+\\*$/g' },
                                        { regex: '/^Resource::<.+\\.Arn>\\/\\*$/g' },
                                        { regex: '/^Resource::arn:aws:bedrock-agentcore:.*:.*:workload-identity-directory\\/.+-\\*$/g' },
                                        { regex: '/^Resource::arn:aws:bedrock-agentcore:.*:.*:credential-provider\\/integration-\\*$/g' },
                                        { regex: '/^Resource::arn:aws:apigateway:.*::\\/apis\\*$/g' },
        ],
      },
    ];
    for (const stack of [backendStack, servicesStack, arbiterStack, frontendStack, gatewayStack, governanceStack]) {
        NagSuppressions.addStackSuppressions(stack, appLambdaSuppressions, true);
      }

      // SMG4 — rotation deferred. Build rotation Lambdas is multi-day work; tracked
      // separately. Both secrets are admin/bootstrap credentials, not user-facing.
      const smg4Suppressions = [{
        id: 'AwsSolutions-SMG4',
        reason: 'Bootstrap/admin secret. Automatic rotation requires a dedicated rotation Lambda. Tracked: AAF-NAG-SMG4-rotation. reviewBy: 2026-10-22.',
      }];
      NagSuppressions.addResourceSuppressionsByPath(backendStack, `/${backendStack.stackName}/AdminPasswordSecret/Resource`, smg4Suppressions);
      NagSuppressions.addResourceSuppressionsByPath(servicesStack, `/${servicesStack.stackName}/GatewayOAuthSecret/Resource`, smg4Suppressions);

      // IAM5 — Cognito smsRole requires sns:Publish on * (any phone number). AWS-documented pattern.
      NagSuppressions.addResourceSuppressionsByPath(backendStack, `/${backendStack.stackName}/UserPool/smsRole/Resource`, [{
          id: 'AwsSolutions-IAM5',
          reason: 'Cognito smsRole must grant sns:Publish on Resource::* to send SMS MFA codes to arbitrary phone numbers. AWS-standard pattern.',
          appliesTo: ['Resource::*'],
        }]);

        // S1 — access logs bucket itself has no logging (avoid recursion).
        const accessLogsSuppression = [{ id: 'AwsSolutions-S1', reason: 'Access logs bucket; enabling its own access logging would recurse.' }];
        NagSuppressions.addResourceSuppressionsByPath(backendStack, `/${backendStack.stackName}/AccessLogsBucket/Resource`, accessLogsSuppression);
        NagSuppressions.addResourceSuppressionsByPath(servicesStack, `/${servicesStack.stackName}/AccessLogsBucket/Resource`, accessLogsSuppression);
        NagSuppressions.addResourceSuppressionsByPath(frontendStack, `/${frontendStack.stackName}/AccessLogsBucket/Resource`, accessLogsSuppression);
          NagSuppressions.addResourceSuppressionsByPath(frontendStack, `/${frontendStack.stackName}/CloudFrontLogsBucket/Resource`, accessLogsSuppression);

          // COG8 — FeaturePlan.PLUS adds ~.05/MAU with ~/mo minimum. Platform is
          // internal-only; ESSENTIALS meets authentication needs. Tracked: AAF-NAG-COG8-plus.
          const cog8Suppression = [{
            id: 'AwsSolutions-COG8',
            reason: 'FeaturePlan.PLUS has material per-MAU cost. Platform is internal; ESSENTIALS sufficient. Revisit if exposed externally. reviewBy: 2026-10-22.',
          }];
          NagSuppressions.addResourceSuppressionsByPath(backendStack, `/${backendStack.stackName}/UserPool/Resource`, cog8Suppression);
          NagSuppressions.addResourceSuppressionsByPath(servicesStack, `/${servicesStack.stackName}/GatewayUserPool/Resource`, cog8Suppression);

            // IAM5 Resource::* — residual after narrowing sts:AssumeRole to citadel-*.
            // sts:GetCallerIdentity and similar account-scoped admin/Bedrock/Cognito/Lambda
            // management actions cannot be resource-scoped per AWS IAM. Each path listed
            // below has been individually reviewed. Tracked: AAF-NAG-IAM5-star. reviewBy: 2026-10-22.
            const resourceStarSuppression = [{
              id: 'AwsSolutions-IAM5',
              reason: 'sts:GetCallerIdentity and similar account-scoped admin actions (Bedrock inference discovery, Cognito listing, Lambda management) have no resource-level support per AWS IAM. sts:AssumeRole narrowed separately.',
              appliesTo: ['Resource::*'],
            }];
            const resourceStarPaths: Array<[cdk.Stack, string]> = [
              [backendStack, 'DocumentUploadResolverFunction/ServiceRole/DefaultPolicy/Resource'],
              [backendStack, 'IntegrationResolverFunction/ServiceRole/DefaultPolicy/Resource'],
              [backendStack, 'AgentMessageHandlerFunction/ServiceRole/DefaultPolicy/Resource'],
              [backendStack, 'DataStoreResolverFunction/ServiceRole/DefaultPolicy/Resource'],
              [servicesStack, 'CognitoSecretHandler/ServiceRole/DefaultPolicy/Resource'],
              [servicesStack, 'HldPdfGenerator/ServiceRole/DefaultPolicy/Resource'],
              [servicesStack, 'HldPdfCreatedNotifierV2/ServiceRole/DefaultPolicy/Resource'],
              [servicesStack, 'HealthMonitorFunction/ServiceRole/DefaultPolicy/Resource'],
              [servicesStack, 'ToolSandboxFunction/ServiceRole/DefaultPolicy/Resource'],
              // Phase 1 server-side ingestion: residual Resource::* is only the
              // un-scopable xray:Put* (tracing ACTIVE) + cloudwatch:PutMetricData
              // (namespace-conditioned to Citadel/DocumentIngestion). All
              // bedrock/dynamodb/events/ssm grants are resource-scoped.
              [servicesStack, 'DocumentIngestStartFunction/ServiceRole/DefaultPolicy/Resource'],
              [servicesStack, 'DocumentIngestPollerFunction/ServiceRole/DefaultPolicy/Resource'],
              [servicesStack, 'AgentIntakeSingleRuntime/ExecutionRole/DefaultPolicy/Resource'],
              [arbiterStack, 'AgentCredentialVender/ServiceRole/DefaultPolicy/Resource'],
              [arbiterStack, 'WorkerAgentWrapper/ServiceRole/DefaultPolicy/Resource'],
              [frontendStack, 'UpdateEmailTemplatesFunction/ServiceRole/DefaultPolicy/Resource'],
              [gatewayStack, 'AppPublishHandler/ServiceRole/DefaultPolicy/Resource'],
              [backendStack, 'RegistryProvisionerFunction/ServiceRole/DefaultPolicy/Resource'],
              [backendStack, 'RegistryAgentRecordResolverFunction/ServiceRole/DefaultPolicy/Resource'],
            ];
            for (const [stack, path] of resourceStarPaths) {
                NagSuppressions.addResourceSuppressionsByPath(stack, `/${stack.stackName}/${path}`, resourceStarSuppression);
              }

              // IAM5 — US-IMP lazy trust-path. The agent-config-resolver performs
              // READ-ONLY IAM introspection of an imported agent's operator-supplied
              // invocation.roleArn during activation. That role is not citadel-prefixed
              // (and may be cross-account), so the grants are scoped to THIS account's
              // role/* and policy/* IAM namespace (account-scoped, never bare Resource::*).
              NagSuppressions.addResourceSuppressionsByPath(
                backendStack,
                `/${backendStack.stackName}/AgentConfigResolverFunction/ServiceRole/DefaultPolicy/Resource`,
                [{
                  id: 'AwsSolutions-IAM5',
                  reason:
                    'Lazy trust-path activation issues read-only IAM introspection ' +
                    '(iam:GetRole/GetRolePolicy/ListRolePolicies/ListAttachedRolePolicies/' +
                    'GetPolicy/GetPolicyVersion) on an imported agent\'s operator-supplied ' +
                    'invocation.roleArn, which is not citadel-prefixed. Scoped to this ' +
                    'account\'s role/* and policy/* namespace (account-scoped, not bare *); ' +
                    'no write or assume granted. Tracked: AAF-NAG-IAM5-trustpath.',
                  appliesTo: [
                    { regex: '/^Resource::arn:aws:iam::.*:role\\/\\*$/g' },
                    { regex: '/^Resource::arn:aws:iam::.*:policy\\/\\*$/g' },
                  ],
                }],
              );

              // CloudFront — partial hardening. TLS 1.2 and access logging applied; the
              // rest require follow-up work.
              NagSuppressions.addResourceSuppressionsByPath(frontendStack, `/${frontendStack.stackName}/FrontendDistribution`, [
                              { id: 'AwsSolutions-CFR1', reason: 'Geo restrictions not required; platform is internal enterprise. Tracked: AAF-NAG-CFR1. reviewBy: 2026-10-22.' },
                              { id: 'AwsSolutions-CFR2', reason: 'WAFv2 WebACL for CloudFront must be deployed to us-east-1; current stack deploys to ap-southeast-2. Cross-region WAF deployment tracked: AAF-NAG-CFR2. reviewBy: 2026-07-22.' },
                              { id: 'AwsSolutions-CFR4', reason: 'Uses CloudFront default *.cloudfront.net certificate which pins to TLSv1 regardless of minimumProtocolVersion. Clearing requires an ACM cert + custom domain (DNS decision). minimumProtocolVersion already set to TLSv1.2_2021 so a custom cert will take effect when attached. Tracked: AAF-NAG-CFR4. reviewBy: 2026-10-22.' },
                              { id: 'AwsSolutions-CFR7', reason: 'Distribution uses OAI (legacy); migration to OAC requires CfnDistribution refactor and S3 bucket policy update. Tracked: AAF-NAG-CFR7. reviewBy: 2026-07-22.' },
                            ]);

              // SQS3 — RegistrySyncDLQ is itself a dead-letter queue; adding a DLQ to a DLQ is unnecessary.
              NagSuppressions.addResourceSuppressionsByPath(backendStack, `/${backendStack.stackName}/RegistrySyncDLQ/Resource`, [{
                id: 'AwsSolutions-SQS3',
                reason: 'RegistrySyncDLQ is itself a dead-letter queue for the RegistrySyncLambda event source. Adding a DLQ to a DLQ is unnecessary.',
              }]);

              // IAM5 — RegistryProvisionerFunction needs SLR wildcard for bedrock-agentcore service-linked role creation.
              NagSuppressions.addResourceSuppressionsByPath(backendStack, `/${backendStack.stackName}/RegistryProvisionerFunction/ServiceRole/DefaultPolicy/Resource`, [{
                id: 'AwsSolutions-IAM5',
                reason: 'iam:CreateServiceLinkedRole requires wildcard on the SLR path. Scoped to bedrock-agentcore.amazonaws.com service only.',
                appliesTo: ['Resource::arn:aws:iam::*:role/aws-service-role/bedrock-agentcore.amazonaws.com/*'],
              }]);

              // IAM5 — Registry ARN wildcards for AgentCore registry CRUD operations.
              const registryArnSuppression = [{
                id: 'AwsSolutions-IAM5',
                reason: 'AgentCore registry operations require wildcard on registry ARN sub-resources (agents, tools, versions). Scoped to the specific registry ARN.',
                appliesTo: [
                  { regex: '/^Resource::<AgentCoreRegistry\\.RegistryArn>\\/\\*$/g' },
                ],
              }];
              const registryArnPaths: Array<[cdk.Stack, string]> = [
                [backendStack, 'RegistrySyncLambda/ServiceRole/DefaultPolicy/Resource'],
                [backendStack, 'AgentConfigResolverFunction/ServiceRole/DefaultPolicy/Resource'],
                [backendStack, 'AgentImportResolverFunction/ServiceRole/DefaultPolicy/Resource'],
                [backendStack, 'ToolConfigResolverFunction/ServiceRole/DefaultPolicy/Resource'],
                [arbiterStack, 'FabricatorAgent/ServiceRole/DefaultPolicy/Resource'],
                [arbiterStack, 'SupervisorAgent/ServiceRole/DefaultPolicy/Resource'],
                [arbiterStack, 'WorkerAgentWrapper/ServiceRole/DefaultPolicy/Resource'],
                [arbiterStack, 'GovernanceUiResolverFn/ServiceRole/DefaultPolicy/Resource'],
                [backendStack, 'RegistryAgentRecordResolverFunction/ServiceRole/DefaultPolicy/Resource'],
                [backendStack, 'ReconcileAppsMetaScheduledFunction/ServiceRole/DefaultPolicy/Resource'],
                [servicesStack, 'AgentIntakeSingleRuntime/ExecutionRole/DefaultPolicy/Resource'],
              ];
              for (const [stack, path] of registryArnPaths) {
                NagSuppressions.addResourceSuppressionsByPath(stack, `/${stack.stackName}/${path}`, registryArnSuppression);
              }

              // IAM5 — AgentImportResolverFunction discovery policy
              // (buildImportDiscoveryPolicy) grants read-only List/Describe/Get
              // across the phase-1 substrates with Resource '*', which those
              // List/Describe APIs do not support resource-level scoping for.
              // Additive to the registry-ARN suppression already registered for
              // this role above.
              NagSuppressions.addResourceSuppressionsByPath(
                backendStack,
                `/${backendStack.stackName}/AgentImportResolverFunction/ServiceRole/DefaultPolicy/Resource`,
                [{
                  id: 'AwsSolutions-IAM5',
                  reason: 'read-only discovery list/describe requires * resource',
                  appliesTo: ['Resource::*'],
                }],
              );
}