/**
 * TDD Tests for Generalized PolicyManager
 *
 * The PolicyManager should work for datastores, integrations, and agents.
 * It manages IAM roles with scoped permissions.
 */

import { IAMClient, CreateRoleCommand, PutRolePolicyCommand, DeleteRolePolicyCommand, DeleteRoleCommand } from '@aws-sdk/client-iam';
import { STSClient, GetCallerIdentityCommand, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import { PolicyManager, PolicyScope } from '../../utils/policy-manager';

const iamMock = mockClient(IAMClient);
const stsMock = mockClient(STSClient);

describe('PolicyManager', () => {
  let manager: PolicyManager;

  beforeEach(() => {
    iamMock.reset();
    stsMock.reset();

    stsMock.on(GetCallerIdentityCommand).resolves({
      Account: '123456789012',
      Arn: 'arn:aws:sts::123456789012:assumed-role/LambdaRole/session',
    });

    manager = new PolicyManager();
  });

  describe('scoped role management', () => {
    test('creates role with datastore scope prefix', async () => {
      iamMock.on(CreateRoleCommand).resolves({});
      iamMock.on(PutRolePolicyCommand).resolves({});

      await manager.ensureRole(
        'ds-123',
        [{ actions: ['s3:GetObject'], resources: ['arn:aws:s3:::bucket/*'] }],
        '123456789012',
        'datastore'
      );

      const createCalls = iamMock.commandCalls(CreateRoleCommand);
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0].args[0].input.RoleName).toBe('citadel-ds-ds-123');
    });

    test('creates role with integration scope prefix', async () => {
      iamMock.on(CreateRoleCommand).resolves({});
      iamMock.on(PutRolePolicyCommand).resolves({});

      await manager.ensureRole(
        'int-456',
        [{ actions: ['lambda:InvokeFunction'], resources: ['arn:aws:lambda:*:*:function:*'] }],
        '123456789012',
        'integration'
      );

      const createCalls = iamMock.commandCalls(CreateRoleCommand);
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0].args[0].input.RoleName).toBe('citadel-int-int-456');
    });

    test('creates role with agent scope prefix', async () => {
      iamMock.on(CreateRoleCommand).resolves({});
      iamMock.on(PutRolePolicyCommand).resolves({});

      await manager.ensureRole(
        'agent-789',
        [{ actions: ['bedrock:InvokeModel'], resources: ['*'] }],
        '123456789012',
        'agent'
      );

      const createCalls = iamMock.commandCalls(CreateRoleCommand);
      expect(createCalls).toHaveLength(1);
      expect(createCalls[0].args[0].input.RoleName).toBe('citadel-agent-agent-789');
    });

    test('defaults to datastore scope for backward compatibility', async () => {
      iamMock.on(CreateRoleCommand).resolves({});
      iamMock.on(PutRolePolicyCommand).resolves({});

      await manager.ensureRole(
        'legacy-id',
        [{ actions: ['s3:GetObject'], resources: ['*'] }],
        '123456789012'
      );

      const createCalls = iamMock.commandCalls(CreateRoleCommand);
      expect(createCalls[0].args[0].input.RoleName).toBe('citadel-ds-legacy-id');
    });
  });

  describe('assumeScopedRole', () => {
    test('assumes role with correct scope prefix', async () => {
      stsMock.on(AssumeRoleCommand).resolves({
        Credentials: {
          AccessKeyId: 'AKIA...',
          SecretAccessKey: 'secret',
          SessionToken: 'token',
          Expiration: new Date(),
        },
      });

      const creds = await manager.assumeScopedRole('ds-123', '123456789012', 'datastore');
      expect(creds.accessKeyId).toBe('AKIA...');

      const assumeCalls = stsMock.commandCalls(AssumeRoleCommand);
      expect(assumeCalls[0].args[0].input.RoleArn).toContain('citadel-ds-ds-123');
    });

    test('assumes role with integration scope', async () => {
      stsMock.on(AssumeRoleCommand).resolves({
        Credentials: {
          AccessKeyId: 'AKIA...',
          SecretAccessKey: 'secret',
          SessionToken: 'token',
          Expiration: new Date(),
        },
      });

      const creds = await manager.assumeScopedRole('int-456', '123456789012', 'integration');
      const assumeCalls = stsMock.commandCalls(AssumeRoleCommand);
      expect(assumeCalls[0].args[0].input.RoleArn).toContain('citadel-int-int-456');
    });
  });

  describe('deleteRole', () => {
    test('deletes role with correct scope prefix', async () => {
      iamMock.on(DeleteRolePolicyCommand).resolves({});
      iamMock.on(DeleteRoleCommand).resolves({});

      await manager.deleteRole('ds-123', 'datastore');

      const deletePolicyCalls = iamMock.commandCalls(DeleteRolePolicyCommand);
      expect(deletePolicyCalls[0].args[0].input.RoleName).toBe('citadel-ds-ds-123');
    });

    test('defaults to datastore scope for backward compatibility', async () => {
      iamMock.on(DeleteRolePolicyCommand).resolves({});
      iamMock.on(DeleteRoleCommand).resolves({});

      await manager.deleteRole('legacy-id');

      const deletePolicyCalls = iamMock.commandCalls(DeleteRolePolicyCommand);
      expect(deletePolicyCalls[0].args[0].input.RoleName).toBe('citadel-ds-legacy-id');
    });
  });

  describe('buildPolicyDocument', () => {
    test('builds valid IAM policy document from PolicyStatements', () => {
      const doc = PolicyManager.buildPolicyDocument([
        { actions: ['s3:GetObject'], resources: ['arn:aws:s3:::bucket/*'] },
        { actions: ['dynamodb:Query'], resources: ['arn:aws:dynamodb:*:*:table/t'] },
      ]);

      expect(doc.Version).toBe('2012-10-17');
      expect(doc.Statement).toHaveLength(2);
      expect(doc.Statement[0].Effect).toBe('Allow');
      expect(doc.Statement[0].Action).toEqual(['s3:GetObject']);
    });
  });

  describe('getRoleName', () => {
    test('returns scoped role name', () => {
      expect(PolicyManager.getRoleName('abc', 'datastore')).toBe('citadel-ds-abc');
      expect(PolicyManager.getRoleName('abc', 'integration')).toBe('citadel-int-abc');
      expect(PolicyManager.getRoleName('abc', 'agent')).toBe('citadel-agent-abc');
    });

    test('defaults to datastore scope', () => {
      expect(PolicyManager.getRoleName('abc')).toBe('citadel-ds-abc');
    });
  });
});
