/**
 * Tests for agent-import discovery sources (US-IMP-002, discovery LOGIC).
 *
 * resolveSourceRef / tagScanDiscover / candidateFromManifest. SDK clients are
 * injected as fakes — there are NO live AWS calls. The tagging-API sender
 * double mirrors the injected-CommandSender pattern used by the agent-source
 * adapters (see lambda-invoke-adapter.discovery.test.ts).
 */
import fc from 'fast-check';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import {
  resolveSourceRef,
  tagScanDiscover,
  candidateFromManifest,
  UnsupportedSourceError,
  InvalidSourceRefError,
} from '../agent-discovery';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface SentCommand {
  constructor: { name: string };
  input: Record<string, unknown>;
}

/** ResourceGroupsTaggingAPIClient send() double dispatching on command name. */
function taggingSenderDouble(
  handlers: Record<string, (input: Record<string, unknown>) => unknown>,
): { send: jest.Mock } {
  const send = jest.fn((command: unknown) => {
    const c = command as SentCommand;
    const kind = c.constructor.name;
    const handler = handlers[kind];
    if (!handler) return Promise.reject(new Error(`unexpected command: ${kind}`));
    return Promise.resolve(handler(c.input));
  });
  return { send };
}

const RUNTIME_ARN =
  'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/abc123';
const LAMBDA_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:my-agent';
const BEDROCK_ALIAS_ARN =
  'arn:aws:bedrock:us-east-1:123456789012:agent-alias/AGENT1/ALIAS1';
const BEDROCK_AGENT_ARN = 'arn:aws:bedrock:us-east-1:123456789012:agent/AGENT1';

// ---------------------------------------------------------------------------
// resolveSourceRef
// ---------------------------------------------------------------------------

describe('resolveSourceRef', () => {
  it.each<[string, string, string]>([
    [RUNTIME_ARN, 'AGENTCORE_RUNTIME', 'agentcore_runtime'],
    [LAMBDA_ARN, 'LAMBDA_INVOKE', 'lambda'],
    [BEDROCK_ALIAS_ARN, 'BEDROCK_AGENT', 'bedrock_agent'],
    [BEDROCK_AGENT_ARN, 'BEDROCK_AGENT', 'bedrock_agent'],
    ['mcp://tools.example.com/sse', 'MCP', 'mcp'],
    ['mcp+https://tools.example.com/mcp', 'MCP', 'mcp'],
    ['https://api.example.com/agent', 'HTTP_ENDPOINT', 'http'],
    ['http://localhost:8080/agent', 'HTTP_ENDPOINT', 'http'],
  ])('maps %s -> protocol/substrate', (ref, protocol, substrate) => {
    const r = resolveSourceRef(ref);
    expect(r.protocol).toBe(protocol);
    expect(r.substrate).toBe(substrate);
  });

  it('round-trips the target to the input ARN', () => {
    expect(resolveSourceRef(LAMBDA_ARN).target).toBe(LAMBDA_ARN);
    expect(resolveSourceRef(RUNTIME_ARN).target).toBe(RUNTIME_ARN);
  });

  it('keeps the mcp:// URL as the target verbatim', () => {
    expect(resolveSourceRef('mcp://x/y').target).toBe('mcp://x/y');
  });

  it('strips the mcp+ flag so the target is a usable https URL', () => {
    expect(resolveSourceRef('mcp+https://x/y').target).toBe('https://x/y');
  });

  it.each([
    'arn:aws:ecs:us-east-1:123456789012:task/abc',
    // EKS CLUSTER ARNs now resolve (US-IMP-019); a non-cluster EKS ARN
    // (nodegroup/fargateprofile) stays unsupported.
    'arn:aws:eks:us-east-1:123456789012:nodegroup/my-cluster/my-ng/abc12345',
    'arn:aws:ec2:us-east-1:123456789012:instance/i-abc',
    'arn:aws:states:us-east-1:123456789012:stateMachine:abc',
    'arn:aws:sagemaker:us-east-1:123456789012:endpoint/abc',
  ])('throws UnsupportedSourceError for %s', (arn) => {
    expect(() => resolveSourceRef(arn)).toThrow(UnsupportedSourceError);
  });

  it("UnsupportedSourceError names the substrate and 'phase 1'", () => {
    expect(() => resolveSourceRef('arn:aws:ecs:us-east-1:1:task/x')).toThrow(
      /ecs not supported in phase 1/,
    );
    const err = (() => {
      try {
        resolveSourceRef('arn:aws:eks:us-east-1:1:nodegroup/c/n/abc12345');
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(UnsupportedSourceError);
    expect((err as UnsupportedSourceError).substrate).toBe('eks');
  });

  it.each(['garbage', '', '   ', 'ftp://nope', 'not:an:arn', 'arn:aws:lambda'])(
    'throws InvalidSourceRefError for unparseable %p',
    (ref) => {
      expect(() => resolveSourceRef(ref)).toThrow(InvalidSourceRefError);
    },
  );

  it('error classes are distinct Error subtypes', () => {
    expect(new UnsupportedSourceError('ecs')).toBeInstanceOf(Error);
    expect(new InvalidSourceRefError('x')).toBeInstanceOf(Error);
    expect(new InvalidSourceRefError('x')).not.toBeInstanceOf(UnsupportedSourceError);
  });
});

// ---------------------------------------------------------------------------
// resolveSourceRef — property test (fast-check)
// ---------------------------------------------------------------------------

describe('resolveSourceRef property: phase-1 ARNs round-trip', () => {
  // ARNs map to exactly these three substrates; URL forms add mcp/http.
  const PHASE1_ARN_SUBSTRATES = ['agentcore_runtime', 'lambda', 'bedrock_agent'];

  // Build ARN id segments from a safe charset (no ':' or '/' that would break
  // ARN parsing). fc.array + fc.constantFrom are stable across fast-check majors.
  const idArb = fc
    .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')), {
      minLength: 1,
      maxLength: 20,
    })
    .map((chars) => chars.join(''));
  const regionArb = fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-2');
  const acctArb = fc
    .integer({ min: 0, max: 999999999999 })
    .map((n) => String(n).padStart(12, '0'));

  const arnArb = fc.oneof(
    fc
      .tuple(regionArb, acctArb, idArb)
      .map(([r, a, id]) => `arn:aws:bedrock-agentcore:${r}:${a}:runtime/${id}`),
    fc
      .tuple(regionArb, acctArb, idArb)
      .map(([r, a, id]) => `arn:aws:lambda:${r}:${a}:function:${id}`),
    fc
      .tuple(regionArb, acctArb, idArb)
      .map(([r, a, id]) => `arn:aws:bedrock:${r}:${a}:agent/${id}`),
    fc
      .tuple(regionArb, acctArb, idArb, idArb)
      .map(([r, a, id, al]) => `arn:aws:bedrock:${r}:${a}:agent-alias/${id}/${al}`),
  );

  it('target equals the input ARN and substrate is a phase-1 ARN substrate', () => {
    fc.assert(
      fc.property(arnArb, (arn) => {
        const r = resolveSourceRef(arn);
        expect(r.target).toBe(arn);
        expect(PHASE1_ARN_SUBSTRATES).toContain(r.substrate);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// tagScanDiscover
// ---------------------------------------------------------------------------

describe('tagScanDiscover', () => {
  const fixedNow = (): Date => new Date('2026-06-26T00:00:00.000Z');

  it('paginates across two pages and returns external candidates across substrates', async () => {
    const pages: Record<string, unknown>[] = [
      {
        ResourceTagMappingList: [
          { ResourceARN: LAMBDA_ARN },
          { ResourceARN: RUNTIME_ARN },
        ],
        PaginationToken: 'page2',
      },
      {
        ResourceTagMappingList: [{ ResourceARN: BEDROCK_ALIAS_ARN }],
        PaginationToken: '', // empty token => last page
      },
    ];
    let call = 0;
    const sender = taggingSenderDouble({ GetResourcesCommand: () => pages[call++] });

    const candidates = await tagScanDiscover(
      { region: 'us-east-1' },
      { sender, now: fixedNow },
    );

    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.origin.substrate)).toEqual([
      'lambda',
      'agentcore_runtime',
      'bedrock_agent',
    ]);
    expect(candidates.every((c) => c.origin.ownership === 'external')).toBe(true);
    expect(candidates[0].reference).toBe(LAMBDA_ARN);
    expect(sender.send).toHaveBeenCalledTimes(2);
  });

  it('uses the default TagFilter citadel:agent=true', async () => {
    const sender = taggingSenderDouble({
      GetResourcesCommand: () => ({ ResourceTagMappingList: [], PaginationToken: '' }),
    });
    await tagScanDiscover({}, { sender });
    const cmd = sender.send.mock.calls[0][0] as SentCommand;
    expect(cmd.input.TagFilters).toEqual([{ Key: 'citadel:agent', Values: ['true'] }]);
  });

  it('honours a custom tagKey/tagValue', async () => {
    const sender = taggingSenderDouble({
      GetResourcesCommand: () => ({ ResourceTagMappingList: [], PaginationToken: '' }),
    });
    await tagScanDiscover({ tagKey: 'team', tagValue: 'agents' }, { sender });
    const cmd = sender.send.mock.calls[0][0] as SentCommand;
    expect(cmd.input.TagFilters).toEqual([{ Key: 'team', Values: ['agents'] }]);
  });

  it('skips an unsupported-substrate ARN without throwing (logs + continues)', async () => {
    const warn = jest.fn();
    const sender = taggingSenderDouble({
      GetResourcesCommand: () => ({
        ResourceTagMappingList: [
          { ResourceARN: LAMBDA_ARN },
          { ResourceARN: 'arn:aws:ecs:us-east-1:123456789012:task/abc' },
          { ResourceARN: BEDROCK_AGENT_ARN },
        ],
        PaginationToken: '',
      }),
    });

    const candidates = await tagScanDiscover({}, { sender, logger: { warn } });

    expect(candidates.map((c) => c.origin.substrate)).toEqual(['lambda', 'bedrock_agent']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('derives displayName/region/account and stamps discoveredAt from the injected clock', async () => {
    const sender = taggingSenderDouble({
      GetResourcesCommand: () => ({
        ResourceTagMappingList: [{ ResourceARN: LAMBDA_ARN }],
        PaginationToken: '',
      }),
    });
    const [c] = await tagScanDiscover({}, { sender, now: fixedNow });
    expect(c.displayName).toBe('my-agent');
    expect(c.origin.region).toBe('us-east-1');
    expect(c.origin.account).toBe('123456789012');
    expect(c.origin.discoveredAt).toBe('2026-06-26T00:00:00.000Z');
  });

  it('skips mappings with no ResourceARN', async () => {
    const sender = taggingSenderDouble({
      GetResourcesCommand: () => ({
        ResourceTagMappingList: [{ Tags: [] }, { ResourceARN: LAMBDA_ARN }],
        PaginationToken: '',
      }),
    });
    const candidates = await tagScanDiscover({}, { sender });
    expect(candidates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// tagScanDiscover — cross-account (Phase-2)
//
// When scope.discoveryRoleArn is set, assume that operator-supplied read-only
// role in the TARGET account (externalId-gated) and build the tagging-API
// client WITH the assumed credentials, then run the existing GetResources
// scan THERE. Same-account (no discoveryRoleArn) stays byte-identical: no
// AssumeRole, default/injected client. The STS client + sender factory are
// injectable so no test reaches live AWS, and the assumed credentials are
// never logged.
// ---------------------------------------------------------------------------

describe('tagScanDiscover cross-account', () => {
  const fixedNow = (): Date => new Date('2026-06-26T00:00:00.000Z');
  const DISCOVERY_ROLE_ARN = 'arn:aws:iam::222233334444:role/citadel-readonly-discovery';
  const EXTERNAL_ID = 'citadel-ext-scan-1';
  const CREDS = {
    AccessKeyId: 'AKIA_SCAN_EXAMPLE',
    SecretAccessKey: 'super-secret-scan-key',
    SessionToken: 'scan-session-token',
    Expiration: new Date('2030-01-01T00:00:00.000Z'),
  };

  function stsStub(creds: unknown = CREDS): { client: STSClient; send: jest.Mock } {
    const send = jest.fn(async (command: unknown) => {
      if (command instanceof AssumeRoleCommand) {
        return { Credentials: creds };
      }
      throw new Error('unexpected STS command');
    });
    return { client: { send } as unknown as STSClient, send };
  }

  it('assumes the discovery role (role + ExternalId) and scans with the assumed credentials', async () => {
    const { client, send } = stsStub();
    const sender = taggingSenderDouble({
      GetResourcesCommand: () => ({
        ResourceTagMappingList: [{ ResourceARN: LAMBDA_ARN }],
        PaginationToken: '',
      }),
    });
    const captured: { region?: string; credentials?: unknown } = {};

    const candidates = await tagScanDiscover(
      {
        region: 'us-east-1',
        discoveryRoleArn: DISCOVERY_ROLE_ARN,
        discoveryExternalId: EXTERNAL_ID,
      },
      {
        stsClient: client,
        // Inline factory: contextually typed from TagScanDeps so the assumed
        // creds reach the (would-be) tagging client and we can assert them.
        senderFactory: (region, credentials) => {
          captured.region = region;
          captured.credentials = credentials;
          return sender;
        },
        now: fixedNow,
      },
    );

    // AssumeRole called once with the role + external id.
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as AssumeRoleCommand;
    expect(command).toBeInstanceOf(AssumeRoleCommand);
    expect(command.input.RoleArn).toBe(DISCOVERY_ROLE_ARN);
    expect(command.input.ExternalId).toBe(EXTERNAL_ID);

    // Tagging client built WITH the assumed credentials, in the target region.
    expect(captured.region).toBe('us-east-1');
    expect(captured.credentials).toEqual({
      accessKeyId: CREDS.AccessKeyId,
      secretAccessKey: CREDS.SecretAccessKey,
      sessionToken: CREDS.SessionToken,
      expiration: CREDS.Expiration,
    });

    // Candidates returned from the cross-account scan.
    expect(candidates).toHaveLength(1);
    expect(candidates[0].reference).toBe(LAMBDA_ARN);
    expect(candidates[0].origin.ownership).toBe('external');
  });

  it('paginates and maps resolveSourceRef candidates across the cross-account scan', async () => {
    const { client } = stsStub();
    const pages: Record<string, unknown>[] = [
      {
        ResourceTagMappingList: [
          { ResourceARN: LAMBDA_ARN },
          { ResourceARN: 'arn:aws:ecs:us-east-1:222233334444:task/abc' }, // skipped
        ],
        PaginationToken: 'page2',
      },
      {
        ResourceTagMappingList: [{ ResourceARN: BEDROCK_AGENT_ARN }],
        PaginationToken: '',
      },
    ];
    let call = 0;
    const sender = taggingSenderDouble({ GetResourcesCommand: () => pages[call++] });
    const warn = jest.fn();

    const candidates = await tagScanDiscover(
      {
        region: 'us-east-1',
        discoveryRoleArn: DISCOVERY_ROLE_ARN,
        discoveryExternalId: EXTERNAL_ID,
      },
      { stsClient: client, senderFactory: () => sender, now: fixedNow, logger: { warn } },
    );

    expect(candidates.map((c) => c.origin.substrate)).toEqual(['lambda', 'bedrock_agent']);
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1); // the unsupported ECS arn
  });

  it('does NOT assume a role when discoveryRoleArn is absent (same-account, unchanged)', async () => {
    const { client, send } = stsStub();
    const sender = taggingSenderDouble({
      GetResourcesCommand: () => ({
        ResourceTagMappingList: [{ ResourceARN: LAMBDA_ARN }],
        PaginationToken: '',
      }),
    });

    const candidates = await tagScanDiscover(
      { region: 'us-east-1' }, // no discoveryRoleArn
      { stsClient: client, sender, now: fixedNow },
    );

    expect(send).not.toHaveBeenCalled(); // no AssumeRole on the same-account path
    expect(candidates).toHaveLength(1);
    expect(candidates[0].reference).toBe(LAMBDA_ARN);
  });

  it('returns an empty result and warns (no crash) when the cross-account assume fails', async () => {
    const send = jest.fn(async () => {
      throw new Error('AccessDenied: not authorized to perform sts:AssumeRole');
    });
    const client = { send } as unknown as STSClient;
    const warn = jest.fn();

    const candidates = await tagScanDiscover(
      {
        region: 'us-east-1',
        discoveryRoleArn: DISCOVERY_ROLE_ARN,
        discoveryExternalId: EXTERNAL_ID,
      },
      {
        stsClient: client,
        senderFactory: () => {
          throw new Error('sender factory must not be reached when the assume fails');
        },
        logger: { warn },
      },
    );

    expect(candidates).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain(DISCOVERY_ROLE_ARN);
  });

  it('never logs the assumed credentials', async () => {
    const { client } = stsStub();
    const sender = taggingSenderDouble({
      GetResourcesCommand: () => ({
        ResourceTagMappingList: [{ ResourceARN: LAMBDA_ARN }],
        PaginationToken: '',
      }),
    });
    const spies = [
      jest.spyOn(console, 'log').mockImplementation(() => {}),
      jest.spyOn(console, 'warn').mockImplementation(() => {}),
      jest.spyOn(console, 'error').mockImplementation(() => {}),
    ];

    try {
      await tagScanDiscover(
        {
          region: 'us-east-1',
          discoveryRoleArn: DISCOVERY_ROLE_ARN,
          discoveryExternalId: EXTERNAL_ID,
        },
        { stsClient: client, senderFactory: () => sender },
      );
      const logged = spies
        .flatMap((s) => s.mock.calls)
        .map((args) =>
          args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '),
        )
        .join('\n');
      expect(logged).not.toContain(CREDS.SecretAccessKey);
      expect(logged).not.toContain(CREDS.SessionToken);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

// ---------------------------------------------------------------------------
// candidateFromManifest
// ---------------------------------------------------------------------------

describe('candidateFromManifest', () => {
  const validManifest = {
    name: 'External Billing Agent',
    invocation: {
      protocol: 'LAMBDA_INVOKE',
      target: 'arn:aws:lambda:us-east-1:123456789012:function:billing',
      auth: { mode: 'SIGV4' },
      mode: 'sync',
    },
    origin: {
      sourceArn: 'arn:aws:lambda:us-east-1:123456789012:function:billing',
      substrate: 'lambda',
      region: 'us-east-1',
      discoveredAt: '2026-06-01T00:00:00.000Z',
      ownership: 'external',
    },
  };

  it('produces an external candidate from a valid manifest object', () => {
    const { candidate, descriptor } = candidateFromManifest(validManifest);
    expect(candidate.origin.ownership).toBe('external');
    expect(candidate.origin.substrate).toBe('lambda');
    expect(candidate.reference).toBe(validManifest.invocation.target);
    expect(candidate.displayName).toBe('External Billing Agent');
    expect(descriptor).toEqual(validManifest);
  });

  it('parses a valid manifest passed as a JSON string', () => {
    const { candidate } = candidateFromManifest(JSON.stringify(validManifest));
    expect(candidate.origin.ownership).toBe('external');
    expect(candidate.origin.substrate).toBe('lambda');
  });

  it('derives substrate from the protocol when origin.substrate is absent', () => {
    const manifest = {
      name: 'MCP Tool Agent',
      invocation: { protocol: 'MCP', target: 'mcp://tools/x', auth: { mode: 'NONE' }, mode: 'sync' },
      origin: { ownership: 'external' },
    };
    const { candidate } = candidateFromManifest(manifest);
    expect(candidate.origin.substrate).toBe('mcp');
    expect(candidate.origin.ownership).toBe('external');
    expect(candidate.reference).toBe('mcp://tools/x'); // falls back to invocation.target
  });

  it('throws listing the field when invocation.protocol is missing', () => {
    const bad = {
      ...validManifest,
      invocation: { target: 'x', auth: { mode: 'NONE' }, mode: 'sync' },
    };
    expect(() => candidateFromManifest(bad)).toThrow(/invocation\.protocol/);
    expect(() => candidateFromManifest(bad)).toThrow(InvalidSourceRefError);
  });

  it('throws InvalidSourceRefError on malformed JSON', () => {
    expect(() => candidateFromManifest('{not json')).toThrow(InvalidSourceRefError);
  });
});
