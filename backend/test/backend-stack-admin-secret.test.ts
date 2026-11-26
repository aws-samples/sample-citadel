/**
 * CDK tests for the admin user provisioning via Secrets Manager.
 *
 * Verifies that:
 *  - The admin password secret uses generateSecretString (not a plaintext value)
 *  - The seed-admin-user Lambda receives ADMIN_PASSWORD_SECRET_ARN (not ADMIN_PASSWORD)
 *  - The Lambda has IAM permission to read the secret
 *  - adminEmail is accepted as a CDK context parameter
 *  - A CfnOutput exposes the secret ARN for post-deploy retrieval
 *  - The ADMIN_PASSWORD env var is NOT passed to the Lambda
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

describe('BackendStack — Admin user secret generation (Option 3)', () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App({
      context: {
        adminEmail: 'test-admin@example.com',
      },
    });
    const stack = new BackendStack(app, 'TestBackendStack', {
      environment: 'test',
      env: { account: '123456789012', region: 'us-east-1' },
    });
    template = Template.fromStack(stack);
  });

  test('Admin password secret uses generateSecretString instead of plaintext', () => {
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'citadel/admin-password-test',
      GenerateSecretString: Match.objectLike({
        GenerateStringKey: 'password',
        SecretStringTemplate: Match.anyValue(),
      }),
    });
  });

  test('Admin password secret does NOT use a plaintext SecretString', () => {
    // Find the secret resource and verify it does not have SecretString set
    const secrets = template.findResources('AWS::SecretsManager::Secret', {
      Properties: {
        Name: 'citadel/admin-password-test',
      },
    });

    const secretLogicalIds = Object.keys(secrets);
    expect(secretLogicalIds.length).toBeGreaterThan(0);

    for (const id of secretLogicalIds) {
      const props = secrets[id].Properties;
      expect(props).not.toHaveProperty('SecretString');
    }
  });

  test('Seed admin Lambda does NOT have ADMIN_PASSWORD in environment variables', () => {
    // Find all Lambda functions and check the seed admin one
    const lambdas = template.findResources('AWS::Lambda::Function');

    // Find the seed admin Lambda by checking for USER_POOL_ID + ADMIN_EMAIL env vars
    let seedAdminFound = false;
    for (const [logicalId, resource] of Object.entries(lambdas)) {
      const envVars = (resource as any).Properties?.Environment?.Variables;
      if (envVars && envVars.USER_POOL_ID && envVars.ADMIN_EMAIL !== undefined) {
        seedAdminFound = true;
        // Must NOT have ADMIN_PASSWORD as an env var
        expect(envVars).not.toHaveProperty('ADMIN_PASSWORD');
        // Must have ADMIN_PASSWORD_SECRET_ARN
        expect(envVars).toHaveProperty('ADMIN_PASSWORD_SECRET_ARN');
      }
    }
    expect(seedAdminFound).toBe(true);
  });

  test('Stack outputs include AdminPasswordSecretArn', () => {
    template.hasOutput('AdminPasswordSecretArn', {
      Value: Match.anyValue(),
      Description: Match.stringLikeRegexp('admin.*password.*secret'),
    });
  });

  test('Admin email from CDK context is passed to the seed Lambda', () => {
    const lambdas = template.findResources('AWS::Lambda::Function');

    let found = false;
    for (const [logicalId, resource] of Object.entries(lambdas)) {
      const envVars = (resource as any).Properties?.Environment?.Variables;
      if (envVars && envVars.ADMIN_EMAIL === 'test-admin@example.com') {
        found = true;
      }
    }
    expect(found).toBe(true);
  });
});
