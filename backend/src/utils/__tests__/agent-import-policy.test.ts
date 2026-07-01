/**
 * TDD tests for the agent-import IAM policy builders (US-IMP-001).
 *
 * Covers:
 *  - buildImportInvokePolicy: one concrete-resource Allow statement per
 *    IAM-backed protocol; null for MCP; throws for unsupported protocols.
 *  - buildImportDiscoveryPolicy: read-only discovery permissions.
 *  - importInvokeRoleName / IMPORT_INVOKE_ROLE_PREFIX naming helper.
 *  - Property test (fast-check): the invoke policy never emits a wildcard
 *    Resource and always has exactly one Resource entry.
 */
import * as fc from 'fast-check';
import type { AgentInvocationProtocol } from '../../services/registry-service';
import {
  buildImportInvokePolicy,
  buildImportDiscoveryPolicy,
  importInvokeRoleName,
  IMPORT_INVOKE_ROLE_PREFIX,
  UnsupportedInvokeProtocolError,
} from '../agent-import-policy';

// Protocol -> expected single IAM action, for the four IAM-backed protocols.
const IAM_BACKED: ReadonlyArray<{ protocol: AgentInvocationProtocol; action: string }> = [
  { protocol: 'AGENTCORE_RUNTIME', action: 'bedrock-agentcore:InvokeAgentRuntime' },
  { protocol: 'LAMBDA_INVOKE', action: 'lambda:InvokeFunction' },
  { protocol: 'BEDROCK_AGENT', action: 'bedrock:InvokeAgent' },
  { protocol: 'HTTP_ENDPOINT', action: 'execute-api:Invoke' },
];

const UNSUPPORTED: ReadonlyArray<AgentInvocationProtocol> = [
  'A2A',
  'STEP_FUNCTIONS',
  'SAGEMAKER_ENDPOINT',
  'SQS_ASYNC',
];

describe('buildImportInvokePolicy', () => {
  test.each(IAM_BACKED)(
    '$protocol -> single Allow statement granting $action on exactly the target ARN',
    ({ protocol, action }) => {
      const targetArn = 'arn:aws:lambda:us-west-2:123456789012:function:ImportedAgentFn';
      const policy = buildImportInvokePolicy(protocol, targetArn);

      expect(policy).not.toBeNull();
      expect(policy!.Version).toBe('2012-10-17');
      expect(policy!.Statement).toHaveLength(1);

      const stmt = policy!.Statement[0];
      expect(stmt.Effect).toBe('Allow');
      expect(stmt.Action).toEqual([action]);
      // Resource MUST be exactly the passed ARN — never a wildcard.
      expect(stmt.Resource).toEqual([targetArn]);
    },
  );

  test('MCP returns null (HTTP/bearer auth via secretRef — no IAM invoke role needed)', () => {
    expect(buildImportInvokePolicy('MCP', 'https://mcp.example.com/agent')).toBeNull();
  });

  test('MCP returns null regardless of the target value', () => {
    fc.assert(
      fc.property(fc.string(), (target) => {
        expect(buildImportInvokePolicy('MCP', target)).toBeNull();
      }),
      { numRuns: 100 },
    );
  });

  test.each(UNSUPPORTED)('unsupported protocol %s throws UnsupportedInvokeProtocolError', (protocol) => {
    expect(() =>
      buildImportInvokePolicy(protocol, 'arn:aws:states:us-west-2:123456789012:stateMachine:x'),
    ).toThrow(UnsupportedInvokeProtocolError);
  });

  test('UnsupportedInvokeProtocolError is instanceof Error and names the protocol + phase 1', () => {
    let caught: unknown;
    try {
      buildImportInvokePolicy('A2A', 'arn:aws:foo');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnsupportedInvokeProtocolError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('A2A');
    expect((caught as Error).message).toMatch(/phase 1/i);
    expect((caught as UnsupportedInvokeProtocolError).protocol).toBe('A2A');
  });

  test('rejects an empty / blank target ARN for an IAM-backed protocol', () => {
    expect(() => buildImportInvokePolicy('LAMBDA_INVOKE', '')).toThrow(/non-empty/i);
    expect(() => buildImportInvokePolicy('LAMBDA_INVOKE', '   ')).toThrow(/non-empty/i);
  });

  test('rejects a wildcard target ARN (least-privilege: never a wildcard)', () => {
    expect(() => buildImportInvokePolicy('LAMBDA_INVOKE', '*')).toThrow(/wildcard/i);
    expect(() =>
      buildImportInvokePolicy(
        'AGENTCORE_RUNTIME',
        'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/*',
      ),
    ).toThrow(/wildcard/i);
  });

  // --- PROPERTY TEST -------------------------------------------------------
  // Realistic ARN-ish strings: non-empty, no whitespace-only, no '*'.
  const arnArb = fc
    .stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9._/:-]{0,48}$/)
    .map((suffix) => `arn:aws:service:us-west-2:123456789012:${suffix}`);

  const iamBackedProtocolArb = fc.constantFrom(
    ...IAM_BACKED.map((x) => x.protocol),
  );

  test('property: IAM-backed protocol + non-empty non-wildcard ARN => exactly one Resource, never a wildcard', () => {
    fc.assert(
      fc.property(iamBackedProtocolArb, arnArb, (protocol, arn) => {
        const policy = buildImportInvokePolicy(protocol, arn);

        expect(policy).not.toBeNull();
        expect(policy!.Statement).toHaveLength(1);

        const resources = policy!.Statement[0].Resource;
        // exactly one Resource entry...
        expect(resources).toHaveLength(1);
        // ...equal to the passed ARN...
        expect(resources[0]).toBe(arn);
        // ...and never a wildcard.
        expect(resources).not.toContain('*');
        expect(resources.every((r) => !r.includes('*'))).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  test('property: action always matches the protocol mapping (single action, never a wildcard)', () => {
    const actionByProtocol = new Map(IAM_BACKED.map((x) => [x.protocol, x.action]));
    fc.assert(
      fc.property(iamBackedProtocolArb, arnArb, (protocol, arn) => {
        const policy = buildImportInvokePolicy(protocol, arn);
        const actions = policy!.Statement[0].Action;
        expect(actions).toEqual([actionByProtocol.get(protocol)]);
        expect(actions.every((a) => !a.includes('*'))).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

describe('buildImportDiscoveryPolicy', () => {
  // A read-only verb prefix: service:Verb where Verb is List/Describe/Get/BatchGet/GET.
  const READ_VERB = /^[a-zA-Z0-9-]+:(List|Describe|Get|BatchGet|GET)/;
  // Mutating verbs that must never appear in a discovery policy.
  const MUTATING_VERB = /(Create|Put|Update|Delete|Invoke|Start|Send|Attach|Modify|Remove)/;

  const allActions = (): string[] =>
    buildImportDiscoveryPolicy().Statement.flatMap((s) => s.Action);

  test('produces a valid policy document (2012-10-17, Allow on every statement)', () => {
    const doc = buildImportDiscoveryPolicy();
    expect(doc.Version).toBe('2012-10-17');
    expect(doc.Statement.length).toBeGreaterThan(0);
    for (const stmt of doc.Statement) {
      expect(stmt.Effect).toBe('Allow');
      expect(Array.isArray(stmt.Action)).toBe(true);
      expect(stmt.Action.length).toBeGreaterThan(0);
      expect(Array.isArray(stmt.Resource)).toBe(true);
    }
  });

  test('every action is a read-only verb (List|Describe|Get|BatchGet|GET)', () => {
    const actions = allActions();
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action).toMatch(READ_VERB);
    }
  });

  test('no action contains a mutating verb', () => {
    for (const action of allActions()) {
      expect(action).not.toMatch(MUTATING_VERB);
    }
  });

  test('covers all phase-1 discovery substrates', () => {
    const actions = new Set(allActions());
    // bedrock-agentcore
    expect(actions).toContain('bedrock-agentcore:ListAgentRuntimes');
    expect(actions).toContain('bedrock-agentcore:GetAgentRuntime');
    expect(actions).toContain('bedrock-agentcore:ListAgentRuntimeEndpoints');
    // bedrock
    expect(actions).toContain('bedrock:ListAgents');
    expect(actions).toContain('bedrock:GetAgent');
    expect(actions).toContain('bedrock:ListAgentAliases');
    expect(actions).toContain('bedrock:ListAgentActionGroups');
    expect(actions).toContain('bedrock:ListAgentKnowledgeBases');
    // lambda
    expect(actions).toContain('lambda:ListFunctions');
    expect(actions).toContain('lambda:GetFunctionConfiguration');
    expect(actions).toContain('lambda:GetFunction');
    expect(actions).toContain('lambda:GetPolicy');
    expect(actions).toContain('lambda:ListTags');
    expect(actions).toContain('lambda:ListEventSourceMappings');
    expect(actions).toContain('lambda:ListFunctionUrlConfigs');
    // ecs
    expect(actions).toContain('ecs:ListClusters');
    expect(actions).toContain('ecs:ListServices');
    expect(actions).toContain('ecs:DescribeServices');
    expect(actions).toContain('ecs:DescribeTaskDefinition');
    // ec2
    expect(actions).toContain('ec2:DescribeInstances');
    expect(actions).toContain('ec2:DescribeTags');
    // eks
    expect(actions).toContain('eks:ListClusters');
    expect(actions).toContain('eks:DescribeCluster');
    // apigateway + tagging
    expect(actions).toContain('apigateway:GET');
    expect(actions).toContain('tag:GetResources');
  });

  test('contains no duplicate actions', () => {
    const actions = allActions();
    expect(new Set(actions).size).toBe(actions.length);
  });
});

describe('importInvokeRoleName / IMPORT_INVOKE_ROLE_PREFIX', () => {
  test('prefix constant is citadel-agent-invoke-', () => {
    expect(IMPORT_INVOKE_ROLE_PREFIX).toBe('citadel-agent-invoke-');
  });

  test('builds the per-agent invoke role name citadel-agent-invoke-{id}', () => {
    expect(importInvokeRoleName('abc123')).toBe('citadel-agent-invoke-abc123');
  });

  test('is consistent with the exported prefix for any id', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,30}$/), (id) => {
        expect(importInvokeRoleName(id)).toBe(`${IMPORT_INVOKE_ROLE_PREFIX}${id}`);
      }),
      { numRuns: 100 },
    );
  });
});
