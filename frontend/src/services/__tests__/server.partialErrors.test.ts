/**
 * server.ts query() partial-error tolerance.
 *
 * When a GraphQL response carries BOTH data and errors, query() should
 * console.warn the errors and return the data — not throw.
 * Mutation behaviour (mutate()) is unchanged: it always throws on errors.
 */

jest.mock('aws-amplify/auth', () => ({
  signIn: jest.fn(),
  signOut: jest.fn(),
  signUp: jest.fn(),
  confirmSignUp: jest.fn(),
  confirmSignIn: jest.fn(),
  resendSignUpCode: jest.fn(),
  getCurrentUser: jest.fn(),
  fetchAuthSession: jest.fn().mockResolvedValue({ tokens: undefined }),
  resetPassword: jest.fn(),
  confirmResetPassword: jest.fn(),
}));

const mockGraphql = jest.fn();
jest.mock('aws-amplify/api', () => ({
  generateClient: jest.fn(() => ({ graphql: mockGraphql })),
}));

jest.mock('aws-amplify', () => ({
  Amplify: { configure: jest.fn() },
}));

import serverService from '../server';

describe('server.query() partial error tolerance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns data and warns when response has both data and errors', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();
    mockGraphql.mockResolvedValue({
      data: { listThings: { items: [{ id: '1' }] } },
      errors: [{ message: 'Nullable field failed' }],
    });

    const result = await serverService.query('query ListThings { listThings { items { id } } }');

    expect(result).toEqual({ listThings: { items: [{ id: '1' }] } });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('partial errors'),
      'Nullable field failed',
    );
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('throws when response has errors but no data', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();
    mockGraphql.mockResolvedValue({
      data: null,
      errors: [{ message: 'Total failure' }],
    });

    await expect(
      serverService.query('query Broken { broken }'),
    ).rejects.toThrow('Total failure');
    errorSpy.mockRestore();
  });

  it('throws when response has errors and data is undefined', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();
    mockGraphql.mockResolvedValue({
      errors: [{ message: 'No data at all' }],
    });

    await expect(
      serverService.query('query NoData { noData }'),
    ).rejects.toThrow('No data at all');
    errorSpy.mockRestore();
  });

  it('returns data normally when no errors are present', async () => {
    mockGraphql.mockResolvedValue({
      data: { getItem: { id: '42' } },
    });

    const result = await serverService.query('query GetItem { getItem { id } }');

    expect(result).toEqual({ getItem: { id: '42' } });
  });

  it('handles Amplify thrown error with both data and errors (catch path)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();
    const err: any = new Error('graphql error');
    err.data = { listItems: { items: [] } };
    err.errors = [{ message: 'Partial resolver failure' }];
    mockGraphql.mockRejectedValue(err);

    const result = await serverService.query('query ListItems { listItems { items { id } } }');

    expect(result).toEqual({ listItems: { items: [] } });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('partial errors'),
      'Partial resolver failure',
    );
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('mutate still throws on errors even with data present', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation();
    mockGraphql.mockResolvedValue({
      data: { createItem: { id: '99' } },
      errors: [{ message: 'Constraint violation' }],
    });

    await expect(
      serverService.mutate('mutation CreateItem { createItem { id } }'),
    ).rejects.toThrow('Constraint violation');
    errorSpy.mockRestore();
  });
});
