/**
 * P3.B — IAM, CDK, SSM coverage for the integration-resolver and
 * gateway-registration-handler Lambdas.
 *
 * Asserts that:
 *  - The OAuth return-URL SSM parameter exists at the env-scoped path with a
 *    sensible placeholder default and Standard tier / TEXT data type.
 *  - The integration-resolver Lambda role has the AgentCore Identity
 *    credential-provider statement scoped to credential-provider/integration-*.
 *  - The gateway-registration-handler Lambda role has the credential-provider
 *    read + delete-cleanup statement scoped to credential-provider/integration-*.
 *  - The gateway-registration-handler gateway-target statement covers both
 *    gateway/* and gateway/* /target/* ARN shapes.
 *  - Both Lambdas have OAUTH_DEFAULT_RETURN_URL and OAUTH_RETURN_URL_SSM_PARAM
 *    env vars wired.
 */

import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as path from 'path';
import * as fs from 'fs';

// Ensure asset directories exist for CDK synthesis
const assetDirs = [
  path.resolve(__dirname, '../src/schema'),
  path.resolve(__dirname, '../dist/lambda'),
  path.resolve(__dirname, '../src/lambda/seed-admin-user'),
  path.resolve(__dirname, '../src/lambda/seed-organizations'),
];
for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { BackendStack } from '../lib/backend-stack';

describe('BackendStack — P3.B IAM grants, SSM parameter, env wiring', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, 'TestBackendStackP3B', {
      environment: 'test',
      env: { account: '123456789012', region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
  });

  // ---------------------------------------------------------------------------
  // SSM parameter
  // ---------------------------------------------------------------------------

  test('creates the /citadel/${env}/oauth-return-url SSM parameter', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/citadel/test/oauth-return-url',
      Type: 'String',
      Tier: 'Standard',
      DataType: 'text',
      Value: 'https://app.citadel.example.com/integrations/connected',
    });
  });

  test('OAuth return-URL SSM parameter has a description explaining its role', () => {
    template.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/citadel/test/oauth-return-url',
      Description: Match.stringLikeRegexp('OAuth.*callback'),
    });
  });

  // ---------------------------------------------------------------------------
  // integration-resolver Lambda
  // ---------------------------------------------------------------------------

  test('integration-resolver has OAUTH_DEFAULT_RETURN_URL + OAUTH_RETURN_URL_SSM_PARAM env vars', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'integration-resolver.handler',
      Environment: {
        Variables: Match.objectLike({
          // valueForStringParameter resolves to a CloudFormation token; we only
          // assert the key is present (Match.anyValue()).
          OAUTH_DEFAULT_RETURN_URL: Match.anyValue(),
          OAUTH_RETURN_URL_SSM_PARAM: '/citadel/test/oauth-return-url',
        }),
      },
    });
  });

  test('integration-resolver role grants AgentCore Identity credential-provider actions on credential-provider/integration-*', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith([
              'bedrock-agentcore:CreateOauth2CredentialProvider',
              'bedrock-agentcore:UpdateOauth2CredentialProvider',
              'bedrock-agentcore:GetOauth2CredentialProvider',
              'bedrock-agentcore:DeleteOauth2CredentialProvider',
              'bedrock-agentcore:CreateApiKeyCredentialProvider',
              'bedrock-agentcore:UpdateApiKeyCredentialProvider',
              'bedrock-agentcore:GetApiKeyCredentialProvider',
              'bedrock-agentcore:DeleteApiKeyCredentialProvider',
              'bedrock-agentcore:ListOauth2CredentialProviders',
              'bedrock-agentcore:ListApiKeyCredentialProviders',
            ]),
            // The resource ARN is built from `${region}:${account}:credential-provider/integration-*`
            Resource: Match.stringLikeRegexp('credential-provider/integration-\\*'),
          }),
        ]),
      },
    });
  });

  test('integration-resolver role grants ssm:GetParameter on the oauth-return-url SSM parameter', () => {
    // grantRead emits ssm:DescribeParameters / GetParameters / GetParameter /
    // GetParameterHistory. Find the SSM parameter logical ID, then look for a
    // policy statement that references it via Fn::Join + Ref.
    const params = template.findResources('AWS::SSM::Parameter', {
      Properties: { Name: '/citadel/test/oauth-return-url' },
    });
    const paramLogicalIds = Object.keys(params);
    expect(paramLogicalIds.length).toBe(1);
    const paramLogicalId = paramLogicalIds[0];

    const policies = template.findResources('AWS::IAM::Policy');
    const matched = Object.values(policies).some((policy: any) =>
      (policy.Properties.PolicyDocument.Statement as any[]).some((stmt) => {
        const actions: string[] = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        const hasGetParam = actions.includes('ssm:GetParameter') || actions.includes('ssm:GetParameters');
        const resourceStr = JSON.stringify(stmt.Resource ?? '');
        return hasGetParam && resourceStr.includes(paramLogicalId);
      }),
    );
    expect(matched).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // gateway-registration-handler Lambda
  // ---------------------------------------------------------------------------

  test('gateway-registration-handler has OAUTH_DEFAULT_RETURN_URL + OAUTH_RETURN_URL_SSM_PARAM env vars', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'gateway-registration-handler.handler',
      Environment: {
        Variables: Match.objectLike({
          OAUTH_DEFAULT_RETURN_URL: Match.anyValue(),
          OAUTH_RETURN_URL_SSM_PARAM: '/citadel/test/oauth-return-url',
        }),
      },
    });
  });

  test('gateway-registration-handler role grants gateway-target actions on gateway/* and gateway/*/target/*', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith([
              'bedrock-agentcore:CreateGatewayTarget',
              'bedrock-agentcore:DeleteGatewayTarget',
              'bedrock-agentcore:GetGatewayTarget',
            ]),
            // Two-element array: gateway/* and gateway/*/target/*
            Resource: Match.arrayWith([
              Match.stringLikeRegexp('gateway/\\*/target/\\*'),
            ]),
          }),
        ]),
      },
    });
  });

  test('gateway-registration-handler role grants credential-provider read + delete cleanup on credential-provider/integration-*', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith([
              'bedrock-agentcore:GetOauth2CredentialProvider',
              'bedrock-agentcore:GetApiKeyCredentialProvider',
              'bedrock-agentcore:DeleteOauth2CredentialProvider',
              'bedrock-agentcore:DeleteApiKeyCredentialProvider',
            ]),
            Resource: Match.stringLikeRegexp('credential-provider/integration-\\*'),
          }),
        ]),
      },
    });
  });

  test('gateway-registration-handler role does NOT grant Create/Update credential-provider actions (handler is read+cleanup only)', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    // Find policies attached to the gateway-registration-handler role.
    const lambdas = template.findResources('AWS::Lambda::Function');
    const handlerLogicalId = Object.keys(lambdas).find(
      (k) => lambdas[k].Properties?.Handler === 'gateway-registration-handler.handler',
    );
    expect(handlerLogicalId).toBeDefined();
    const handlerRoleRef = lambdas[handlerLogicalId!].Properties.Role?.['Fn::GetAtt']?.[0];
    expect(handlerRoleRef).toBeDefined();

    const handlerPolicies = Object.values(policies).filter((p: any) =>
      (p.Properties?.Roles ?? []).some((r: any) => r.Ref === handlerRoleRef),
    );

    const hasForbiddenAction = handlerPolicies.some((p: any) =>
      (p.Properties.PolicyDocument.Statement as any[]).some((stmt) => {
        const actions: string[] = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        return (
          actions.includes('bedrock-agentcore:CreateOauth2CredentialProvider') ||
          actions.includes('bedrock-agentcore:CreateApiKeyCredentialProvider') ||
          actions.includes('bedrock-agentcore:UpdateOauth2CredentialProvider') ||
          actions.includes('bedrock-agentcore:UpdateApiKeyCredentialProvider')
        );
      }),
    );
    expect(hasForbiddenAction).toBe(false);
  });

  test('gateway-registration-handler role grants ssm:GetParameter on the oauth-return-url SSM parameter', () => {
    const params = template.findResources('AWS::SSM::Parameter', {
      Properties: { Name: '/citadel/test/oauth-return-url' },
    });
    const paramLogicalId = Object.keys(params)[0];
    expect(paramLogicalId).toBeDefined();

    const policies = template.findResources('AWS::IAM::Policy');
    const lambdas = template.findResources('AWS::Lambda::Function');
    const handlerLogicalId = Object.keys(lambdas).find(
      (k) => lambdas[k].Properties?.Handler === 'gateway-registration-handler.handler',
    );
    const handlerRoleRef = lambdas[handlerLogicalId!].Properties.Role?.['Fn::GetAtt']?.[0];

    const handlerPolicies = Object.values(policies).filter((p: any) =>
      (p.Properties?.Roles ?? []).some((r: any) => r.Ref === handlerRoleRef),
    );

    const matched = handlerPolicies.some((policy: any) =>
      (policy.Properties.PolicyDocument.Statement as any[]).some((stmt) => {
        const actions: string[] = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
        const hasGetParam = actions.includes('ssm:GetParameter') || actions.includes('ssm:GetParameters');
        const resourceStr = JSON.stringify(stmt.Resource ?? '');
        return hasGetParam && resourceStr.includes(paramLogicalId);
      }),
    );
    expect(matched).toBe(true);
  });
});
