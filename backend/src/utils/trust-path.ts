/**
 * Reusable in-process IAM trust-path core.
 *
 * Extracted from `governance-ui-resolver.ts` (Wave 5.C.1 `getTrustPath`) so the
 * same pure IAM-fetch + hop/note projection can be reused at imported-agent
 * activation (US-IMP lazy trust-path attestation) WITHOUT going through the
 * AppSync resolver. The projection shape (`TrustPathRoleProjected`) and the
 * per-hop fetch semantics are identical to what `getTrustPath` returned before
 * the refactor — `getTrustPath` now delegates its per-hop IAM work here.
 *
 * Two layers:
 *   • {@link fetchTrustPathHop} — the pure primitive: given an injected IAM
 *     client + a role ARN, fetch the role's trust policy + its `DataStoreAccess`
 *     inline policy and project a single hop (+ contextual notes). Each IAM call
 *     is wrapped in its own try/catch so a missing role / absent inline policy
 *     yields an empty-field hop with a note rather than throwing.
 *   • {@link computeTrustPath} — the higher-level entry: builds the hop(s) for a
 *     role (and an optional cross-account role), then derives issue-level
 *     `findings` and a conservative `clean` flag for the activation gate.
 *
 * The IAM client is always injectable; `computeTrustPath` default-constructs a
 * real `IAMClient` only when no client is supplied.
 */
import {
  IAMClient,
  GetRoleCommand,
  GetRolePolicyCommand,
  type GetRoleCommandOutput,
  type GetRolePolicyCommandOutput,
} from '@aws-sdk/client-iam';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';

/** Inline policy name the scoped citadel roles carry (PolicyManager convention). */
export const TRUST_PATH_INLINE_POLICY_NAME = 'DataStoreAccess';

export interface TrustPathPolicyStatementProjected {
  effect: string;
  actions: string[];
  resources: string[];
  conditionsJson: string | null;
}

export interface TrustPathRoleProjected {
  arn: string;
  name: string;
  scope: string;
  trustPolicyPrincipals: string[];
  inlinePolicy: TrustPathPolicyStatementProjected[];
  inlinePolicyName: string | null;
  totalActions: number;
  totalResources: number;
}

// ---------------------------------------------------------------------------
// Pure projection helpers (moved verbatim from governance-ui-resolver)
// ---------------------------------------------------------------------------

/**
 * Parse the trust policy JSON and collect every `Principal.AWS` entry
 * as a flat string array. Tolerates both string and array shapes —
 * IAM allows either form.
 */
export function parseTrustPolicyPrincipals(trustPolicyJson: string | undefined): string[] {
  if (!trustPolicyJson) return [];
  try {
    const policy = JSON.parse(trustPolicyJson);
    const statements = Array.isArray(policy?.Statement)
      ? policy.Statement
      : policy?.Statement
        ? [policy.Statement]
        : [];
    const principals: string[] = [];
    for (const stmt of statements) {
      const aws = stmt?.Principal?.AWS;
      if (typeof aws === 'string') {
        principals.push(aws);
      } else if (Array.isArray(aws)) {
        for (const entry of aws) {
          if (typeof entry === 'string') principals.push(entry);
        }
      }
    }
    return principals;
  } catch {
    return [];
  }
}

/**
 * Project an IAM inline policy document JSON into the GraphQL shape.
 * Coerces `Action` and `Resource` to string arrays (IAM permits either
 * a single string or an array). `Condition` is preserved verbatim as
 * stringified JSON so the frontend can pretty-print without losing
 * shape detail.
 */
export function projectInlinePolicyDocument(
  documentJson: string | undefined,
): TrustPathPolicyStatementProjected[] {
  if (!documentJson) return [];
  try {
    const doc = JSON.parse(documentJson);
    const statements = Array.isArray(doc?.Statement)
      ? doc.Statement
      : doc?.Statement
        ? [doc.Statement]
        : [];
    const projected: TrustPathPolicyStatementProjected[] = [];
    for (const stmt of statements) {
      const actionsRaw = stmt?.Action;
      const resourcesRaw = stmt?.Resource;
      const actions = typeof actionsRaw === 'string'
        ? [actionsRaw]
        : Array.isArray(actionsRaw)
          ? actionsRaw.filter((a): a is string => typeof a === 'string')
          : [];
      const resources = typeof resourcesRaw === 'string'
        ? [resourcesRaw]
        : Array.isArray(resourcesRaw)
          ? resourcesRaw.filter((r): r is string => typeof r === 'string')
          : [];
      const condition = stmt?.Condition;
      const conditionsJson =
        condition !== undefined && condition !== null
          ? JSON.stringify(condition)
          : null;
      projected.push({
        effect: typeof stmt?.Effect === 'string' ? stmt.Effect : 'Allow',
        actions,
        resources,
        conditionsJson,
      });
    }
    return projected;
  } catch {
    return [];
  }
}

/**
 * Extract a role name from an IAM role ARN. Returns the substring after
 * the final `/`. Handles both `arn:aws:iam::<acct>:role/<name>` and
 * paths like `arn:aws:iam::<acct>:role/path/to/<name>`.
 */
export function roleNameFromArn(arn: string): string {
  const slashIdx = arn.lastIndexOf('/');
  if (slashIdx < 0 || slashIdx === arn.length - 1) return arn;
  return arn.substring(slashIdx + 1);
}

/**
 * Parse the account-id segment from an AWS ARN
 * (`arn:partition:service:region:ACCOUNT:resource…`). Returns `null` when the
 * input is not a string, is not an ARN, or carries an empty account segment
 * (IAM/S3 ARNs legitimately omit it). Pure — never issues an IAM call.
 */
export function accountIdFromArn(arn: string | null | undefined): string | null {
  if (typeof arn !== 'string') return null;
  const segments = arn.split(':');
  // arn : partition : service : region : account : resource…
  if (segments.length < 6 || segments[0] !== 'arn') return null;
  const account = segments[4];
  return account.length > 0 ? account : null;
}

/**
 * True when `roleArn` resolves to an AWS account that differs from
 * `deploymentAccountId` — the account whose IAM the in-process
 * {@link computeTrustPath} can introspect (its `GetRole` runs in the home
 * account). Used by the imported-agent activation path to skip a same-account
 * trust-path check that could only fail for a cross-account role.
 *
 * Conservative by design: returns `false` whenever the comparison cannot be
 * made with confidence — a missing/blank `deploymentAccountId` or an
 * unparseable role-ARN account — so the caller stays on the unchanged
 * same-account path. Pure — never issues an IAM call.
 */
export function isCrossAccountRoleArn(
  roleArn: string | null | undefined,
  deploymentAccountId: string | null | undefined,
): boolean {
  if (typeof deploymentAccountId !== 'string' || deploymentAccountId.length === 0) {
    return false;
  }
  const roleAccount = accountIdFromArn(roleArn);
  if (roleAccount === null) return false;
  return roleAccount !== deploymentAccountId;
}

/**
 * Best-effort extraction of the optional `crossAccountRoleArn` field
 * from a resource record. Datastores and integrations store
 * configuration in a `config` blob; agents may surface it via
 * `customDescriptorContent` JSON. Returns `null` when absent or
 * malformed.
 */
export function extractCrossAccountRoleArn(
  record: Record<string, unknown> | null,
): string | null {
  if (!record) return null;
  // Top-level fast path.
  const direct = record.crossAccountRoleArn;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  // `config` may be a nested object on datastore / integration rows.
  const cfg = record.config;
  if (cfg && typeof cfg === 'object') {
    const fromCfg = (cfg as Record<string, unknown>).crossAccountRoleArn;
    if (typeof fromCfg === 'string' && fromCfg.length > 0) return fromCfg;
  }
  // Agent custom metadata path — try to parse customDescriptorContent.
  const metaRaw = record.customDescriptorContent;
  if (typeof metaRaw === 'string' && metaRaw.length > 0) {
    try {
      const parsed = JSON.parse(metaRaw);
      const fromMeta = parsed?.crossAccountRoleArn;
      if (typeof fromMeta === 'string' && fromMeta.length > 0) return fromMeta;
    } catch {
      /* swallow — malformed metadata is not a fatal error */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-hop IAM fetch (the pure core that getTrustPath delegates to)
// ---------------------------------------------------------------------------

export interface FetchTrustPathHopResult {
  hop: TrustPathRoleProjected;
  /** False when GetRole threw (role absent / unreadable). */
  roleFound: boolean;
  /** True when the inline policy was found and projected. */
  inlinePolicyFound: boolean;
  /** Contextual notes accumulated during the fetch (non-fatal conditions). */
  notes: string[];
}

/**
 * Fetch a single hop's role + inline policy using the injected IAM client.
 * Each IAM call is wrapped in its own try/catch — a missing role or absent
 * inline policy produces a hop with empty fields and a contextual note rather
 * than cratering the caller. Behaviour is identical to the private `buildHop`
 * that previously lived in governance-ui-resolver.
 */
export async function fetchTrustPathHop(
  iamClient: IAMClient,
  arn: string,
  scope: string,
  inlinePolicyName: string = TRUST_PATH_INLINE_POLICY_NAME,
): Promise<FetchTrustPathHopResult> {
  const notes: string[] = [];
  const name = roleNameFromArn(arn);

  let trustPolicyPrincipals: string[] = [];
  let roleFound = true;
  try {
    const roleOut: GetRoleCommandOutput = await iamClient.send(
      new GetRoleCommand({ RoleName: name }),
    );
    const trustPolicyEncoded = roleOut.Role?.AssumeRolePolicyDocument;
    // IAM may URL-encode the trust policy — decode if it doesn't already
    // look like raw JSON.
    const trustPolicyJson =
      typeof trustPolicyEncoded === 'string' && trustPolicyEncoded.length > 0
        ? (trustPolicyEncoded.trim().startsWith('{')
            ? trustPolicyEncoded
            : decodeURIComponent(trustPolicyEncoded))
        : undefined;
    trustPolicyPrincipals = parseTrustPolicyPrincipals(trustPolicyJson);
  } catch (err) {
    roleFound = false;
    notes.push(`Role ${arn} not found`);
    console.warn('getTrustPath: GetRole failed', { arn, error: (err as Error)?.message });
  }

  let inlinePolicy: TrustPathPolicyStatementProjected[] = [];
  let inlinePolicyNameOut: string | null = null;
  let inlinePolicyFound = false;
  if (roleFound) {
    try {
      const policyOut: GetRolePolicyCommandOutput = await iamClient.send(
        new GetRolePolicyCommand({
          RoleName: name,
          PolicyName: inlinePolicyName,
        }),
      );
      const documentEncoded = policyOut.PolicyDocument;
      const documentJson =
        typeof documentEncoded === 'string' && documentEncoded.length > 0
          ? (documentEncoded.trim().startsWith('{')
              ? documentEncoded
              : decodeURIComponent(documentEncoded))
          : undefined;
      inlinePolicy = projectInlinePolicyDocument(documentJson);
      inlinePolicyNameOut = inlinePolicyName;
      inlinePolicyFound = true;
    } catch (err) {
      notes.push(`Inline policy not present on ${arn}`);
      console.warn('getTrustPath: GetRolePolicy failed', { arn, error: (err as Error)?.message });
    }
  }

  let totalActions = 0;
  let totalResources = 0;
  for (const stmt of inlinePolicy) {
    totalActions += stmt.actions.length;
    totalResources += stmt.resources.length;
  }

  return {
    hop: {
      arn,
      name,
      scope,
      trustPolicyPrincipals,
      inlinePolicy,
      inlinePolicyName: inlinePolicyNameOut,
      totalActions,
      totalResources,
    },
    roleFound,
    inlinePolicyFound,
    notes,
  };
}

// ---------------------------------------------------------------------------
// computeTrustPath — hops + notes + issue-level findings + clean flag
// ---------------------------------------------------------------------------

/** Summary returned by {@link computeTrustPath}. */
export interface TrustPathResult {
  hops: TrustPathRoleProjected[];
  notes: string[];
  /** Issue-level findings: role-not-found, missing-trust, over-broad-*. */
  findings: string[];
  /** True iff there are zero issue-level findings (conservative). */
  clean: boolean;
}

export interface ComputeTrustPathDeps {
  /** Injected IAM client. A real `IAMClient` is constructed when omitted. */
  iamClient?: IAMClient;
  /** Optional second hop following the primary role (cross-account assume). */
  crossAccountRoleArn?: string | null;
  /** Scope label applied to the primary hop (default `'role'`). */
  scope?: string;
  /** Inline policy name to inspect (defaults to the citadel convention). */
  inlinePolicyName?: string;
}

/** An action is over-broad when it is `*` or a service-wide `<svc>:*`. */
function isWildcardAction(action: string): boolean {
  return action === '*' || action.endsWith(':*');
}

/**
 * Derive issue-level findings for one fetched hop. Conservative by design —
 * any drift / over-broad / missing-trust signal contributes a finding, which
 * forces `clean:false` so the activation auto-attest never fires on a role we
 * could not positively verify as scoped.
 */
function collectHopFindings(result: FetchTrustPathHopResult, findings: string[]): void {
  const { hop, roleFound } = result;
  if (!roleFound) {
    // The expected role does not exist / is unreadable — treat as drift.
    findings.push(`role-not-found: ${hop.arn}`);
    return;
  }
  if (hop.trustPolicyPrincipals.length === 0) {
    // No AWS principal can assume the role — the trust edge is unverifiable.
    findings.push(`missing-trust: ${hop.arn} has no assumable AWS principals`);
  }
  for (const stmt of hop.inlinePolicy) {
    if (stmt.effect === 'Deny') continue;
    if (stmt.actions.some(isWildcardAction)) {
      findings.push(`over-broad-action: ${hop.arn}`);
      break;
    }
  }
  for (const stmt of hop.inlinePolicy) {
    if (stmt.effect === 'Deny') continue;
    if (stmt.resources.includes('*')) {
      findings.push(`over-broad-resource: ${hop.arn}`);
      break;
    }
  }
}

/**
 * Build the trust path for `roleArn` (plus an optional cross-account hop) and
 * derive `findings` + a conservative `clean` flag. Used by the imported-agent
 * activation path to decide whether to auto-attest. Never reaches live AWS when
 * an `iamClient` is injected.
 *
 * An empty / non-string `roleArn` short-circuits to a single `invalid-role-arn`
 * finding (clean:false) without issuing any IAM call.
 */
export async function computeTrustPath(
  roleArn: string,
  deps: ComputeTrustPathDeps = {},
): Promise<TrustPathResult> {
  const hops: TrustPathRoleProjected[] = [];
  const notes: string[] = [];
  const findings: string[] = [];

  if (typeof roleArn !== 'string' || roleArn.trim().length === 0) {
    findings.push('invalid-role-arn: roleArn must be a non-empty string');
    return { hops, notes, findings, clean: false };
  }

  const iamClient = deps.iamClient ?? new IAMClient({});

  const primary = await fetchTrustPathHop(
    iamClient,
    roleArn,
    deps.scope ?? 'role',
    deps.inlinePolicyName,
  );
  hops.push(primary.hop);
  notes.push(...primary.notes);
  collectHopFindings(primary, findings);

  if (typeof deps.crossAccountRoleArn === 'string' && deps.crossAccountRoleArn.length > 0) {
    const cross = await fetchTrustPathHop(
      iamClient,
      deps.crossAccountRoleArn,
      'cross-account',
      deps.inlinePolicyName,
    );
    hops.push(cross.hop);
    notes.push(...cross.notes);
    collectHopFindings(cross, findings);
  }

  return { hops, notes, findings, clean: findings.length === 0 };
}


// ---------------------------------------------------------------------------
// assumeRoleCredentials — cross-account RAW temporary-credentials primitive
// ---------------------------------------------------------------------------

/**
 * Raw, short-lived AWS credentials returned by {@link assumeRoleCredentials}.
 * Structurally a subset of the AWS SDK v3 `AwsCredentialIdentity`, so it is
 * accepted verbatim by any v3 client's `credentials` config (IAM, STS, the
 * ResourceGroupsTaggingAPI client, …). The secret material is NEVER logged by
 * this module, and callers are expected to keep it out of logs too.
 */
export interface AssumedRoleCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiration?: Date;
}

/** Injectable dependencies for {@link assumeRoleCredentials}. */
export interface AssumeRoleCredentialsDeps {
  /** Injected STS client. A real `STSClient` is constructed when omitted. */
  stsClient?: STSClient;
  /**
   * CloudTrail-friendly `RoleSessionName` prefix (a random suffix is appended).
   * Defaults to `import-assume`; callers pick a context-specific prefix
   * (e.g. `import-tagscan` for a cross-account tag scan, `import-trustpath` for
   * the analysis-role assume).
   */
  sessionNamePrefix?: string;
}

/**
 * Assume an operator-supplied role (cross-account, externalId-gated) via STS
 * and return the RAW temporary credentials. Sibling of
 * {@link assumeAnalysisRoleClient}: that helper wraps the result in an
 * `IAMClient`; this one hands back the credentials so a caller can wire ANY
 * cross-account SDK client — e.g. a `ResourceGroupsTaggingAPIClient` for a
 * cross-account tag scan — with the assumed identity.
 *
 * The `externalId` is threaded into the `AssumeRoleCommand` only when present
 * (the cross-account confused-deputy control). The STS client is injectable for
 * testing; production callers omit `deps`.
 *
 * Security: the returned credentials are NEVER logged here. They are intended
 * only to be wired into an SDK client's `credentials` config.
 *
 * @throws when STS returns no usable credentials. The caller treats a throw as
 *   a failed assume (e.g. an empty scan) and must NEVER silently fall back to
 *   its own identity (which would act in the wrong account).
 */
export async function assumeRoleCredentials(
  roleArn: string,
  externalId: string | undefined,
  deps: AssumeRoleCredentialsDeps = {},
): Promise<AssumedRoleCredentials> {
  const stsClient = deps.stsClient ?? new STSClient({});
  const prefix = deps.sessionNamePrefix ?? 'import-assume';

  // Short, CloudTrail-friendly session suffix (RoleSessionName ≤ 64 chars,
  // [\w+=,.@-]). Random so concurrent assumes don't collide.
  const sessionSuffix = Math.random().toString(36).slice(2, 10);

  const result = await stsClient.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `${prefix}-${sessionSuffix}`,
      ...(externalId ? { ExternalId: externalId } : {}),
    }),
  );

  const creds = result.Credentials;
  if (
    !creds ||
    !creds.AccessKeyId ||
    !creds.SecretAccessKey ||
    !creds.SessionToken
  ) {
    throw new Error(
      'assumeRoleCredentials: STS AssumeRole returned no usable credentials',
    );
  }

  return {
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.SessionToken,
    ...(creds.Expiration ? { expiration: creds.Expiration } : {}),
  };
}

// ---------------------------------------------------------------------------
// assumeAnalysisRoleClient — cross-account read-only analysis-role assume
// ---------------------------------------------------------------------------

/** Injectable dependencies for {@link assumeAnalysisRoleClient}. */
export interface AssumeAnalysisRoleDeps {
  /** Injected STS client. A real `STSClient` is constructed when omitted. */
  stsClient?: STSClient;
}

/**
 * Assume an operator-supplied READ-ONLY analysis role in the TARGET account of
 * a cross-account imported-agent `roleArn`, and return an {@link IAMClient}
 * wired with the returned temporary credentials. The returned client can then
 * be handed to {@link computeTrustPath} via `{ iamClient }` so its
 * `iam:GetRole`/`GetRolePolicy` reads run in the target account.
 *
 * The cross-account confused-deputy control is the caller-supplied
 * `externalId`, threaded into the `AssumeRoleCommand` only when present
 * (mirroring PolicyManager.assumeScopedRole). The session name is prefixed
 * `import-trustpath-` for CloudTrail attribution.
 *
 * Security:
 *   - Read-only: the assumed role is expected to grant only IAM read actions;
 *     this helper itself never writes.
 *   - The raw temporary credentials never leave this function except wired into
 *     the IAM client config — they are NEVER logged or returned to the caller.
 *
 * Throws if STS returns no usable credentials; the caller (activation path)
 * treats any throw as best-effort and leaves the attestation 'pending'.
 */
export async function assumeAnalysisRoleClient(
  analysisRoleArn: string,
  externalId: string | undefined,
  deps: AssumeAnalysisRoleDeps = {},
): Promise<IAMClient> {
  // Delegate to the shared RAW-credentials primitive (single source of truth
  // for the STS assume + externalId gating), preserving the `import-trustpath-`
  // session-name prefix for CloudTrail attribution.
  const creds = await assumeRoleCredentials(analysisRoleArn, externalId, {
    stsClient: deps.stsClient,
    sessionNamePrefix: 'import-trustpath',
  });

  return new IAMClient({
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}
