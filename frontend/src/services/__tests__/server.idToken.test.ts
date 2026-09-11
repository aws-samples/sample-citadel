/**
 * Regression test for finding c7beb960 (high): AppSync requests must carry
 * Cognito's ID TOKEN, not the access token.
 *
 * Root cause: Amplify v6's default `userPool` auth mode sends the ACCESS
 * token on every AppSync request, but the pre-token-generation trigger only
 * decorates the ID token with `custom:organization`
 * (`claimsOverrideDetails` targets ID-token claims only). An
 * access-token-authenticated request therefore reaches the backend with no
 * `custom:organization` claim, so `extractOrgFromEvent` returns null for
 * every caller and every non-admin org gate fails closed.
 *
 * This test asserts the header-override function used at client
 * construction resolves to the ID token (not the access token), and that
 * `generateClient` is invoked with that override — covering queries,
 * mutations, and subscriptions uniformly, since Amplify applies a client's
 * `headers` option to all three.
 */

jest.mock('aws-amplify/auth', () => ({
  signIn: jest.fn(),
  signOut: jest.fn(),
  signUp: jest.fn(),
  confirmSignUp: jest.fn(),
  confirmSignIn: jest.fn(),
  resendSignUpCode: jest.fn(),
  getCurrentUser: jest.fn(),
  fetchAuthSession: jest.fn(),
  resetPassword: jest.fn(),
  confirmResetPassword: jest.fn(),
}));

jest.mock('aws-amplify/api', () => ({
  generateClient: jest.fn(() => ({ graphql: jest.fn() })),
}));

jest.mock('aws-amplify', () => ({
  Amplify: { configure: jest.fn() },
}));

import { generateClient } from 'aws-amplify/api';
import { fetchAuthSession } from 'aws-amplify/auth';
import { withIdTokenHeader } from '../server';

describe('finding c7beb960: AppSync client sends the ID token, not the access token', () => {
  // Captured once, before any beforeEach clears mock call history — the
  // constructor call happened exactly once at module-import time, above.
  const clientConstructionCallArgs = (generateClient as jest.Mock).mock.calls[0];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('constructs the client with a headers override (applies to queries, mutations, AND subscriptions)', () => {
    expect(clientConstructionCallArgs).toBeDefined();
    const options = clientConstructionCallArgs[0];
    expect(options).toBeDefined();
    expect(typeof options.headers).toBe('function');
    // The same function reference is what's under test below — confirms
    // this isn't a second, divergent header-builder.
    expect(options.headers).toBe(withIdTokenHeader);
  });

  it('withIdTokenHeader resolves Authorization to the ID token string, never the access token', async () => {
    const idTokenString = 'eyIDTOKEN.header.payload.signature';
    const accessTokenString = 'eyACCESSTOKEN.header.payload.signature';

    (fetchAuthSession as jest.Mock).mockResolvedValue({
      tokens: {
        idToken: { toString: () => idTokenString },
        accessToken: { toString: () => accessTokenString },
      },
    });

    const headers = await withIdTokenHeader();

    expect(headers.Authorization).toBe(idTokenString);
    expect(headers.Authorization).not.toBe(accessTokenString);
  });

  it('withIdTokenHeader produces a claims-bearing token shape the backend expects (custom:organization present)', async () => {
    // Simulate the ID token's decoded claim payload (what the
    // pre-token-generation trigger decorates) to document the contract:
    // whatever fetchAuthSession returns as idToken must be the token that
    // carries custom:organization end-to-end through AppSync's identity.
    const decodedIdTokenPayload = {
      sub: 'user-123',
      token_use: 'id',
      'custom:organization': 'Acme Corp',
      'cognito:groups': ['admin'],
    };
    const idTokenString = 'signed.id.token';

    (fetchAuthSession as jest.Mock).mockResolvedValue({
      tokens: {
        idToken: {
          toString: () => idTokenString,
          payload: decodedIdTokenPayload,
        },
      },
    });

    const headers = await withIdTokenHeader();

    expect(headers.Authorization).toBe(idTokenString);
    // Document (not assert against Amplify internals) that the underlying
    // session token this header is derived from is claim-bearing for org.
    const session = await fetchAuthSession();
    expect(session.tokens?.idToken?.payload['custom:organization']).toBe('Acme Corp');
  });

  it('falls back to no Authorization override when no session exists (e.g. unauthenticated api-key mode)', async () => {
    (fetchAuthSession as jest.Mock).mockResolvedValue({ tokens: undefined });

    const headers = await withIdTokenHeader();

    expect(headers.Authorization).toBeUndefined();
  });

  it('does not throw and returns empty headers when fetchAuthSession rejects', async () => {
    (fetchAuthSession as jest.Mock).mockRejectedValue(new Error('network error'));
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

    const headers = await withIdTokenHeader();

    expect(headers).toEqual({});
    consoleSpy.mockRestore();
  });
});
