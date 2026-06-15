/**
 * Unit tests for the shared auth-event helper.
 *
 * Covers both code paths of `extractOrgFromEvent` (claim-first, Cognito
 * fallback) and the claim-only `isAdminFromEvent`. The Cognito fallback
 * path is asserted never to trigger when a claim is present — that
 * guarantee is the reason this helper exists.
 */
import { mockClient } from 'aws-sdk-client-mock';
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { extractOrgFromEvent, isAdminFromEvent } from '../auth-event';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

describe('auth-event', () => {
  beforeAll(() => {
    process.env.USER_POOL_ID = 'us-east-1_test';
  });

  beforeEach(() => {
    cognitoMock.reset();
  });

  afterAll(() => {
    delete process.env.USER_POOL_ID;
  });

  describe('extractOrgFromEvent', () => {
    test('returns orgId from identity["custom:organization"] without calling Cognito', async () => {
      const event = {
        identity: {
          sub: 'user-123',
          'custom:organization': 'org-claim-a',
        },
      };

      const result = await extractOrgFromEvent(event);

      expect(result).toBe('org-claim-a');
      expect(cognitoMock.commandCalls(AdminGetUserCommand).length).toBe(0);
    });

    test('returns orgId from identity.claims["custom:organization"] without calling Cognito', async () => {
      const event = {
        identity: {
          sub: 'user-123',
          claims: {
            'custom:organization': 'org-claim-b',
          },
        },
      };

      const result = await extractOrgFromEvent(event);

      expect(result).toBe('org-claim-b');
      expect(cognitoMock.commandCalls(AdminGetUserCommand).length).toBe(0);
    });

    test('falls back to Cognito AdminGetUser and returns attribute value when no claim is present', async () => {
      cognitoMock.on(AdminGetUserCommand).resolves({
        Username: 'user-123',
        UserAttributes: [
          { Name: 'sub', Value: 'user-123' },
          { Name: 'custom:organization', Value: 'org-cognito-c' },
        ],
      });

      const event = { identity: { sub: 'user-123' } };

      const result = await extractOrgFromEvent(event);

      expect(result).toBe('org-cognito-c');
      expect(cognitoMock.commandCalls(AdminGetUserCommand).length).toBe(1);
    });

    test('returns null (without throwing) when Cognito fallback errors', async () => {
      cognitoMock.on(AdminGetUserCommand).rejects(new Error('boom'));

      const event = { identity: { sub: 'user-123' } };

      const result = await extractOrgFromEvent(event);

      expect(result).toBeNull();
    });

    test('returns null when event has no identity', async () => {
      const result = await extractOrgFromEvent({});
      expect(result).toBeNull();
      expect(cognitoMock.commandCalls(AdminGetUserCommand).length).toBe(0);
    });

    test('returns null when USER_POOL_ID is unset (no Cognito call)', async () => {
      const originalPoolId = process.env.USER_POOL_ID;
      delete process.env.USER_POOL_ID;

      try {
        const event = { identity: { sub: 'user-123' } };
        const result = await extractOrgFromEvent(event);
        expect(result).toBeNull();
        expect(cognitoMock.commandCalls(AdminGetUserCommand).length).toBe(0);
      } finally {
        process.env.USER_POOL_ID = originalPoolId;
      }
    });

    test('falls back to Cognito using identity.username when sub is absent', async () => {
      cognitoMock.on(AdminGetUserCommand).resolves({
        Username: 'name-only-user',
        UserAttributes: [
          { Name: 'custom:organization', Value: 'org-from-username' },
        ],
      });

      const event = { identity: { username: 'name-only-user' } };

      const result = await extractOrgFromEvent(event);
      expect(result).toBe('org-from-username');
      expect(cognitoMock.commandCalls(AdminGetUserCommand).length).toBe(1);
    });
  });

  describe('isAdminFromEvent', () => {
    test('returns true when identity["custom:role"] is "admin"', () => {
      const event = { identity: { 'custom:role': 'admin' } };
      expect(isAdminFromEvent(event)).toBe(true);
    });

    test('returns true when identity.claims["custom:role"] is "admin"', () => {
      const event = { identity: { claims: { 'custom:role': 'admin' } } };
      expect(isAdminFromEvent(event)).toBe(true);
    });

    test('returns false when role is "project_manager"', () => {
      const event = { identity: { 'custom:role': 'project_manager' } };
      expect(isAdminFromEvent(event)).toBe(false);
    });

    test('returns false when role claim is absent', () => {
      const event = { identity: { sub: 'user-123' } };
      expect(isAdminFromEvent(event)).toBe(false);
    });

    test('returns false when event has no identity', () => {
      expect(isAdminFromEvent({})).toBe(false);
    });

    test('returns true when cognito:groups is an array containing "admin"', () => {
      const event = {
        identity: { 'cognito:groups': ['admin', 'user'] },
      };
      expect(isAdminFromEvent(event)).toBe(true);
    });

    test('returns false when cognito:groups array contains only non-admin groups', () => {
      const event = {
        identity: { 'cognito:groups': ['user', 'project_manager'] },
      };
      expect(isAdminFromEvent(event)).toBe(false);
    });

    test('returns true when cognito:groups is the comma-separated string "admin,user"', () => {
      const event = {
        identity: { 'cognito:groups': 'admin,user' },
      };
      expect(isAdminFromEvent(event)).toBe(true);
    });

    test('returns false when cognito:groups is the string "user,project_manager"', () => {
      const event = {
        identity: { 'cognito:groups': 'user,project_manager' },
      };
      expect(isAdminFromEvent(event)).toBe(false);
    });

    test('returns false when both cognito:groups and custom:role are missing', () => {
      const event = { identity: { sub: 'user-123' } };
      expect(isAdminFromEvent(event)).toBe(false);
    });

    test('honours cognito:groups at identity["cognito:groups"] (Cognito user pool auth mode)', () => {
      const event = {
        identity: { 'cognito:groups': ['admin'] },
      };
      expect(isAdminFromEvent(event)).toBe(true);
    });

    test('honours cognito:groups at identity.claims["cognito:groups"] (proxy/IAM mode)', () => {
      const event = {
        identity: { claims: { 'cognito:groups': ['admin'] } },
      };
      expect(isAdminFromEvent(event)).toBe(true);
    });

    test('custom:role "admin" wins even when cognito:groups is empty/absent', () => {
      const event = {
        identity: { 'custom:role': 'admin', 'cognito:groups': [] },
      };
      expect(isAdminFromEvent(event)).toBe(true);
    });
  });
});
