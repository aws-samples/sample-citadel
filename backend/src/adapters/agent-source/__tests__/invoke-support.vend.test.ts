/**
 * TDD: vendImportCredentials — the shared cross-account credential-vend helper
 * that every agent-source adapter's vendCredentials() delegates to
 * (Phase 2, agent-import). The PolicyManager is injected so these tests never
 * reach STS/IAM.
 */
import { vendImportCredentials } from '../invoke-support';
import type { PolicyManager } from '../../../utils/policy-manager';
import type { AgentInvocationBlock } from '../base';

const ROLE_ARN = 'arn:aws:iam::222233334444:role/CustomerInvokeRole';
const EXTERNAL_ID = 'citadel-ext-abc123';
const ACCOUNT = '222233334444';

function invocation(over: Partial<AgentInvocationBlock> = {}): AgentInvocationBlock {
  return {
    protocol: 'LAMBDA_INVOKE',
    target: 'arn:aws:lambda:us-east-1:222233334444:function:agent',
    auth: { mode: 'NONE' },
    mode: 'sync',
    ...over,
  };
}

describe('vendImportCredentials', () => {
  it('assumes the cross-account role with the externalId + account and maps the creds', async () => {
    const assumeScopedRole = jest.fn().mockResolvedValue({
      accessKeyId: 'AKIA',
      secretAccessKey: 'SECRET',
      sessionToken: 'TOKEN',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    const policyManager = { assumeScopedRole } as unknown as PolicyManager;

    const creds = await vendImportCredentials(
      invocation({ roleArn: ROLE_ARN, externalId: EXTERNAL_ID, account: ACCOUNT }),
      { policyManager },
    );

    expect(assumeScopedRole).toHaveBeenCalledTimes(1);
    const args = assumeScopedRole.mock.calls[0];
    // The target account (2nd positional), the cross-account role, and the
    // externalId are all forwarded to assumeScopedRole.
    expect(args[1]).toBe(ACCOUNT);
    expect(args).toContain(ROLE_ARN);
    expect(args).toContain(EXTERNAL_ID);

    expect(creds).toEqual({
      roleArn: ROLE_ARN,
      expiresAt: '2030-01-01T00:00:00.000Z',
      accessKeyId: 'AKIA',
      secretAccessKey: 'SECRET',
      sessionToken: 'TOKEN',
    });
  });

  it('forwards an absent externalId as undefined (still assumes the role)', async () => {
    const assumeScopedRole = jest.fn().mockResolvedValue({
      accessKeyId: 'AKIA',
      secretAccessKey: 'SECRET',
      sessionToken: 'TOKEN',
    });
    const policyManager = { assumeScopedRole } as unknown as PolicyManager;

    await vendImportCredentials(
      invocation({ roleArn: ROLE_ARN, account: ACCOUNT }),
      { policyManager },
    );

    expect(assumeScopedRole).toHaveBeenCalledTimes(1);
    // externalId is the last positional argument and must be undefined here.
    const args = assumeScopedRole.mock.calls[0];
    expect(args[args.length - 1]).toBeUndefined();
  });

  it('returns minimal credentials and does NOT assume when no roleArn is configured', async () => {
    const assumeScopedRole = jest.fn();
    const policyManager = { assumeScopedRole } as unknown as PolicyManager;

    const creds = await vendImportCredentials(invocation(), { policyManager });

    expect(assumeScopedRole).not.toHaveBeenCalled();
    expect(creds).toEqual({});
  });
});
