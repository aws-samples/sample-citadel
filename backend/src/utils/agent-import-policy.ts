/**
 * Agent Import — IAM Policy Builders (US-IMP-001)
 *
 * Pure functions that build least-privilege IAM policy documents for the
 * agent-import feature. These mirror the policy-document shape emitted by
 * `PolicyManager.buildPolicyDocument` (see `policy-manager.ts`) — a
 * `{ Version, Statement: [{ Effect, Action, Resource }] }` object — but are
 * fully typed (no `any`) and live alongside the other pure policy builders in
 * `policy-helpers.ts`.
 *
 * Two builders are provided:
 *   - `buildImportInvokePolicy` — a per-agent invoke role policy granting
 *     exactly one concrete resource (the target ARN) the single action for
 *     the agent's invocation protocol.
 *   - `buildImportDiscoveryPolicy` — a read-only policy used to discover
 *     importable agents across the phase-1 substrates.
 *
 * Least-privilege invariant (RD1 / invariant 2): the invoke policy NEVER
 * grants a wildcard resource. Discovery is read-only and may use `Resource:
 * '*'` because List/Describe operations don't support resource-level scoping.
 */
import type { AgentInvocationProtocol } from '../services/registry-service';

/** IAM policy language version used across the platform. */
const POLICY_VERSION = '2012-10-17' as const;

/**
 * A single IAM policy statement, in the shape PolicyManager emits
 * (capitalised keys, array-valued Action/Resource).
 */
export interface IamPolicyStatement {
  Effect: 'Allow';
  Action: string[];
  Resource: string[];
}

/** An IAM policy document, in the shape PolicyManager emits. */
export interface IamPolicyDocument {
  Version: typeof POLICY_VERSION;
  Statement: IamPolicyStatement[];
}

/** Role-name prefix for per-agent import invoke roles: `citadel-agent-invoke-{id}`. */
export const IMPORT_INVOKE_ROLE_PREFIX = 'citadel-agent-invoke-';

/**
 * Builds the scoped IAM role name for an imported agent's invoke role.
 * Mirrors `PolicyManager.getRoleName` but for the dedicated invoke-role
 * prefix used by the import feature.
 */
export function importInvokeRoleName(id: string): string {
  return `${IMPORT_INVOKE_ROLE_PREFIX}${id}`;
}

/**
 * Thrown when `buildImportInvokePolicy` is asked to build an invoke policy for
 * a protocol that has no scoped-IAM-role invoke path in phase 1
 * (A2A, STEP_FUNCTIONS, SAGEMAKER_ENDPOINT, SQS_ASYNC, or any future value).
 */
export class UnsupportedInvokeProtocolError extends Error {
  /** The offending protocol name. */
  public readonly protocol: string;

  constructor(protocol: string) {
    super(`Invocation protocol '${protocol}' is not supported in phase 1`);
    this.name = 'UnsupportedInvokeProtocolError';
    this.protocol = protocol;
  }
}

/**
 * Returns the single IAM action that grants invoke for `protocol`, or `null`
 * for protocols that need no IAM invoke role (MCP). Throws
 * `UnsupportedInvokeProtocolError` for protocols not supported in phase 1.
 */
function invokeActionsFor(protocol: AgentInvocationProtocol): string[] | null {
  switch (protocol) {
    case 'AGENTCORE_RUNTIME':
      return ['bedrock-agentcore:InvokeAgentRuntime'];
    case 'LAMBDA_INVOKE':
      return ['lambda:InvokeFunction'];
    case 'BEDROCK_AGENT':
      return ['bedrock:InvokeAgent'];
    case 'HTTP_ENDPOINT':
      return ['execute-api:Invoke'];
    case 'MCP':
      // MCP agents are reached over HTTP with bearer-token auth supplied via a
      // Secrets Manager secretRef (AgentInvocationBlock.auth.secretRef). There
      // is no AWS IAM "invoke" action for an MCP endpoint, so no scoped invoke
      // role is needed — callers provision secret-read access instead. `null`
      // signals "no IAM invoke policy required".
      return null;
    default:
      // A2A, STEP_FUNCTIONS, SAGEMAKER_ENDPOINT, SQS_ASYNC — and any protocol
      // added to the union in future — are not invokable via a scoped IAM role
      // in phase 1.
      throw new UnsupportedInvokeProtocolError(protocol);
  }
}

/**
 * Validates that `targetArn` is a single concrete resource ARN. Rejects empty
 * / blank values and any wildcard so the produced invoke policy can never
 * grant `*` (least-privilege invariant).
 */
function assertConcreteResource(targetArn: string): void {
  if (!targetArn || targetArn.trim().length === 0) {
    throw new Error('buildImportInvokePolicy: targetArn must be a non-empty resource ARN');
  }
  if (targetArn.includes('*')) {
    throw new Error(
      `buildImportInvokePolicy: targetArn must not contain a wildcard '*' — ` +
        `a least-privilege invoke policy grants exactly one concrete resource (got '${targetArn}')`,
    );
  }
}

/** Builds a one-statement Allow policy document. */
function singleStatementDocument(actions: string[], resources: string[]): IamPolicyDocument {
  return {
    Version: POLICY_VERSION,
    Statement: [{ Effect: 'Allow', Action: actions, Resource: resources }],
  };
}

/**
 * Builds a least-privilege invoke policy for an imported agent.
 *
 * Returns an IAM policy document whose single statement grants exactly the
 * action(s) required for `protocol` on exactly `targetArn` (never a wildcard):
 *   - AGENTCORE_RUNTIME -> bedrock-agentcore:InvokeAgentRuntime
 *   - LAMBDA_INVOKE     -> lambda:InvokeFunction
 *   - BEDROCK_AGENT     -> bedrock:InvokeAgent
 *   - HTTP_ENDPOINT     -> execute-api:Invoke
 *
 * Returns `null` for MCP (HTTP/bearer auth via secretRef — no IAM invoke role
 * needed). Throws `UnsupportedInvokeProtocolError` for protocols not supported
 * in phase 1 (A2A, STEP_FUNCTIONS, SAGEMAKER_ENDPOINT, SQS_ASYNC).
 *
 * @param protocol  the agent's invocation protocol
 * @param targetArn the single concrete resource ARN to grant invoke on
 */
export function buildImportInvokePolicy(
  protocol: AgentInvocationProtocol,
  targetArn: string,
): IamPolicyDocument | null {
  const actions = invokeActionsFor(protocol);
  if (actions === null) {
    // MCP — no IAM invoke policy required.
    return null;
  }
  assertConcreteResource(targetArn);
  return singleStatementDocument(actions, [targetArn]);
}

/** Builds an Allow statement over all resources (read-only discovery). */
function readOnlyStatement(actions: string[]): IamPolicyStatement {
  return { Effect: 'Allow', Action: actions, Resource: ['*'] };
}

/**
 * Builds the read-only discovery policy used to enumerate importable agents
 * across the phase-1 substrates.
 *
 * Every action is a List / Describe / Get-class read; there are no mutating
 * actions. `Resource: '*'` is used because List/Describe operations generally
 * don't support resource-level scoping — this is acceptable for read-only
 * actions. (The no-wildcard rule applies to the single-resource INVOKE policy,
 * not to discovery.)
 */
export function buildImportDiscoveryPolicy(): IamPolicyDocument {
  return {
    Version: POLICY_VERSION,
    Statement: [
      // AgentCore Runtime agents
      readOnlyStatement([
        'bedrock-agentcore:ListAgentRuntimes',
        'bedrock-agentcore:GetAgentRuntime',
        'bedrock-agentcore:ListAgentRuntimeEndpoints',
      ]),
      // Bedrock Agents
      readOnlyStatement([
        'bedrock:ListAgents',
        'bedrock:GetAgent',
        'bedrock:ListAgentAliases',
        'bedrock:ListAgentActionGroups',
        'bedrock:ListAgentKnowledgeBases',
      ]),
      // Lambda-hosted agents
      readOnlyStatement([
        'lambda:ListFunctions',
        'lambda:GetFunctionConfiguration',
        'lambda:GetFunction',
        'lambda:GetPolicy',
        'lambda:ListTags',
        'lambda:ListEventSourceMappings',
        'lambda:ListFunctionUrlConfigs',
      ]),
      // ECS-hosted agents
      readOnlyStatement([
        'ecs:ListClusters',
        'ecs:ListServices',
        'ecs:DescribeServices',
        'ecs:DescribeTaskDefinition',
      ]),
      // EC2 (compute substrate discovery)
      readOnlyStatement(['ec2:DescribeInstances', 'ec2:DescribeTags']),
      // EKS-hosted agents
      readOnlyStatement(['eks:ListClusters', 'eks:DescribeCluster']),
      // API Gateway (HTTP endpoints) — apigateway:GET is the read action
      readOnlyStatement(['apigateway:GET']),
      // Resource Groups Tagging API (cross-substrate discovery by tag)
      readOnlyStatement(['tag:GetResources']),
    ],
  };
}
