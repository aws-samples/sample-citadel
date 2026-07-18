/**
 * Unit tests for pre-token-generation Lambda.
 *
 * Covers the trigger behaviour the Phase 1 org-scoping work depends on:
 * the handler promotes `custom:organization` and `custom:role` attributes
 * onto `claimsToAddOrOverride` while preserving any other
 * `claimsOverrideDetails` keys already set upstream.
 */
import { handler } from '../pre-token-generation';

type HandlerEvent = Parameters<typeof handler>[0];

/** Loose overrides: request.userAttributes merges, everything else replaces. */
interface EventOverrides extends Record<string, unknown> {
  request?: { userAttributes?: Record<string, string> };
  response?: unknown;
}

function makeEvent(overrides: EventOverrides = {}): HandlerEvent {
  return {
    version: '1',
    triggerSource: 'TokenGeneration_HostedAuth',
    region: 'us-east-1',
    userPoolId: 'us-east-1_test',
    userName: 'user-123',
    callerContext: { awsSdkVersion: '1', clientId: 'client-1' },
    request: {
      userAttributes: {
        sub: 'user-123',
        email: 'u@example.com',
        ...(overrides.request?.userAttributes || {}),
      },
      groupConfiguration: { groupsToOverride: [], iamRolesToOverride: [], preferredRole: null },
    },
    response: overrides.response ?? {},
    ...overrides,
  } as unknown as HandlerEvent;
}

describe('pre-token-generation', () => {
  test('adds both custom:organization and custom:role when both attributes are present', async () => {
    const event = makeEvent({
      request: {
        userAttributes: {
          'custom:organization': 'org-a',
          'custom:role': 'admin',
        },
      },
    });

    const result = await handler(event);

    expect(result.response?.claimsOverrideDetails?.claimsToAddOrOverride).toEqual({
      'custom:organization': 'org-a',
      'custom:role': 'admin',
    });
  });

  test('adds only custom:organization when role is missing', async () => {
    const event = makeEvent({
      request: {
        userAttributes: {
          'custom:organization': 'org-a',
        },
      },
    });

    const result = await handler(event);

    expect(result.response?.claimsOverrideDetails?.claimsToAddOrOverride).toEqual({
      'custom:organization': 'org-a',
    });
  });

  test('adds only custom:role when organization is missing', async () => {
    const event = makeEvent({
      request: {
        userAttributes: {
          'custom:role': 'project_manager',
        },
      },
    });

    const result = await handler(event);

    expect(result.response?.claimsOverrideDetails?.claimsToAddOrOverride).toEqual({
      'custom:role': 'project_manager',
    });
  });

  test('produces an empty claimsToAddOrOverride when neither attribute is present', async () => {
    const event = makeEvent({
      request: {
        userAttributes: {},
      },
    });

    const result = await handler(event);

    expect(result.response?.claimsOverrideDetails?.claimsToAddOrOverride).toEqual({});
  });

  test('preserves existing claimsOverrideDetails keys (e.g. groupOverrideDetails)', async () => {
    const existingGroupOverride = {
      groupsToOverride: ['admin'],
      iamRolesToOverride: [],
      preferredRole: null,
    };

    const event = makeEvent({
      request: {
        userAttributes: {
          'custom:organization': 'org-a',
        },
      },
      response: {
        claimsOverrideDetails: {
          groupOverrideDetails: existingGroupOverride,
        },
      },
    });

    const result = await handler(event);

    expect(result.response?.claimsOverrideDetails).toEqual({
      groupOverrideDetails: existingGroupOverride,
      claimsToAddOrOverride: {
        'custom:organization': 'org-a',
      },
    });
  });

  // ---------------------------------------------------------------------
  // Admin-group → custom:role overlay
  // ---------------------------------------------------------------------

  test('explicit custom:role wins over admin-group membership', async () => {
    const event = makeEvent({
      request: {
        userAttributes: {
          'custom:role': 'project_manager',
        },
        groupConfiguration: {
          groupsToOverride: ['admin'],
          iamRolesToOverride: [],
          preferredRole: null,
        },
      },
    });

    const result = await handler(event);

    expect(
      result.response?.claimsOverrideDetails?.claimsToAddOrOverride,
    ).toEqual({
      'custom:role': 'project_manager',
    });
  });

  test('admin group with no custom:role attribute → overlay sets custom:role to admin', async () => {
    const event = makeEvent({
      request: {
        userAttributes: {},
        groupConfiguration: {
          groupsToOverride: ['admin'],
          iamRolesToOverride: [],
          preferredRole: null,
        },
      },
    });

    const result = await handler(event);

    expect(
      result.response?.claimsOverrideDetails?.claimsToAddOrOverride,
    ).toEqual({
      'custom:role': 'admin',
    });
  });

  test('non-admin group without custom:role attribute → no overlay applied', async () => {
    const event = makeEvent({
      request: {
        userAttributes: {},
        groupConfiguration: {
          groupsToOverride: ['analyst'],
          iamRolesToOverride: [],
          preferredRole: null,
        },
      },
    });

    const result = await handler(event);

    expect(
      result.response?.claimsOverrideDetails?.claimsToAddOrOverride,
    ).toEqual({});
  });

  test('groupConfiguration entirely missing → no crash and no overlay', async () => {
    const event = makeEvent({
      request: {
        userAttributes: {},
      },
    });
    // makeEvent seeds groupConfiguration by default; strip it.
    delete event.request.groupConfiguration;

    const result = await handler(event);

    expect(
      result.response?.claimsOverrideDetails?.claimsToAddOrOverride,
    ).toEqual({});
  });
});
