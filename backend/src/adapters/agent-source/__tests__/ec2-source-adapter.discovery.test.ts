/**
 * Discovery / describe / healthCheck tests for the EC2 source adapter
 * (US-IMP-020). EC2 is a DISCOVERY SUBSTRATE: discover/describe/healthCheck are
 * EC2-specific (they enumerate running INSTANCES and resolve the AGENT's HTTP
 * endpoint), but the resulting candidate's INVOCATION protocol is HTTP_ENDPOINT
 * — invoke/test flow through the existing HTTP adapter, so this adapter's
 * invoke()/vendCredentials() are NotImplemented stubs. The EC2 + ELBv2 clients
 * and global fetch are injected as fakes — there are NO live AWS calls and NO
 * live network.
 *
 * NOTE the difference from EKS/ECS: ec2 DescribeInstances returns RESERVATIONS
 * (each with an OwnerId used as the candidate account) wrapping Instances; the
 * instance ARN is CONSTRUCTED (`arn:aws:ec2:<region>:<OwnerId>:instance/<id>`);
 * EC2 instance `Tags` is a {Key,Value}[] array; the endpoint resolves via the
 * `citadel:endpoint` tag, else a target group the instance is registered in
 * (DescribeTargetGroups -> DescribeTargetHealth match -> ALB DNS), else the
 * instance's PRIVATE DNS/IP + an operator note (NEVER a guessed port), else ''.
 * Tier-1 describe NEVER surfaces user-data, the SSH key name, or any secret.
 */
import { Ec2SourceAdapter } from '../ec2-source-adapter';
import { NotImplementedError } from '../not-implemented';
import type { AgentInvocationBlock } from '../base';

interface SentCommand {
  constructor: { name: string };
  input: Record<string, unknown>;
}

/** AWS SDK client send() double that dispatches on the command class name. */
function senderDouble(
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

const asFetch = (fn: jest.Mock): typeof fetch => fn as unknown as typeof fetch;

const INSTANCE_ID = 'i-0123456789abcdef0';
const ACCOUNT = '123456789012';
const INSTANCE_ARN = `arn:aws:ec2:us-east-1:${ACCOUNT}:instance/${INSTANCE_ID}`;
const TG_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/my-tg/abc123';
const LB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-alb/def456';
const LB_DNS = 'my-alb-123456.us-east-1.elb.amazonaws.com';
const PRIVATE_DNS = 'ip-10-0-1-23.us-east-1.compute.internal';
/** SSH key-pair name — key MATERIAL reference; must NEVER appear in any field. */
const KEY_NAME = 'prod-ssh-keypair-NEVER-LEAK';
/** A user tag value standing in for a secret; must NEVER appear in any field. */
const SECRET_TAG_VALUE = 'SUPER-SECRET-NEVER-LEAK';

// ---------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------

describe('Ec2SourceAdapter.discover (US-IMP-020)', () => {
  it('DescribeInstances (running filter) -> maps each instance to an ec2 candidate (ARN from Reservation.OwnerId)', async () => {
    const ec2Sender = senderDouble({
      DescribeInstancesCommand: () => ({
        Reservations: [
          {
            OwnerId: ACCOUNT,
            Instances: [
              { InstanceId: INSTANCE_ID, Tags: [{ Key: 'Name', Value: 'my-agent' }] },
            ],
          },
        ],
      }),
    });
    const adapter = new Ec2SourceAdapter({ ec2Sender });

    const candidates = await adapter.discover({ region: 'us-east-1' });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      displayName: 'my-agent',
      reference: INSTANCE_ARN,
      origin: {
        sourceArn: INSTANCE_ARN,
        substrate: 'ec2',
        region: 'us-east-1',
        account: ACCOUNT,
        ownership: 'external',
      },
    });
    expect(typeof candidates[0].origin.discoveredAt).toBe('string');

    // The running-state filter is always present.
    const input = ec2Sender.send.mock.calls[0][0] as SentCommand;
    expect(input.input.Filters).toEqual([
      { Name: 'instance-state-name', Values: ['running'] },
    ]);
  });

  it('falls back to InstanceId for displayName when there is no Name tag', async () => {
    const ec2Sender = senderDouble({
      DescribeInstancesCommand: () => ({
        Reservations: [{ OwnerId: ACCOUNT, Instances: [{ InstanceId: INSTANCE_ID }] }],
      }),
    });
    const adapter = new Ec2SourceAdapter({ ec2Sender });
    const [c] = await adapter.discover({ region: 'us-east-1' });
    expect(c.displayName).toBe(INSTANCE_ID);
  });

  it('adds a tag:<key>=<value> filter when scope.tagKey/tagValue are given', async () => {
    const ec2Sender = senderDouble({
      DescribeInstancesCommand: () => ({
        Reservations: [{ OwnerId: ACCOUNT, Instances: [{ InstanceId: INSTANCE_ID }] }],
      }),
    });
    const adapter = new Ec2SourceAdapter({ ec2Sender });

    await adapter.discover({ region: 'us-east-1', tagKey: 'citadel:agent', tagValue: 'true' });

    const input = ec2Sender.send.mock.calls[0][0] as SentCommand;
    expect(input.input.Filters).toEqual([
      { Name: 'instance-state-name', Values: ['running'] },
      { Name: 'tag:citadel:agent', Values: ['true'] },
    ]);
  });

  it('paginates instances across pages (NextToken) and flattens Reservations', async () => {
    const pages: Record<string, unknown>[] = [
      {
        Reservations: [{ OwnerId: ACCOUNT, Instances: [{ InstanceId: INSTANCE_ID }] }],
        NextToken: 'p2',
      },
      {
        Reservations: [
          { OwnerId: '999988887777', Instances: [{ InstanceId: 'i-second' }] },
        ],
      },
    ];
    let call = 0;
    const ec2Sender = senderDouble({ DescribeInstancesCommand: () => pages[call++] });
    const adapter = new Ec2SourceAdapter({ ec2Sender });

    const candidates = await adapter.discover({ region: 'us-east-1' });

    expect(candidates.map((c) => c.reference)).toEqual([
      INSTANCE_ARN,
      'arn:aws:ec2:us-east-1:999988887777:instance/i-second',
    ]);
    // Second candidate's account comes from its OWN reservation's OwnerId.
    expect(candidates[1].origin.account).toBe('999988887777');
    expect(candidates.every((c) => c.origin.substrate === 'ec2')).toBe(true);
    expect(ec2Sender.send).toHaveBeenCalledTimes(2);
  });

  it('returns [] when there are no reservations', async () => {
    const ec2Sender = senderDouble({ DescribeInstancesCommand: () => ({ Reservations: [] }) });
    const adapter = new Ec2SourceAdapter({ ec2Sender });
    await expect(adapter.discover({ region: 'us-east-1' })).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// describe
// ---------------------------------------------------------------------------

describe('Ec2SourceAdapter.describe (US-IMP-020)', () => {
  it('builds a low-confidence Tier-1 descriptor and resolves the endpoint from the citadel:endpoint tag (precedence a)', async () => {
    const ec2Sender = senderDouble({
      DescribeInstancesCommand: () => ({
        Reservations: [
          {
            OwnerId: ACCOUNT,
            Instances: [
              {
                InstanceId: INSTANCE_ID,
                InstanceType: 't3.medium',
                Architecture: 'x86_64',
                PlatformDetails: 'Linux/UNIX',
                KeyName: KEY_NAME,
                PrivateDnsName: PRIVATE_DNS,
                Tags: [
                  { Key: 'Name', Value: 'my-agent' },
                  { Key: 'citadel:endpoint', Value: 'https://agent.example.com/run' },
                  { Key: 'app-secret', Value: SECRET_TAG_VALUE },
                ],
              },
            ],
          },
        ],
      }),
    });
    // An elbSender that throws proves the ELBv2 path is NOT reached (tag wins).
    const elbSender = senderDouble({});
    const adapter = new Ec2SourceAdapter({ ec2Sender, elbSender });

    const d = await adapter.describe(INSTANCE_ARN);

    expect(d.name).toBe('my-agent');
    expect(d.invocation).toMatchObject({
      protocol: 'HTTP_ENDPOINT',
      target: 'https://agent.example.com/run',
      auth: { mode: 'NONE' },
      mode: 'sync',
      region: 'us-east-1',
      account: ACCOUNT,
    });
    expect(d.origin).toMatchObject({ substrate: 'ec2', sourceArn: INSTANCE_ARN });
    // Tier-1 safe metadata appears.
    expect(d.description).toContain('t3.medium');
    expect(d.fieldConfidence?.name).toBe('low');
    // NEVER leak the SSH key name or any user-tag secret value.
    const serialized = JSON.stringify(d);
    expect(serialized).not.toContain(KEY_NAME);
    expect(serialized).not.toContain(SECRET_TAG_VALUE);
    // The ELBv2 path was never consulted (tag precedence).
    expect(elbSender.send).not.toHaveBeenCalled();
  });

  it('falls back to the ALB DNS of a target group the instance is REGISTERED in (precedence b)', async () => {
    const ec2Sender = senderDouble({
      DescribeInstancesCommand: () => ({
        Reservations: [
          {
            OwnerId: ACCOUNT,
            Instances: [{ InstanceId: INSTANCE_ID, Tags: [], PrivateDnsName: PRIVATE_DNS }],
          },
        ],
      }),
    });
    const elbSender = senderDouble({
      DescribeTargetGroupsCommand: () => ({
        TargetGroups: [
          { TargetGroupArn: TG_ARN, LoadBalancerArns: [LB_ARN], Protocol: 'HTTP', Port: 80 },
        ],
      }),
      DescribeTargetHealthCommand: () => ({
        TargetHealthDescriptions: [{ Target: { Id: INSTANCE_ID, Port: 80 } }],
      }),
      DescribeLoadBalancersCommand: () => ({
        LoadBalancers: [{ LoadBalancerArn: LB_ARN, DNSName: LB_DNS }],
      }),
    });
    const adapter = new Ec2SourceAdapter({ ec2Sender, elbSender });

    const d = await adapter.describe(INSTANCE_ARN);

    expect(d.invocation.target).toBe(`http://${LB_DNS}`);
    expect(d.invocation.protocol).toBe('HTTP_ENDPOINT');
  });

  it('ignores a target group the instance is NOT registered in, then falls back to the private DNS + note (precedence c)', async () => {
    const ec2Sender = senderDouble({
      DescribeInstancesCommand: () => ({
        Reservations: [
          {
            OwnerId: ACCOUNT,
            Instances: [{ InstanceId: INSTANCE_ID, Tags: [], PrivateDnsName: PRIVATE_DNS }],
          },
        ],
      }),
    });
    const elbSender = senderDouble({
      DescribeTargetGroupsCommand: () => ({
        TargetGroups: [{ TargetGroupArn: TG_ARN, LoadBalancerArns: [LB_ARN] }],
      }),
      // A DIFFERENT instance is the registered target -> no match.
      DescribeTargetHealthCommand: () => ({
        TargetHealthDescriptions: [{ Target: { Id: 'i-someone-else', Port: 80 } }],
      }),
    });
    const adapter = new Ec2SourceAdapter({ ec2Sender, elbSender });

    const d = await adapter.describe(INSTANCE_ARN);

    // (c): the private host is surfaced as the target, but WITHOUT a guessed
    // scheme/port, and an operator note is attached.
    expect(d.invocation.target).toBe(PRIVATE_DNS);
    expect(d.invocation.target).not.toMatch(/^https?:\/\//);
    expect(d.invocation.target).not.toMatch(/:\d+/); // no guessed port
    expect(d.description.toLowerCase()).toContain('operator');
    expect(d.description.toLowerCase()).toContain('port');
  });

  it('falls back to the private IP when there is no private DNS (precedence c)', async () => {
    const ec2Sender = senderDouble({
      DescribeInstancesCommand: () => ({
        Reservations: [
          {
            OwnerId: ACCOUNT,
            Instances: [{ InstanceId: INSTANCE_ID, Tags: [], PrivateIpAddress: '10.0.1.23' }],
          },
        ],
      }),
    });
    const elbSender = senderDouble({ DescribeTargetGroupsCommand: () => ({ TargetGroups: [] }) });
    const adapter = new Ec2SourceAdapter({ ec2Sender, elbSender });

    const d = await adapter.describe(INSTANCE_ARN);

    expect(d.invocation.target).toBe('10.0.1.23');
    expect(d.description.toLowerCase()).toContain('operator');
  });

  it('leaves the endpoint empty and adds an operator note when nothing resolves (precedence d)', async () => {
    const ec2Sender = senderDouble({
      DescribeInstancesCommand: () => ({
        Reservations: [{ OwnerId: ACCOUNT, Instances: [{ InstanceId: INSTANCE_ID, Tags: [] }] }],
      }),
    });
    const elbSender = senderDouble({ DescribeTargetGroupsCommand: () => ({ TargetGroups: [] }) });
    const adapter = new Ec2SourceAdapter({ ec2Sender, elbSender });

    const d = await adapter.describe(INSTANCE_ARN);

    expect(d.invocation.target).toBe('');
    expect(d.invocation.protocol).toBe('HTTP_ENDPOINT');
    expect(d.description.toLowerCase()).toContain('endpoint');
  });
});

// ---------------------------------------------------------------------------
// healthCheck
// ---------------------------------------------------------------------------

describe('Ec2SourceAdapter.healthCheck (US-IMP-020)', () => {
  function endpointTagEc2Sender(): { send: jest.Mock } {
    return senderDouble({
      DescribeInstancesCommand: () => ({
        Reservations: [
          {
            OwnerId: ACCOUNT,
            Instances: [
              {
                InstanceId: INSTANCE_ID,
                Tags: [{ Key: 'citadel:endpoint', Value: 'https://agent.example.com/run' }],
              },
            ],
          },
        ],
      }),
    });
  }

  it('probes the resolved absolute endpoint and returns reachable:true on a 2xx', async () => {
    const fetchFn = jest.fn(async () => ({ ok: true, status: 200 }));
    const adapter = new Ec2SourceAdapter({
      ec2Sender: endpointTagEc2Sender(),
      fetchFn: asFetch(fetchFn),
    });
    await expect(adapter.healthCheck(INSTANCE_ARN)).resolves.toEqual({ reachable: true });
    expect(String(fetchFn.mock.calls[0][0])).toBe('https://agent.example.com/run');
  });

  it('returns reachable:false (with detail) on a non-2xx WITHOUT throwing', async () => {
    const fetchFn = jest.fn(async () => ({ ok: false, status: 503 }));
    const adapter = new Ec2SourceAdapter({
      ec2Sender: endpointTagEc2Sender(),
      fetchFn: asFetch(fetchFn),
    });
    const res = await adapter.healthCheck(INSTANCE_ARN);
    expect(res.reachable).toBe(false);
    expect(res.detail).toContain('503');
  });

  it('does NOT probe a bare private DNS (no scheme/port) -> reachable:false, fetch not called', async () => {
    const ec2Sender = senderDouble({
      DescribeInstancesCommand: () => ({
        Reservations: [
          {
            OwnerId: ACCOUNT,
            Instances: [{ InstanceId: INSTANCE_ID, Tags: [], PrivateDnsName: PRIVATE_DNS }],
          },
        ],
      }),
    });
    const elbSender = senderDouble({ DescribeTargetGroupsCommand: () => ({ TargetGroups: [] }) });
    const fetchFn = jest.fn();
    const adapter = new Ec2SourceAdapter({ ec2Sender, elbSender, fetchFn: asFetch(fetchFn) });

    const res = await adapter.healthCheck(INSTANCE_ARN);
    expect(res.reachable).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns reachable:false (no endpoint resolved) and does NOT call fetch when nothing resolves', async () => {
    const ec2Sender = senderDouble({
      DescribeInstancesCommand: () => ({
        Reservations: [{ OwnerId: ACCOUNT, Instances: [{ InstanceId: INSTANCE_ID, Tags: [] }] }],
      }),
    });
    const elbSender = senderDouble({ DescribeTargetGroupsCommand: () => ({ TargetGroups: [] }) });
    const fetchFn = jest.fn();
    const adapter = new Ec2SourceAdapter({ ec2Sender, elbSender, fetchFn: asFetch(fetchFn) });

    await expect(adapter.healthCheck(INSTANCE_ARN)).resolves.toEqual({
      reachable: false,
      detail: 'no endpoint resolved',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// invoke / vendCredentials — NotImplemented (EC2 invokes via HTTP_ENDPOINT)
// ---------------------------------------------------------------------------

describe('Ec2SourceAdapter invoke/vendCredentials are NotImplemented stubs', () => {
  const invocation: AgentInvocationBlock = {
    protocol: 'HTTP_ENDPOINT',
    target: 'https://agent.example.com',
    auth: { mode: 'NONE' },
    mode: 'sync',
  };

  it('vendCredentials throws NotImplementedError (no AWS invoke role for EC2)', async () => {
    const adapter = new Ec2SourceAdapter({});
    await expect(adapter.vendCredentials(invocation)).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('invoke throws NotImplementedError (invoke flows through the HTTP adapter)', async () => {
    const adapter = new Ec2SourceAdapter({});
    await expect(
      adapter.invoke(
        { prompt: 'ping' },
        {
          name: 'x',
          description: '',
          version: '1',
          skills: [],
          categories: [],
          inputSchema: {},
          outputSchema: {},
          invocation,
          origin: { substrate: 'ec2', discoveredAt: 'now', ownership: 'external' },
        },
      ),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });

  it("declares protocol HTTP_ENDPOINT (the candidate's invocation protocol)", () => {
    expect(new Ec2SourceAdapter({}).protocol).toBe('HTTP_ENDPOINT');
  });
});
