/**
 * Unit tests for the reusable in-process IAM trust-path core
 * (backend/src/utils/trust-path.ts).
 *
 * These cover (a) the pure projection helpers moved out of
 * governance-ui-resolver and (b) the new `computeTrustPath` entry point used
 * by the imported-agent activation path. The IAM client is always injected as
 * a hand-rolled stub so no test ever reaches live AWS.
 */
import {
  GetRoleCommand,
  GetRolePolicyCommand,
  type IAMClient,
} from '@aws-sdk/client-iam';
import {
  parseTrustPolicyPrincipals,
  projectInlinePolicyDocument,
  roleNameFromArn,
  extractCrossAccountRoleArn,
  accountIdFromArn,
  isCrossAccountRoleArn,
  fetchTrustPathHop,
  computeTrustPath,
} from '../trust-path';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function trustPolicy(principals: string | string[]): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Principal: { AWS: principals }, Action: 'sts:AssumeRole' },
    ],
  });
}

function inlinePolicy(actions: string[], resources: string[]): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: actions, Resource: resources }],
  });
}

interface StubHandlers {
  getRole?: (roleName: string) => unknown;
  getRolePolicy?: (roleName: string) => unknown;
}

function notFound(): Error {
  const err = new Error('NoSuchEntity') as Error & { name: string };
  err.name = 'NoSuchEntityException';
  return err;
}

/**
 * Builds a hand-rolled IAM client stub. The returned `send` spy resolves
 * GetRole / GetRolePolicy via the provided handlers (throwing NoSuchEntity
 * when a handler is omitted), and rejects any other command.
 */
function iamStub(handlers: StubHandlers): { client: IAMClient; send: jest.Mock } {
  const send = jest.fn(async (command: unknown) => {
    if (command instanceof GetRoleCommand) {
      if (!handlers.getRole) throw notFound();
      return handlers.getRole(command.input.RoleName ?? '');
    }
    if (command instanceof GetRolePolicyCommand) {
      if (!handlers.getRolePolicy) throw notFound();
      return handlers.getRolePolicy(command.input.RoleName ?? '');
    }
    throw new Error(`unexpected command: ${(command as { constructor: { name: string } }).constructor.name}`);
  });
  return { client: { send } as unknown as IAMClient, send };
}

const ROLE_ARN = 'arn:aws:iam::123456789012:role/citadel-agent-a1';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('parseTrustPolicyPrincipals', () => {
  it('collects a single string Principal.AWS', () => {
    expect(parseTrustPolicyPrincipals(trustPolicy('arn:aws:iam::1:role/x'))).toEqual([
      'arn:aws:iam::1:role/x',
    ]);
  });

  it('collects an array Principal.AWS', () => {
    expect(
      parseTrustPolicyPrincipals(trustPolicy(['arn:aws:iam::1:role/a', 'arn:aws:iam::1:role/b'])),
    ).toEqual(['arn:aws:iam::1:role/a', 'arn:aws:iam::1:role/b']);
  });

  it('returns [] for undefined or malformed JSON', () => {
    expect(parseTrustPolicyPrincipals(undefined)).toEqual([]);
    expect(parseTrustPolicyPrincipals('{not json')).toEqual([]);
  });
});

describe('projectInlinePolicyDocument', () => {
  it('coerces single-string Action/Resource into arrays and preserves Condition', () => {
    const doc = JSON.stringify({
      Statement: [
        {
          Effect: 'Allow',
          Action: 's3:GetObject',
          Resource: 'arn:aws:s3:::b/*',
          Condition: { StringEquals: { 'aws:username': 'x' } },
        },
      ],
    });
    const projected = projectInlinePolicyDocument(doc);
    expect(projected).toHaveLength(1);
    expect(projected[0].actions).toEqual(['s3:GetObject']);
    expect(projected[0].resources).toEqual(['arn:aws:s3:::b/*']);
    expect(projected[0].effect).toBe('Allow');
    expect(projected[0].conditionsJson).toBe(
      JSON.stringify({ StringEquals: { 'aws:username': 'x' } }),
    );
  });

  it('returns [] for undefined or malformed JSON', () => {
    expect(projectInlinePolicyDocument(undefined)).toEqual([]);
    expect(projectInlinePolicyDocument('nope')).toEqual([]);
  });
});

describe('roleNameFromArn', () => {
  it('extracts the trailing role name', () => {
    expect(roleNameFromArn('arn:aws:iam::1:role/citadel-agent-a1')).toBe('citadel-agent-a1');
  });

  it('extracts the final path segment', () => {
    expect(roleNameFromArn('arn:aws:iam::1:role/path/to/MyRole')).toBe('MyRole');
  });

  it('returns the input unchanged when there is no slash', () => {
    expect(roleNameFromArn('weird')).toBe('weird');
  });
});

describe('extractCrossAccountRoleArn', () => {
  it('reads the top-level field', () => {
    expect(extractCrossAccountRoleArn({ crossAccountRoleArn: 'arn:a' })).toBe('arn:a');
  });

  it('reads a nested config field', () => {
    expect(extractCrossAccountRoleArn({ config: { crossAccountRoleArn: 'arn:b' } })).toBe('arn:b');
  });

  it('reads from customDescriptorContent JSON', () => {
    expect(
      extractCrossAccountRoleArn({
        customDescriptorContent: JSON.stringify({ crossAccountRoleArn: 'arn:c' }),
      }),
    ).toBe('arn:c');
  });

  it('returns null for null / missing / malformed', () => {
    expect(extractCrossAccountRoleArn(null)).toBeNull();
    expect(extractCrossAccountRoleArn({})).toBeNull();
    expect(extractCrossAccountRoleArn({ customDescriptorContent: '{bad' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// accountIdFromArn / isCrossAccountRoleArn (Phase-2 cross-account detection)
// ---------------------------------------------------------------------------

describe('accountIdFromArn', () => {
  it('extracts the 12-digit account segment from a role ARN', () => {
    expect(accountIdFromArn('arn:aws:iam::123456789012:role/citadel-agent-a1')).toBe(
      '123456789012',
    );
  });

  it('extracts the account from an ARN with a pathed role name', () => {
    expect(accountIdFromArn('arn:aws:iam::999988887777:role/path/to/Role')).toBe('999988887777');
  });

  it('returns null for a non-string input', () => {
    expect(accountIdFromArn(undefined)).toBeNull();
    expect(accountIdFromArn(null)).toBeNull();
  });

  it('returns null for a malformed / non-ARN string', () => {
    expect(accountIdFromArn('not-an-arn')).toBeNull();
    expect(accountIdFromArn('arn:aws:iam')).toBeNull();
  });

  it('returns null when the account segment is empty (e.g. an S3 ARN)', () => {
    expect(accountIdFromArn('arn:aws:s3:::bucket/key')).toBeNull();
  });
});

describe('isCrossAccountRoleArn', () => {
  const SAME_ACCOUNT = 'arn:aws:iam::111111111111:role/citadel-agent';
  const OTHER_ACCOUNT = 'arn:aws:iam::222222222222:role/external-agent';

  it('returns false when the role ARN lives in the deployment account', () => {
    expect(isCrossAccountRoleArn(SAME_ACCOUNT, '111111111111')).toBe(false);
  });

  it('returns true when the role ARN lives in a different account', () => {
    expect(isCrossAccountRoleArn(OTHER_ACCOUNT, '111111111111')).toBe(true);
  });

  it('returns false (cannot determine) when the deployment account is missing or blank', () => {
    expect(isCrossAccountRoleArn(OTHER_ACCOUNT, undefined)).toBe(false);
    expect(isCrossAccountRoleArn(OTHER_ACCOUNT, null)).toBe(false);
    expect(isCrossAccountRoleArn(OTHER_ACCOUNT, '')).toBe(false);
  });

  it('returns false (cannot determine) when the role ARN account is unparseable', () => {
    expect(isCrossAccountRoleArn('not-an-arn', '111111111111')).toBe(false);
    expect(isCrossAccountRoleArn(undefined, '111111111111')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchTrustPathHop
// ---------------------------------------------------------------------------

describe('fetchTrustPathHop', () => {
  it('builds a hop with principals + projected inline policy when both calls succeed', async () => {
    const { client, send } = iamStub({
      getRole: (name) => ({
        Role: { RoleName: name, AssumeRolePolicyDocument: trustPolicy('arn:aws:iam::1:role/x') },
      }),
      getRolePolicy: () => ({
        PolicyName: 'DataStoreAccess',
        PolicyDocument: inlinePolicy(['s3:GetObject', 's3:PutObject'], ['arn:aws:s3:::b/*']),
      }),
    });

    const result = await fetchTrustPathHop(client, ROLE_ARN, 'agent');

    expect(send).toHaveBeenCalledTimes(2);
    expect(result.roleFound).toBe(true);
    expect(result.inlinePolicyFound).toBe(true);
    expect(result.hop.scope).toBe('agent');
    expect(result.hop.name).toBe('citadel-agent-a1');
    expect(result.hop.trustPolicyPrincipals).toEqual(['arn:aws:iam::1:role/x']);
    expect(result.hop.inlinePolicyName).toBe('DataStoreAccess');
    expect(result.hop.totalActions).toBe(2);
    expect(result.hop.totalResources).toBe(1);
    expect(result.notes).toEqual([]);
  });

  it('marks roleFound=false with a note + empty principals when GetRole throws', async () => {
    const { client } = iamStub({}); // GetRole omitted → NoSuchEntity
    const result = await fetchTrustPathHop(client, ROLE_ARN, 'agent');

    expect(result.roleFound).toBe(false);
    expect(result.hop.trustPolicyPrincipals).toEqual([]);
    expect(result.hop.inlinePolicy).toEqual([]);
    expect(result.notes.some((n) => n.includes('not found') && n.includes(ROLE_ARN))).toBe(true);
  });

  it('emits an empty inline policy + note when GetRolePolicy throws', async () => {
    const { client } = iamStub({
      getRole: (name) => ({
        Role: { RoleName: name, AssumeRolePolicyDocument: trustPolicy('arn:aws:iam::1:role/x') },
      }),
      // getRolePolicy omitted → NoSuchEntity
    });
    const result = await fetchTrustPathHop(client, ROLE_ARN, 'agent');

    expect(result.roleFound).toBe(true);
    expect(result.inlinePolicyFound).toBe(false);
    expect(result.hop.inlinePolicy).toEqual([]);
    expect(result.hop.inlinePolicyName).toBeNull();
    expect(result.notes.some((n) => n.includes('Inline policy not present') && n.includes(ROLE_ARN))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeTrustPath
// ---------------------------------------------------------------------------

describe('computeTrustPath', () => {
  it('returns clean:true and findings:[] for a role with scoped policies', async () => {
    const { client, send } = iamStub({
      getRole: (name) => ({
        Role: { RoleName: name, AssumeRolePolicyDocument: trustPolicy('arn:aws:iam::1:role/x') },
      }),
      getRolePolicy: () => ({
        PolicyName: 'DataStoreAccess',
        PolicyDocument: inlinePolicy(['s3:GetObject'], ['arn:aws:s3:::b/*']),
      }),
    });

    const result = await computeTrustPath(ROLE_ARN, { iamClient: client });

    expect(result.clean).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.hops).toHaveLength(1);
    expect(send).toHaveBeenCalled(); // injected client used — no live AWS
  });

  it('flags a wildcard action as an over-broad finding (clean:false)', async () => {
    const { client } = iamStub({
      getRole: (name) => ({
        Role: { RoleName: name, AssumeRolePolicyDocument: trustPolicy('arn:aws:iam::1:role/x') },
      }),
      getRolePolicy: () => ({
        PolicyName: 'DataStoreAccess',
        PolicyDocument: inlinePolicy(['s3:*'], ['arn:aws:s3:::b/*']),
      }),
    });

    const result = await computeTrustPath(ROLE_ARN, { iamClient: client });

    expect(result.clean).toBe(false);
    expect(result.findings.some((f) => f.startsWith('over-broad-action'))).toBe(true);
  });

  it('flags a wildcard resource as an over-broad finding (clean:false)', async () => {
    const { client } = iamStub({
      getRole: (name) => ({
        Role: { RoleName: name, AssumeRolePolicyDocument: trustPolicy('arn:aws:iam::1:role/x') },
      }),
      getRolePolicy: () => ({
        PolicyName: 'DataStoreAccess',
        PolicyDocument: inlinePolicy(['s3:GetObject'], ['*']),
      }),
    });

    const result = await computeTrustPath(ROLE_ARN, { iamClient: client });

    expect(result.clean).toBe(false);
    expect(result.findings.some((f) => f.startsWith('over-broad-resource'))).toBe(true);
  });

  it('surfaces a GetRole NotFound as a role-not-found finding (clean:false)', async () => {
    const { client } = iamStub({}); // GetRole throws NoSuchEntity
    const result = await computeTrustPath(ROLE_ARN, { iamClient: client });

    expect(result.clean).toBe(false);
    expect(result.findings.some((f) => f.startsWith('role-not-found'))).toBe(true);
  });

  it('flags a role with no AWS trust principals as missing-trust', async () => {
    const { client } = iamStub({
      getRole: (name) => ({
        Role: { RoleName: name, AssumeRolePolicyDocument: JSON.stringify({ Statement: [] }) },
      }),
      getRolePolicy: () => ({
        PolicyName: 'DataStoreAccess',
        PolicyDocument: inlinePolicy(['s3:GetObject'], ['arn:aws:s3:::b/*']),
      }),
    });

    const result = await computeTrustPath(ROLE_ARN, { iamClient: client });

    expect(result.clean).toBe(false);
    expect(result.findings.some((f) => f.startsWith('missing-trust'))).toBe(true);
  });

  it('returns an invalid-role-arn finding without calling IAM for an empty arn', async () => {
    const { client, send } = iamStub({});
    const result = await computeTrustPath('', { iamClient: client });

    expect(result.clean).toBe(false);
    expect(result.findings.some((f) => f.startsWith('invalid-role-arn'))).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('appends a cross-account hop when crossAccountRoleArn is supplied', async () => {
    const { client, send } = iamStub({
      getRole: (name) => ({
        Role: { RoleName: name, AssumeRolePolicyDocument: trustPolicy('arn:aws:iam::1:role/x') },
      }),
      getRolePolicy: () => ({
        PolicyName: 'DataStoreAccess',
        PolicyDocument: inlinePolicy(['s3:GetObject'], ['arn:aws:s3:::b/*']),
      }),
    });

    const result = await computeTrustPath(ROLE_ARN, {
      iamClient: client,
      crossAccountRoleArn: 'arn:aws:iam::999:role/cross',
    });

    expect(result.hops).toHaveLength(2);
    expect(result.hops[1].scope).toBe('cross-account');
    expect(send).toHaveBeenCalledTimes(4); // 2 commands per hop
  });
});
