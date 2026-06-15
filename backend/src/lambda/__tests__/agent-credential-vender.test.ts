/**
 * TDD Tests for agent-credential-vender Lambda
 */

const mockGetAccountContext = jest.fn();
const mockEnsureRole = jest.fn();
const mockAssumeScopedRole = jest.fn();

jest.mock('../../utils/policy-manager', () => {
  const MockPolicyManager = jest.fn().mockImplementation(() => ({
    getAccountContext: mockGetAccountContext,
    ensureRole: mockEnsureRole,
    assumeScopedRole: mockAssumeScopedRole,
  }));
  // Static methods
  (MockPolicyManager as any).getRoleName = (id: string, scope: string) => {
    const prefixes: Record<string, string> = { datastore: 'citadel-ds-', integration: 'citadel-int-', agent: 'citadel-agent-' };
    return `${prefixes[scope] || 'citadel-ds-'}${id}`;
  };
  (MockPolicyManager as any).buildPolicyDocument = (policies: any[]) => ({
    Version: '2012-10-17',
    Statement: policies.map(p => ({ Effect: 'Allow', Action: p.actions, Resource: p.resources })),
  });
  return { PolicyManager: MockPolicyManager };
});

import { handler } from '../agent-credential-vender';

describe('agent-credential-vender', () => {
  beforeEach(() => {
    mockGetAccountContext.mockClear();
    mockEnsureRole.mockClear();
    mockAssumeScopedRole.mockClear();

    mockGetAccountContext.mockResolvedValue({ accountId: '123456789012', region: 'us-west-2' });
    mockEnsureRole.mockResolvedValue(undefined);
    mockAssumeScopedRole.mockResolvedValue({
      accessKeyId: 'AKIA_SCOPED',
      secretAccessKey: 'SECRET_SCOPED',
      sessionToken: 'TOKEN_SCOPED',
    });
  });

  test('returns scoped credentials for an agent with model permissions', async () => {
    const result = await handler({
      agentId: 'agent-1',
      requiredPermissions: { models: ['anthropic.claude-sonnet-4-20250514'] },
    });

    expect(result.credentials).toBeDefined();
    expect(result.credentials!.accessKeyId).toBe('AKIA_SCOPED');

    expect(mockEnsureRole).toHaveBeenCalledTimes(1);
    expect(mockEnsureRole.mock.calls[0][0]).toBe('agent-1');
    expect(mockEnsureRole.mock.calls[0][3]).toBe('agent');

    const policies = mockEnsureRole.mock.calls[0][1];
    expect(policies[0].actions).toContain('bedrock:InvokeModel');
  });

  test('returns scoped credentials with datastore and integration access', async () => {
    const result = await handler({
      agentId: 'agent-2',
      requiredPermissions: {
        models: ['anthropic.claude-sonnet-4-20250514'],
        dataStores: ['ds-abc'],
        integrations: ['int-xyz'],
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.credentials).not.toBeNull();
    expect(mockGetAccountContext).toHaveBeenCalledTimes(1);
    expect(mockEnsureRole).toHaveBeenCalledTimes(1);
    const policies = mockEnsureRole.mock.calls[0][1];
    expect(policies).toHaveLength(3);
  });

  test('returns null credentials when no permissions declared', async () => {
    const result = await handler({ agentId: 'agent-3', requiredPermissions: {} });
    expect(result.credentials).toBeNull();
    expect(mockEnsureRole).not.toHaveBeenCalled();
  });

  test('returns null credentials when requiredPermissions is missing', async () => {
    const result = await handler({ agentId: 'agent-4' });
    expect(result.credentials).toBeNull();
  });

  test('returns error when PolicyManager fails', async () => {
    mockEnsureRole.mockRejectedValueOnce(new Error('IAM failure'));

    const result = await handler({
      agentId: 'agent-5',
      requiredPermissions: { models: ['anthropic.claude-sonnet-4-20250514'] },
    });

    expect(result.error).toContain('IAM failure');
    expect(result.credentials).toBeNull();
  });
});
