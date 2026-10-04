/**
 * Generalized Policy Manager
 *
 * Manages scoped IAM roles for datastores, integrations, and agents.
 * The scope parameter controls the role name prefix.
 */

import {
  IAMClient,
  CreateRoleCommand,
  PutRolePolicyCommand,
  DeleteRolePolicyCommand,
  DeleteRoleCommand,
  TagRoleCommand,
} from "@aws-sdk/client-iam";
import {
  STSClient,
  GetCallerIdentityCommand,
  AssumeRoleCommand,
} from "@aws-sdk/client-sts";
import { PolicyStatement } from "../adapters/base";
import { PermissionError } from "../adapters/errors";

export type PolicyScope = "datastore" | "integration" | "agent" | "eval";

export type ScopedCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /**
   * ISO 8601 expiry of the assumed credentials, when STS returns one. Additive
   * and optional: existing callers that ignore it are unaffected.
   */
  expiresAt?: string;
};

const SCOPE_PREFIXES: Record<PolicyScope, string> = {
  datastore: "citadel-ds-",
  integration: "citadel-int-",
  agent: "citadel-agent-",
  // CIT-102: per-eval-run scoped role (citadel-eval-{evalRunId}) — reuses
  // ensureRole/assumeScopedRole verbatim, no new IAM machinery.
  eval: "citadel-eval-",
};

const INLINE_POLICY_NAME = "DataStoreAccess";

/**
 * AWS IAM limit: max 50 tags per role.
 * @see https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_iam-quotas.html
 */
const IAM_TAG_LIMIT = 50;

/** Role-name prefixes vended by PolicyManager — tagExistingRole is scoped to these. */
const VENDED_PREFIXES = [
  "citadel-agent-",
  "citadel-ds-",
  "citadel-int-",
  "citadel-eval-",
];

/**
 * IAM tag key rules: up to 128 unicode chars, alphanumeric + ` _ . : / = + - @`.
 * IAM tag value rules: up to 256 unicode chars, same character set (empty allowed).
 * Returns null when the entry cannot be sanitised (dropped).
 */
function sanitiseTagEntry(
  key: string,
  value: string,
): { Key: string; Value: string } | null {
  // eslint-disable-next-line no-control-regex
  const ALLOWED = /^[\w\s_.:/=+\-@]+$/;
  const sanitised = (s: string, max: number): string | null => {
    const trimmed = s.slice(0, max);
    return ALLOWED.test(trimmed) ? trimmed : null;
  };
  const k = sanitised(key, 128);
  const v = sanitised(value, 256);
  if (!k) return null; // key is mandatory
  return { Key: k, Value: v ?? "" };
}

/** Optional tag-propagation input accepted by ensureRole and tagExistingRole. */
export interface RoleTagInput {
  tags?: Record<string, string>;
  orgId?: string;
  agentId?: string;
}

export class PolicyManager {
  private iamClient: IAMClient;
  private stsClient: STSClient;

  constructor(iamClient?: IAMClient, stsClient?: STSClient) {
    this.iamClient = iamClient ?? new IAMClient({});
    this.stsClient = stsClient ?? new STSClient({});
  }

  async getAccountContext(): Promise<{ accountId: string; region: string }> {
    const identity = await this.stsClient.send(
      new GetCallerIdentityCommand({}),
    );
    const accountId = identity.Account!;
    const region = await this.stsClient.config.region();
    return {
      accountId,
      region: typeof region === "string" ? region : "us-east-1",
    };
  }

  private static isScope(value: unknown): value is PolicyScope {
    return (
      value === "datastore" ||
      value === "integration" ||
      value === "agent" ||
      value === "eval"
    );
  }

  async ensureRole(
    resourceId: string,
    policies: PolicyStatement[],
    accountId: string,
    scopeOrCrossAccountArn?: PolicyScope | string,
    crossAccountRoleArn?: string,
    additionalTrustedPrincipals?: string[],
    externalId?: string,
    resourceTags?: RoleTagInput,
  ): Promise<void> {
    // Backward compat: if 4th arg looks like an ARN, treat it as crossAccountRoleArn
    let scope: PolicyScope = "datastore";
    let crossArn = crossAccountRoleArn;
    if (scopeOrCrossAccountArn) {
      if (PolicyManager.isScope(scopeOrCrossAccountArn)) {
        scope = scopeOrCrossAccountArn;
      } else {
        crossArn = scopeOrCrossAccountArn;
      }
    }

    const roleName = PolicyManager.getRoleName(resourceId, scope);

    const callerIdentity = await this.stsClient.send(
      new GetCallerIdentityCommand({}),
    );
    const callerArn = callerIdentity.Arn!;
    const lambdaRoleArn = this.getLambdaRoleArn(callerArn);

    const principals: string[] = [lambdaRoleArn];
    if (crossArn) {
      principals.push(crossArn);
    }
    // Add any additional trusted principals (e.g. health monitor role)
    if (additionalTrustedPrincipals) {
      for (const p of additionalTrustedPrincipals) {
        if (p && !principals.includes(p)) {
          principals.push(p);
        }
      }
    }

    // Wave 2b (fix/vender-org-scoping): a datastore/integration-scoped role
    // must NEVER trust an agent role directly -- agents reach ds/int
    // credentials exclusively through the credential vender's own
    // sts:AssumeRole GRANT (computeAgentPolicies), never through the
    // ds/int role's OWN trust policy. Reject even when a citadel-agent-*
    // principal arrives via additionalTrustedPrincipals (e.g. a
    // misconfigured caller), before any IAM call is made. Agent-scoped
    // roles are exempt -- an agent role legitimately trusting another
    // agent role (or itself) is not the invariant being enforced here.
    if (scope !== "agent") {
      const agentPrincipal = principals.find((p) => /citadel-agent-/.test(p));
      if (agentPrincipal) {
        throw new PermissionError(
          `Refusing to create ${scope} role ${roleName}: trust policy would ` +
            `include a citadel-agent-* principal (${agentPrincipal}), which ` +
            `is never permitted to be trusted directly by a datastore/` +
            `integration role.`,
        );
      }
    }

    const trustStatement: Record<string, unknown> = {
      Effect: "Allow",
      Principal: { AWS: principals.length === 1 ? principals[0] : principals },
      Action: "sts:AssumeRole",
    };
    // Additive: only constrain the trust with an sts:ExternalId condition when
    // an externalId is supplied (cross-account confused-deputy guard). Absent ⇒
    // the statement is byte-for-byte what it was before this change.
    if (externalId) {
      trustStatement.Condition = {
        StringEquals: { "sts:ExternalId": externalId },
      };
    }

    const trustPolicy = {
      Version: "2012-10-17",
      Statement: [trustStatement],
    };

    try {
      // --- Build merged tag set ---
      const iamTags: { Key: string; Value: string }[] = [
        { Key: "ManagedBy", Value: "citadel" },
        { Key: "ResourceId", Value: resourceId },
        { Key: "Scope", Value: scope },
      ];

      if (resourceTags) {
        // System tags: citadel:org (always when available)
        if (resourceTags.orgId) {
          iamTags.push({ Key: "citadel:org", Value: resourceTags.orgId });
        }

        // System tags: scope-specific identifier
        if (resourceTags.agentId) {
          const scopeTagKey =
            scope === "datastore"
              ? "citadel:datastore"
              : scope === "integration"
                ? "citadel:integration"
                : "citadel:agent";
          iamTags.push({ Key: scopeTagKey, Value: resourceTags.agentId });
        }

        // User-defined policy tags
        if (resourceTags.tags) {
          for (const [key, value] of Object.entries(resourceTags.tags)) {
            const entry = sanitiseTagEntry(key, value);
            if (entry) {
              // Avoid duplicating system keys
              if (!iamTags.some((t) => t.Key === entry.Key)) {
                iamTags.push(entry);
              }
            } else {
              console.warn(
                `ensureRole: dropped tag with invalid characters: key=${key}`,
              );
            }
          }
        }
      }

      // AWS IAM limit: 50 tags per role
      if (iamTags.length > IAM_TAG_LIMIT) {
        console.warn(
          `ensureRole: tag count (${iamTags.length}) exceeds IAM limit (${IAM_TAG_LIMIT}), truncating`,
        );
      }
      const finalTags = iamTags.slice(0, IAM_TAG_LIMIT);

      await this.iamClient.send(
        new CreateRoleCommand({
          RoleName: roleName,
          AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
          Tags: finalTags,
        }),
      );
    } catch (error: unknown) {
      const err = error as Error;
      if (err.name !== "EntityAlreadyExistsException") {
        throw new PermissionError(
          `Failed to create IAM role ${roleName}: ${err.message}`,
          err,
        );
      }
    }

    const policyDocument = PolicyManager.buildPolicyDocument(policies);
    try {
      await this.iamClient.send(
        new PutRolePolicyCommand({
          RoleName: roleName,
          PolicyName: INLINE_POLICY_NAME,
          PolicyDocument: JSON.stringify(policyDocument),
        }),
      );
    } catch (error: unknown) {
      const err = error as Error;
      throw new PermissionError(
        `Failed to attach policy to role ${roleName}: ${err.message}`,
        err,
      );
    }
  }

  /**
   * Tags an existing vended IAM role. Guarded to role names starting with
   * a known vended prefix (citadel-agent-/citadel-ds-/citadel-int-/citadel-eval-).
   * Swallows NoSuchEntityException (role may have been deleted externally).
   */
  async tagExistingRole(
    roleName: string,
    tags: Record<string, string>,
  ): Promise<void> {
    if (!VENDED_PREFIXES.some((p) => roleName.startsWith(p))) {
      throw new PermissionError(
        `tagExistingRole: refusing to tag role "${roleName}" — name does not ` +
          `start with a vended prefix (${VENDED_PREFIXES.join(", ")})`,
      );
    }

    const iamTags: { Key: string; Value: string }[] = [];
    for (const [key, value] of Object.entries(tags)) {
      const entry = sanitiseTagEntry(key, value);
      if (entry) {
        iamTags.push(entry);
      } else {
        console.warn(
          `tagExistingRole: dropped tag with invalid characters: key=${key}`,
        );
      }
    }

    if (iamTags.length === 0) return;

    // Cap at IAM limit
    if (iamTags.length > IAM_TAG_LIMIT) {
      console.warn(
        `tagExistingRole: tag count (${iamTags.length}) exceeds IAM limit (${IAM_TAG_LIMIT}), truncating`,
      );
    }
    const finalTags = iamTags.slice(0, IAM_TAG_LIMIT);

    try {
      await this.iamClient.send(
        new TagRoleCommand({
          RoleName: roleName,
          Tags: finalTags,
        }),
      );
    } catch (error: unknown) {
      const err = error as Error;
      if (err.name === "NoSuchEntityException") {
        console.warn(
          `tagExistingRole: role ${roleName} does not exist, skipping`,
        );
        return;
      }
      throw new PermissionError(
        `Failed to tag IAM role ${roleName}: ${err.message}`,
        err,
      );
    }
  }

  async assumeScopedRole(
    resourceId: string,
    accountId: string,
    scopeOrCrossAccountArn?: PolicyScope | string,
    crossAccountRoleArn?: string,
    externalId?: string,
  ): Promise<ScopedCredentials> {
    // Backward compat: if 3rd arg looks like an ARN, treat it as crossAccountRoleArn
    let scope: PolicyScope = "datastore";
    let crossArn = crossAccountRoleArn;
    if (scopeOrCrossAccountArn) {
      if (PolicyManager.isScope(scopeOrCrossAccountArn)) {
        scope = scopeOrCrossAccountArn;
      } else {
        crossArn = scopeOrCrossAccountArn;
      }
    }

    const roleName = PolicyManager.getRoleName(resourceId, scope);
    const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;

    let stsClient = this.stsClient;

    if (crossArn) {
      const crossAccountCreds = await this.retryWithBackoff(
        async () => {
          const result = await this.stsClient.send(
            new AssumeRoleCommand({
              RoleArn: crossArn,
              RoleSessionName: `citadel-cross-${resourceId}`,
              ...(externalId ? { ExternalId: externalId } : {}),
            }),
          );
          return result.Credentials!;
        },
        3,
        1000,
      );

      stsClient = new STSClient({
        credentials: {
          accessKeyId: crossAccountCreds.AccessKeyId!,
          secretAccessKey: crossAccountCreds.SecretAccessKey!,
          sessionToken: crossAccountCreds.SessionToken!,
        },
      });
    }

    const credentials = await this.retryWithBackoff(
      async () => {
        const result = await stsClient.send(
          new AssumeRoleCommand({
            RoleArn: roleArn,
            RoleSessionName: `citadel-${scope}-${resourceId}`,
            ...(externalId ? { ExternalId: externalId } : {}),
          }),
        );
        return result.Credentials!;
      },
      3,
      2000,
    );

    return {
      accessKeyId: credentials.AccessKeyId!,
      secretAccessKey: credentials.SecretAccessKey!,
      sessionToken: credentials.SessionToken!,
      expiresAt: credentials.Expiration
        ? credentials.Expiration.toISOString()
        : undefined,
    };
  }

  async deleteRole(
    resourceId: string,
    scope: PolicyScope = "datastore",
  ): Promise<void> {
    const roleName = PolicyManager.getRoleName(
      resourceId,
      typeof scope === "string" && PolicyManager.isScope(scope)
        ? scope
        : "datastore",
    );

    try {
      await this.iamClient.send(
        new DeleteRolePolicyCommand({
          RoleName: roleName,
          PolicyName: INLINE_POLICY_NAME,
        }),
      );
    } catch (error: unknown) {
      const err = error as Error;
      if (err.name !== "NoSuchEntityException") {
        throw new PermissionError(
          `Failed to delete policy from role ${roleName}: ${err.message}`,
          err,
        );
      }
    }

    try {
      await this.iamClient.send(new DeleteRoleCommand({ RoleName: roleName }));
    } catch (error: unknown) {
      const err = error as Error;
      if (err.name !== "NoSuchEntityException") {
        throw new PermissionError(
          `Failed to delete IAM role ${roleName}: ${err.message}`,
          err,
        );
      }
    }
  }

  private getLambdaRoleArn(callerArn: string): string {
    const match = callerArn.match(/arn:aws:sts::(\d+):assumed-role\/([^/]+)/);
    if (match) {
      return `arn:aws:iam::${match[1]}:role/${match[2]}`;
    }
    return callerArn;
  }

  async retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries: number,
    baseDelayMs: number,
  ): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error: unknown) {
        lastError = error as Error;
        if (attempt < maxRetries) {
          const delay = baseDelayMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError;
  }

  static buildPolicyDocument(
    policies: PolicyStatement[],
  ): Record<string, unknown> {
    return {
      Version: "2012-10-17",
      Statement: policies.map((p) => ({
        Effect: "Allow",
        Action: p.actions,
        Resource: p.resources,
      })),
    };
  }

  static getRoleName(
    resourceId: string,
    scope: PolicyScope = "datastore",
  ): string {
    return `${SCOPE_PREFIXES[scope]}${resourceId}`;
  }
}
