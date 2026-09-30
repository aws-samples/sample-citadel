/**
 * Unit tests for pre-token-generation Lambda.
 *
 * Covers the trigger behaviour the Phase 1 org-scoping work depends on:
 * the handler promotes the `custom:organization` attribute onto
 * `claimsToAddOrOverride` while preserving any other
 * `claimsOverrideDetails` keys already set upstream.
 *
 * The promoted `custom:role` claim is DISPLAY/LEGACY ONLY and, since
 * CIT-213, is derived exclusively from Cognito group membership
 * (`groupConfiguration.groupsToOverride`) — the stored, client-writable
 * `custom:role` attribute is never read (finding 7aa877f8).
 */
import { handler } from "../pre-token-generation";

type HandlerEvent = Parameters<typeof handler>[0];

/** Loose overrides: request.userAttributes merges, everything else replaces. */
interface EventOverrides extends Record<string, unknown> {
  request?: {
    userAttributes?: Record<string, string>;
    groupConfiguration?: {
      groupsToOverride: string[];
      iamRolesToOverride: string[];
      preferredRole: string | null;
    };
  };
  response?: unknown;
}

function makeEvent(overrides: EventOverrides = {}): HandlerEvent {
  return {
    version: "1",
    triggerSource: "TokenGeneration_HostedAuth",
    region: "us-east-1",
    userPoolId: "us-east-1_test",
    userName: "user-123",
    callerContext: { awsSdkVersion: "1", clientId: "client-1" },
    request: {
      userAttributes: {
        sub: "user-123",
        email: "u@example.com",
        ...(overrides.request?.userAttributes || {}),
      },
      groupConfiguration: overrides.request?.groupConfiguration ?? {
        groupsToOverride: [],
        iamRolesToOverride: [],
        preferredRole: null,
      },
    },
    response: overrides.response ?? {},
  } as unknown as HandlerEvent;
}

function groups(groupsToOverride: string[]) {
  return { groupsToOverride, iamRolesToOverride: [], preferredRole: null };
}

function claims(result: HandlerEvent) {
  return result.response?.claimsOverrideDetails?.claimsToAddOrOverride;
}

describe("pre-token-generation", () => {
  // -------------------------------------------------------------------
  // custom:organization promotion (unchanged — CIT-214 scope)
  // -------------------------------------------------------------------

  test("adds custom:organization from the stored attribute", async () => {
    const event = makeEvent({
      request: { userAttributes: { "custom:organization": "org-a" } },
    });

    const result = await handler(event);

    expect(claims(result)).toEqual({ "custom:organization": "org-a" });
  });

  test("produces an empty claimsToAddOrOverride when no attribute and no group is present", async () => {
    const event = makeEvent({ request: { userAttributes: {} } });

    const result = await handler(event);

    expect(claims(result)).toEqual({});
  });

  test("preserves existing claimsOverrideDetails keys (e.g. groupOverrideDetails)", async () => {
    const existingGroupOverride = groups(["admin"]);

    const event = makeEvent({
      request: { userAttributes: { "custom:organization": "org-a" } },
      response: {
        claimsOverrideDetails: { groupOverrideDetails: existingGroupOverride },
      },
    });

    const result = await handler(event);

    expect(result.response?.claimsOverrideDetails).toEqual({
      groupOverrideDetails: existingGroupOverride,
      claimsToAddOrOverride: { "custom:organization": "org-a" },
    });
  });

  // -------------------------------------------------------------------
  // custom:role claim — derived from groupsToOverride ONLY (CIT-213)
  // -------------------------------------------------------------------

  // finding 7aa877f8 / CIT-213: the stored custom:role attribute is
  // client-writable. It must never be read — neither to promote 'admin'
  // nor to promote a non-admin role. These are the KEY ESCALATION TESTS
  // for the trigger side.
  test("KEY ESCALATION TEST: a stored custom:role=admin attribute WITHOUT admin group membership is NOT promoted to the admin claim", async () => {
    const event = makeEvent({
      request: {
        userAttributes: {
          "custom:organization": "org-a",
          "custom:role": "admin",
        },
        groupConfiguration: groups(["project_manager"]),
      },
    });

    const result = await handler(event);

    expect(claims(result)).toEqual({
      "custom:organization": "org-a",
      "custom:role": "project_manager",
    });
  });

  test("KEY ESCALATION TEST (CIT-213): a stored non-admin custom:role attribute with NO group membership is NOT promoted", async () => {
    const event = makeEvent({
      request: {
        userAttributes: {
          "custom:organization": "org-a",
          "custom:role": "project_manager",
        },
        groupConfiguration: groups([]),
      },
    });

    const result = await handler(event);

    expect(claims(result)).toEqual({ "custom:organization": "org-a" });
  });

  test("KEY ESCALATION TEST (CIT-213): stored custom:role=architect with only the developer group promotes 'developer', not 'architect'", async () => {
    const event = makeEvent({
      request: {
        userAttributes: { "custom:role": "architect" },
        groupConfiguration: groups(["developer"]),
      },
    });

    const result = await handler(event);

    expect(claims(result)).toEqual({ "custom:role": "developer" });
  });

  test("admin group membership yields custom:role=admin regardless of the stored attribute", async () => {
    const event = makeEvent({
      request: {
        userAttributes: { "custom:role": "project_manager" },
        groupConfiguration: groups(["admin"]),
      },
    });

    const result = await handler(event);

    expect(claims(result)).toEqual({ "custom:role": "admin" });
  });

  test("admin group with no custom:role attribute → custom:role=admin", async () => {
    const event = makeEvent({
      request: { userAttributes: {}, groupConfiguration: groups(["admin"]) },
    });

    const result = await handler(event);

    expect(claims(result)).toEqual({ "custom:role": "admin" });
  });

  test("admin wins over every other group, whatever the array order", async () => {
    const event = makeEvent({
      request: {
        userAttributes: {},
        groupConfiguration: groups(["developer", "architect", "admin"]),
      },
    });

    const result = await handler(event);

    expect(claims(result)).toEqual({ "custom:role": "admin" });
  });

  test("a single non-admin group is promoted as the display role", async () => {
    const event = makeEvent({
      request: {
        userAttributes: { "custom:organization": "org-a" },
        groupConfiguration: groups(["architect"]),
      },
    });

    const result = await handler(event);

    expect(claims(result)).toEqual({
      "custom:organization": "org-a",
      "custom:role": "architect",
    });
  });

  test("multiple non-admin groups → the first in precedence order (project_manager > architect > developer), not array order", async () => {
    const event = makeEvent({
      request: {
        userAttributes: {},
        groupConfiguration: groups(["developer", "architect"]),
      },
    });

    const result = await handler(event);

    expect(claims(result)).toEqual({ "custom:role": "architect" });
  });

  test("project_manager outranks architect and developer", async () => {
    const event = makeEvent({
      request: {
        userAttributes: {},
        groupConfiguration: groups([
          "developer",
          "project_manager",
          "architect",
        ]),
      },
    });

    const result = await handler(event);

    expect(claims(result)).toEqual({ "custom:role": "project_manager" });
  });

  test("unknown groups are ignored — no custom:role claim is emitted", async () => {
    const event = makeEvent({
      request: {
        userAttributes: {},
        groupConfiguration: groups(["analyst", "viewer"]),
      },
    });

    const result = await handler(event);

    expect(claims(result)).toEqual({});
  });

  test("unknown groups are skipped in favour of a known lower-precedence group", async () => {
    const event = makeEvent({
      request: {
        userAttributes: {},
        groupConfiguration: groups(["analyst", "developer"]),
      },
    });

    const result = await handler(event);

    expect(claims(result)).toEqual({ "custom:role": "developer" });
  });

  test("groupConfiguration entirely missing → no crash and no custom:role claim", async () => {
    const event = makeEvent({
      request: { userAttributes: { "custom:role": "architect" } },
    });
    // makeEvent seeds groupConfiguration by default; strip it.
    delete event.request.groupConfiguration;

    const result = await handler(event);

    expect(claims(result)).toEqual({});
  });
});
