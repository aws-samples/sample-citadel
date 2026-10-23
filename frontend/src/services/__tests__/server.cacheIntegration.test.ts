/**
 * server.ts cache integration — signOut and signIn clear the query cache.
 */

const mockSignIn = jest.fn().mockResolvedValue({ isSignedIn: true });
const mockSignOut = jest.fn().mockResolvedValue(undefined);

jest.mock('aws-amplify/auth', () => ({
  signIn: (...args: unknown[]) => mockSignIn(...args),
  signOut: (...args: unknown[]) => mockSignOut(...args),
  signUp: jest.fn(),
  confirmSignUp: jest.fn(),
  confirmSignIn: jest.fn(),
  resendSignUpCode: jest.fn(),
  getCurrentUser: jest.fn(),
  fetchAuthSession: jest.fn().mockResolvedValue({ tokens: undefined }),
  resetPassword: jest.fn(),
  confirmResetPassword: jest.fn(),
}));

jest.mock('aws-amplify/api', () => ({
  generateClient: jest.fn(() => ({ graphql: jest.fn() })),
}));

jest.mock('aws-amplify', () => ({
  Amplify: { configure: jest.fn() },
}));

import serverService from '../server';
import { cached, clearAll } from '../queryCache';

beforeEach(() => {
  clearAll();
  jest.clearAllMocks();
});

describe('serverService.signOut clears query cache', () => {
  it('evicts cached entries so the next call re-fetches', async () => {
    let calls = 0;
    const fetcher = async () => ++calls;

    // Populate cache
    await cached('agents:list', fetcher);
    expect(calls).toBe(1);

    // Sign out — should clear
    await serverService.signOut();

    // Re-fetch should call fetcher again
    await cached('agents:list', fetcher);
    expect(calls).toBe(2);
  });
});

describe('serverService.signIn clears query cache', () => {
  it('evicts stale entries from a previous session', async () => {
    let calls = 0;
    const fetcher = async () => ++calls;

    // Populate cache with stale data from prior session
    await cached('tools:list', fetcher);
    expect(calls).toBe(1);

    // Sign in — should clear
    await serverService.signIn({ username: 'u', password: 'p' });

    // Re-fetch should call fetcher again
    await cached('tools:list', fetcher);
    expect(calls).toBe(2);
  });
});
