/**
 * TDD: cross-account ExternalId support on PolicyManager (Phase 2, agent-import).
 *
 * These cover ONLY the NEW optional-externalId paths and are strictly additive:
 * when no externalId is supplied, assumeScopedRole / ensureRole must behave
 * EXACTLY as before — that back-compat is locked down by the existing,
 * UNMODIFIED suites in policy-manager.test.ts and policy-manager.property.test.ts.
 */
import { IAMClient, CreateRoleCommand, PutRolePolicyCommand } from '@aws-sdk/client-iam';
import {
  STSClient,
  GetCallerIdentityCommand,
  AssumeRoleCommand,
} from '@aws-sdk/client-sts';
import { mockClient } from 'aws-sdk-client-mock';
import { PolicyManager } from '../policy-manager';

const iamMock = mockClient(IAMClient);
const stsMock = mockClient(STSClient);

const ACCOUNT = '123456789012';
const EXTERNAL_ID = 'citadel-ext-abc123';
const CROSS_ARN = 'arn:aws:iam::222233334444:role/CustomerInvokeRole';

describe('PolicyManager cross-account ExternalId (additive, behaviour-preserving)', () => {
  beforeEach(() => {
    iamMock.reset();
    stsMock.reset();
    stsMock.on(GetCallerIdentityCommand).resolves({
      Account: ACCOUNT,
      Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/LambdaRole/session`,
    });
    stsMock.on(AssumeRoleCommand).resolves({
      Credentials: {
        AccessKeyId: 'AKIAEXAMPLE',
        SecretAccessKey: 'secret',
        SessionToken: 'token',
        Expiration: new Date('2030-01-01T00:00:00.000Z'),
      },
    });
    iamMock.on(CreateRoleCommand).resolves({});
    iamMock.on(PutRolePolicyCommand).resolves({});
  });

  describe('assumeScopedRole', () => {
    it('threads ExternalId into every AssumeRoleCommand when provided (2-hop cross-account)', async () => {
      await new PolicyManager().assumeScopedRole(
        'agent-1',
        ACCOUNT,
        'agent',
        CROSS_ARN,
        EXTERNAL_ID,
      );

      const calls = stsMock.commandCalls(AssumeRoleCommand);
      expect(calls.length).toBeGreaterThanOrEqual(2); // cross-account hop + scoped assume
      for (const call of calls) {
        expect(call.args[0].input.ExternalId).toBe(EXTERNAL_ID);
      }
    });

    it('threads ExternalId into the single scoped assume when no crossArn is given', async () => {
      await new PolicyManager().assumeScopedRole(
        'agent-2',
        ACCOUNT,
        'agent',
        undefined,
        EXTERNAL_ID,
      );

      const calls = stsMock.commandCalls(AssumeRoleCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input.ExternalId).toBe(EXTERNAL_ID);
    });

    it('surfaces expiresAt mapped from the STS Expiration', async () => {
      const creds = await new PolicyManager().assumeScopedRole(
        'agent-3',
        ACCOUNT,
        'agent',
        undefined,
        EXTERNAL_ID,
      );

      expect(creds.accessKeyId).toBe('AKIAEXAMPLE');
      expect(creds.expiresAt).toBe('2030-01-01T00:00:00.000Z');
    });

    it('omits ExternalId entirely when not provided (identical to before)', async () => {
      await new PolicyManager().assumeScopedRole('agent-4', ACCOUNT, 'agent');

      const calls = stsMock.commandCalls(AssumeRoleCommand);
      expect(calls).toHaveLength(1);
      expect('ExternalId' in (calls[0].args[0].input as object)).toBe(false);
    });
  });

  describe('ensureRole', () => {
    it('adds an sts:ExternalId StringEquals Condition to the trust policy when provided', async () => {
      await new PolicyManager().ensureRole(
        'agent-1',
        [{ actions: ['bedrock:InvokeModel'], resources: ['*'] }],
        ACCOUNT,
        'agent',
        undefined,
        undefined,
        EXTERNAL_ID,
      );

      const create = iamMock.commandCalls(CreateRoleCommand);
      expect(create).toHaveLength(1);
      const trust = JSON.parse(
        create[0].args[0].input.AssumeRolePolicyDocument as string,
      );
      expect(trust.Statement[0].Condition).toEqual({
        StringEquals: { 'sts:ExternalId': EXTERNAL_ID },
      });
    });

    it('omits the Condition entirely when no externalId is provided (identical to before)', async () => {
      await new PolicyManager().ensureRole(
        'agent-2',
        [{ actions: ['bedrock:InvokeModel'], resources: ['*'] }],
        ACCOUNT,
        'agent',
      );

      const create = iamMock.commandCalls(CreateRoleCommand);
      const trust = JSON.parse(
        create[0].args[0].input.AssumeRolePolicyDocument as string,
      );
      expect(trust.Statement[0].Condition).toBeUndefined();
    });
  });
});
