import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, DeleteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { RegistryService, RegistryRecordStatusValues } from '../services/registry-service';
import type {
  AgentInvocationProtocol,
  AgentCustomMetadata,
  AgentInvocationBlock,
  AgentOrigin,
} from '../services/registry-service';
import { extractOrgFromEvent, isAdminFromEvent } from '../utils/auth-event';
import { getGovernanceEnforce } from '../utils/governance-flag';
import { publishEvent } from '../utils/events';
import { computeTrustPath, isCrossAccountRoleArn, assumeAnalysisRoleClient } from '../utils/trust-path';

/** Trust-path summary persisted into governanceAttestation by the activation path. */
interface TrustPathAttestationSummary {
  checkedAt: string;
  clean: boolean;
  findings: string[];
  /**
   * Phase-2 marker: `true` when `invocation.roleArn` was detected as
   * cross-account and the same-account {@link computeTrustPath} check was
   * therefore skipped. Additive/optional so same-account summaries serialize
   * byte-identically to Phase-1.
   */
  crossAccount?: boolean;
}

/**
 * The registry-service governanceAttestation shape augmented with the additive
 * `trustPath` summary stamped by the lazy activation-time IAM trust-path check.
 * Declared locally (NOT in registry-service) so that module stays unchanged;
 * the extra field is serialized verbatim via serializeCustomMetadata.
 */
type GovernanceAttestationWithTrustPath =
  NonNullable<AgentCustomMetadata['governanceAttestation']> & {
    trustPath?: TrustPathAttestationSummary;
  };

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const AGENT_CONFIG_TABLE = process.env.AGENT_CONFIG_TABLE!;

// ---------------------------------------------------------------------------
// Feature flag + Registry Service initialization (task 6.1)
// ---------------------------------------------------------------------------

/**
 * Returns true when the Registry feature flag is enabled.
 * Defaults to false if the environment variable is missing or unreadable.
 */
export function isRegistryEnabled(): boolean {
  try {
    return process.env.REGISTRY_ENABLED === 'true';
  } catch {
    return false;
  }
}

/** Lazily-initialised RegistryService singleton (created on first use). */
let registryServiceInstance: RegistryService | null = null;

/**
 * Returns the shared RegistryService instance, creating it on first call.
 * Only call this when `isRegistryEnabled()` is true — the function reads
 * REGISTRY_ID from the environment and will throw if it is missing.
 */
export function getRegistryService(): RegistryService {
  if (!registryServiceInstance) {
    const registryId = process.env.REGISTRY_ID;
    if (!registryId) {
      throw new Error('REGISTRY_ID environment variable is required when REGISTRY_ENABLED is true');
    }
    registryServiceInstance = new RegistryService({
      registryId,
      region: process.env.AWS_REGION || 'us-east-1',
    });
  }
  return registryServiceInstance;
}

/**
 * Resets the cached RegistryService instance.
 * Exposed for testing so that tests can clear state between runs.
 * @internal
 */
export function _resetRegistryService(): void {
  registryServiceInstance = null;
}

interface AgentConfig {
  agentId: string;
  orgId: string;
  config: string | Record<string, unknown>;
  state: 'active' | 'inactive' | 'maintenance' | 'pending' | string;
  categories?: string[] | string;
  createdAt?: string;
  updatedAt?: string;
}

/** Merged create/update mutation input (config required only on create). */
interface AgentConfigMutationInput {
  agentId: string;
  config?: string | Record<string, unknown>;
  state?: string;
  categories?: string[] | string;
  icon?: string;
  appId?: string;
}

/** Minimal slice of the AppSync event needed for org/admin extraction. */
type OrgScopedEvent = { identity?: Record<string, unknown> };

/** AppSync event shape as dispatched to this resolver's handler. */
interface AgentConfigResolverEvent extends OrgScopedEvent {
  info: { fieldName: string };
  arguments: Record<string, unknown>;
}

/** Loose manifest shape as parsed from AWSJSON; validated at runtime. */
export interface RawAgentManifest {
  name?: unknown;
  description?: unknown;
  version?: unknown;
}

export const handler = async (event: AgentConfigResolverEvent) => {
  console.log('Event:', JSON.stringify(event, null, 2));

  const fieldName = event.info.fieldName;

  try {
    const registryEnabled = isRegistryEnabled();

    switch (fieldName) {
      case 'listAgentConfigs':
        return registryEnabled
          ? await listAgentConfigsRegistry(event)
          : await listAgentConfigs();

      case 'getAgentConfig':
        return registryEnabled
          ? await getAgentConfigRegistry(event.arguments.agentId as string, event)
          : await getAgentConfig(event.arguments.agentId as string);

      case 'createAgentConfig':
        return registryEnabled
          ? await createAgentConfigRegistry(event.arguments.input as AgentConfigMutationInput, event)
          : await createAgentConfig(event.arguments.input as AgentConfigMutationInput);

      case 'updateAgentConfig':
        return registryEnabled
          ? await updateAgentConfigRegistry(event.arguments.input as AgentConfigMutationInput, event)
          : await updateAgentConfig(event.arguments.input as AgentConfigMutationInput);

      case 'deleteAgentConfig':
        return registryEnabled
          ? await deleteAgentConfigRegistry(event.arguments.agentId as string)
          : await deleteAgentConfig(event.arguments.agentId as string);

      case 'publishAgentManifest':
        return registryEnabled
          ? await publishAgentManifestRegistry(event.arguments.agentId as string, event.arguments.manifest as string)
          : await publishAgentManifest(event.arguments.agentId as string, event.arguments.manifest as string);

      case 'searchAgentConfigs':
        return await searchAgentConfigsRegistry(event.arguments.query as string);

      case 'activateProjectAgents':
        return await activateProjectAgents(event.arguments.projectId as string);

      default:
        throw new Error(`Unknown field: ${fieldName}`);
    }
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
};

/**
 * Registry-first get: checks Registry for the agent, falls back to DynamoDB
 * if not found or if Registry is unavailable. Returns null when neither
 * source has the record.
 *
 * Error handling per design:
 * - Registry returns null (404) → fall back to DynamoDB
 * - Registry throws (unavailable / transient error) → log warning, fall
 *   back to DynamoDB so get queries can degrade gracefully
 */
export async function getAgentConfigRegistry(agentId: string, event?: OrgScopedEvent): Promise<AgentConfig | null> {
  const registryService = getRegistryService();
  const callerOrgId = event !== undefined ? await extractOrgFromEvent(event) : null;
  const admin = event !== undefined ? isAdminFromEvent(event) : false;
  try {
    const record = await registryService.getResource('agent', agentId);
    if (record) {
      const mapped = registryService.mapToAgentConfig(record);
      // Cross-org access is reported as not-found (404-style, not 403) so we
      // don't leak existence to other orgs. Admins bypass.
      if (!admin && mapped.orgId && mapped.orgId !== callerOrgId) {
        return null;
      }
      return mapped;
    }
  } catch (err) {
    console.warn(
      `Registry getResource failed for agent ${agentId}, falling back to DynamoDB:`,
      err,
    );
  }
  // Fallback to DynamoDB for legacy records (or on Registry error)
  const legacy = await getAgentConfig(agentId);
  if (!legacy) return null;
  if (!admin && legacy.orgId && legacy.orgId !== callerOrgId) {
    return null;
  }
  return legacy;
}

/**
 * Dual-source list: fetches agent configs from both Registry and DynamoDB,
 * merges them with Registry records taking precedence on duplicate agentIds.
 *
 * Results are filtered to the caller's organization unless the caller has
 * `custom:role=admin`, in which case the full list (across all orgs) is
 * returned — matching the "All Organizations" admin UX. Agents with an
 * empty orgId ('') are system-shared (e.g. seeded demo agents) and are
 * visible to every org-scoped caller. A non-admin caller without an orgId
 * receives an empty list with a warning, so anonymous / api-key callers
 * never see cross-tenant data.
 */
export async function listAgentConfigsRegistry(event?: OrgScopedEvent): Promise<AgentConfig[]> {
  const callerOrgId = event !== undefined ? await extractOrgFromEvent(event) : null;
  const admin = event !== undefined ? isAdminFromEvent(event) : false;

  if (!admin && !callerOrgId) {
    console.warn('listAgentConfigsRegistry: no caller orgId and not admin; returning empty list');
    return [];
  }

  // 1. Fetch Registry records and map to AgentConfig
  const registryService = getRegistryService();
  const registryRecords = await registryService.listResources('agent');
  const allRegistryConfigs = registryRecords.map((record) =>
    registryService.mapToAgentConfig(record),
  );
  const registryConfigs = admin
    ? allRegistryConfigs
    : allRegistryConfigs.filter((a) => a.orgId === callerOrgId || a.orgId === '');

  // 2. Fetch DynamoDB legacy records
  const allDynamoConfigs = await listAgentConfigs();
  const dynamoConfigs = admin
    ? allDynamoConfigs
    : allDynamoConfigs.filter((a) => a.orgId === callerOrgId || a.orgId === '');

  // 3. Build set of names from Registry (Registry wins on duplicates).
  //    Post-420d0ae, registryConfigs[].agentId is a 12-char recordId while
  //    dynamoConfigs[].agentId is still the legacy name. Dedupe by the
  //    `name` field inside the config payload — the stable human
  //    identifier shared by both representations. Guard against
  //    unparseable/missing names so we don't over-filter.
  const extractName = (c: AgentConfig): string | undefined => {
    if (!c.config) return undefined;
    try {
      const parsed = typeof c.config === 'string' ? JSON.parse(c.config) : c.config;
      const name = parsed?.name;
      return typeof name === 'string' && name.length > 0 ? name : undefined;
    } catch {
      return undefined;
    }
  };
  const registryNames = new Set(
    registryConfigs
      .map(extractName)
      .filter((n): n is string => typeof n === 'string' && n.length > 0),
  );

  // 4. Filter DynamoDB records to exclude duplicates
  const legacyOnly = dynamoConfigs.filter((c) => {
    const n = extractName(c);
    return !n || !registryNames.has(n);
  });

  // 5. Return merged list
  return [...registryConfigs, ...legacyOnly];
}

/**
 * Registry-backed create: serializes custom metadata and creates a Registry
 * resource. Returns the mapped AgentConfig.
 *
 * The caller's organization is pulled from the AppSync event (JWT
 * `custom:organization` claim) and stored inside customMetadata. Input
 * payloads never carry orgId — per D1(a) the backend is the sole source
 * of truth for tenant assignment.
 */
export async function createAgentConfigRegistry(input: AgentConfigMutationInput, event?: OrgScopedEvent): Promise<AgentConfig> {
  const registryService = getRegistryService();

  const orgId = await extractOrgFromEvent(event);
  if (!orgId) {
    throw new Error('Cannot determine caller organization');
  }

  const config = typeof input.config === 'string' ? input.config : JSON.stringify(input.config);
  const parsedConfig = typeof input.config === 'string' ? JSON.parse(input.config) : input.config;

  const customMetadata = registryService.serializeCustomMetadata({
    categories: input.categories || [],
    icon: input.icon || '',
    state: input.state || 'active',
    appId: input.appId || undefined,
    orgId,
  } as AgentCustomMetadata);

  const record = await registryService.createResource('agent', input.agentId, {
    name: parsedConfig.name || input.agentId,
    description: config,
    customMetadata,
  });

  // If an initial state is provided, update the status accordingly
  if (input.state) {
    const registryStatus = registryService.toRegistryStatus(input.state);
    await registryService.updateResourceStatus('agent', input.agentId, registryStatus);
    // Re-fetch after status transition so the returned state reflects the
    // post-SubmitForApproval record (PENDING_APPROVAL or APPROVED) rather
    // than the stale DRAFT snapshot from createResource above.
    const refreshed = await registryService.getResource('agent', input.agentId);
    return registryService.mapToAgentConfig(refreshed ?? record);
  }

  return registryService.mapToAgentConfig(record);
}

/**
 * Governance activation gate for imported agents (US-IMP governance retrofit).
 *
 * Applied at the APPROVED (activation) transition for an IMPORTED, not-yet-
 * attested Registry record. An imported record is one whose deserialized
 * customMetadata carries a `governanceAttestation` block (stamped by the import
 * resolver); non-imported agents never have it, so the gate is a pure no-op for
 * them.
 *
 * Trigger — ALL of:
 *   (i)   target status is APPROVED  → enforced by the CALL-SITE (this helper is
 *         only invoked on the APPROVED transition), so it assumes (i) holds.
 *   (ii)  record is imported          → `governanceAttestation` present.
 *   (iii) not yet attested            → `governanceAttestation.status !== 'attested'`.
 *
 * On trigger:
 *   - strict              → THROW before the caller writes APPROVED status.
 *   - shadow | permissive → best-effort "would-block" telemetry event, then
 *                           return so the caller proceeds with activation.
 *
 * When NOT triggered (no attestation, or already attested) this returns
 * immediately WITHOUT reading the governance flag or emitting any event, so the
 * behaviour of every non-imported / already-attested activation is byte-
 * identical to the pre-gate code path.
 *
 * `getGovernanceEnforce` fails open to 'permissive' internally (never throws),
 * so an absent/unreadable SSM parameter can never hard-fail an activation.
 */
async function enforceImportActivationGate(
  registryService: RegistryService,
  agentId: string,
  customDescriptorContent: string | undefined,
): Promise<void> {
  const meta = registryService.deserializeCustomMetadata<{
    governanceAttestation?: { status: 'pending' | 'attested' };
  }>(customDescriptorContent ?? null, { governanceAttestation: undefined });

  const attestation = meta.governanceAttestation;
  // (ii) not imported, or (iii) already attested → no-op.
  if (!attestation || attestation.status === 'attested') {
    return;
  }

  const mode = await getGovernanceEnforce(process.env.ENVIRONMENT || 'unknown');
  if (mode === 'strict') {
    throw new Error(
      `Activation blocked: governance attestation pending for imported agent ${agentId}`,
    );
  }

  // shadow | permissive → emit best-effort telemetry that the gate WOULD have
  // blocked this activation, then proceed. A telemetry outage must never fail
  // (or alter the result of) the activation, so the emit is swallowed on error.
  try {
    await publishEvent({
      eventType: 'agent.import.activation_gate',
      projectId: '',
      agentId,
      payload: {
        agentId,
        attestationStatus: attestation.status,
        mode,
        wouldBlock: true,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error(
      `agent-config-resolver: best-effort activation-gate event for ${agentId} failed (swallowed):`,
      err,
    );
  }
}

/**
 * Registry-backed update: updates the Registry resource with new metadata.
 * If state is being changed, also updates the Registry status via toRegistryStatus.
 * Returns the mapped AgentConfig.
 *
 * orgId is never changed by an update: we preserve existingMeta.orgId when
 * present, and fall back to the caller's JWT org for legacy records that
 * predate Phase-2a. Input payloads never carry orgId.
 */
export async function updateAgentConfigRegistry(input: AgentConfigMutationInput, event?: OrgScopedEvent): Promise<AgentConfig> {
  const registryService = getRegistryService();

  // Fetch existing record to merge with
  const existing = await registryService.getResource('agent', input.agentId);
  if (!existing) {
    throw new Error(`Agent config not found: ${input.agentId}`);
  }

  const existingMeta = registryService.deserializeCustomMetadata<{
    categories: string[];
    icon: string;
    state: string;
    appId?: string;
    manifest?: Record<string, unknown>;
    orgId?: string;
  }>(existing.customDescriptorContent ?? null, {
    categories: [],
    icon: '',
    state: 'active',
    appId: undefined,
    manifest: undefined,
    orgId: undefined,
  });

  // Merge config
  const newConfig = input.config
    ? (typeof input.config === 'string' ? input.config : JSON.stringify(input.config))
    : existing.description;

  // Parse the merged config to extract the agent's display name. Some legacy
  // records carry a free-text description rather than a JSON blob in the
  // description field — for those records we fall back to {} and reuse the
  // existing record's name. Never throw here: a state-only toggle (e.g. the
  // Activate / Deactivate button) has no input.config and must not blow up
  // on a malformed legacy description.
  let parsedNewConfig: Record<string, unknown> = {};
  if (newConfig && typeof newConfig === 'string') {
    try {
      parsedNewConfig = JSON.parse(newConfig);
    } catch {
      parsedNewConfig = {};
    }
  } else if (newConfig && typeof newConfig === 'object') {
    parsedNewConfig = newConfig;
  }

  // Preserve existing orgId; fall back to caller for legacy records.
  // Never derive orgId from input — that field is backend-owned.
  const preservedOrgId = existingMeta.orgId
    ?? (event !== undefined ? (await extractOrgFromEvent(event)) ?? undefined : undefined);

  // Desired Registry status computed up-front: the lazy trust-path attestation
  // below only fires on the APPROVED (activation) transition, and the gate
  // further down consumes the same value.
  const desiredRegistryStatus = input.state
    ? registryService.toRegistryStatus(input.state)
    : undefined;

  // US-IMP lazy IAM trust-path attestation. On the APPROVED activation of an
  // IMPORTED (governanceAttestation present), still-'pending' record whose
  // invocation.roleArn is set, inspect that role's IAM trust path in-process
  // and — when it is clean — auto-attest so the activation gate passes in this
  // same request. Best-effort: any failure (unresolvable / cross-account role,
  // IAM denial) is logged and swallowed, leaving the attestation 'pending' so
  // the gate governs unchanged. Roleless-imported and non-imported records
  // never reach computeTrustPath, so their behaviour is byte-identical.
  const importView = registryService.deserializeCustomMetadata<{
    governanceAttestation?: GovernanceAttestationWithTrustPath;
    invocation?: AgentInvocationBlock;
    origin?: AgentOrigin;
  }>(existing.customDescriptorContent ?? null, {
    governanceAttestation: undefined,
    invocation: undefined,
    origin: undefined,
  });

  let importAttestationToPersist: GovernanceAttestationWithTrustPath | undefined;
  let gateContentOverride: string | undefined;
  const existingAttestation = importView.governanceAttestation;
  const invocationRoleArn = importView.invocation?.roleArn;
  if (
    input.state &&
    desiredRegistryStatus === RegistryRecordStatusValues.APPROVED &&
    desiredRegistryStatus !== existing.status &&
    existingAttestation &&
    existingAttestation.status === 'pending' &&
    typeof invocationRoleArn === 'string' &&
    invocationRoleArn.length > 0
  ) {
    // Phase-2 cross-account awareness. When invocation.roleArn lives in a
    // DIFFERENT account than this deployment (ACCOUNT_ID), the same-account,
    // in-process computeTrustPath cannot introspect it — its GetRole runs in the
    // home account and would just fail. Detection is best-effort: when
    // ACCOUNT_ID is not configured (or the role ARN account is unparseable)
    // isCrossAccountRoleArn returns false and the same-account branch below runs
    // byte-identically to Phase-1, so same-account behaviour is unchanged.
    if (isCrossAccountRoleArn(invocationRoleArn, process.env.ACCOUNT_ID)) {
      // Phase-2 cross-account FULL introspection. When the operator supplied a
      // READ-ONLY analysisRoleArn in the TARGET account, assume it
      // (externalId-gated) to obtain a cross-account IAM client and run the SAME
      // trust-path check there — then behave exactly like the same-account
      // success path (auto-attest clean / pending+findings). With NO
      // analysisRoleArn, keep the original 276ea59 manual-attestation finding.
      // Either way the summary carries crossAccount:true. BEST-EFFORT: any
      // assume / introspection failure records a finding and leaves the
      // attestation 'pending' so the gate governs — activation is NEVER crashed,
      // and the temporary credentials never reach this scope (the helper
      // encapsulates them) so they cannot be logged.
      const analysisRoleArn = importView.invocation?.analysisRoleArn;
      if (typeof analysisRoleArn === 'string' && analysisRoleArn.length > 0) {
        try {
          const crossAccountIamClient = await assumeAnalysisRoleClient(
            analysisRoleArn,
            importView.invocation?.externalId,
          );
          const tp = await computeTrustPath(invocationRoleArn, {
            iamClient: crossAccountIamClient,
          });
          const summary: TrustPathAttestationSummary = {
            checkedAt: new Date().toISOString(),
            clean: tp.clean,
            crossAccount: true,
            findings: tp.findings,
          };
          importAttestationToPersist = tp.clean
            ? {
                ...existingAttestation,
                status: 'attested',
                attestedBy: 'system:trust-path',
                attestedAt: summary.checkedAt,
                trustPath: summary,
              }
            : { ...existingAttestation, trustPath: summary };
        } catch (err) {
          // Best-effort: never log credentials (none reach this scope — the
          // helper owns the STS temp creds). Record a finding and leave
          // 'pending' for the gate / manual attestation.
          console.error(
            `agent-config-resolver: cross-account analysis-role trust-path for ` +
              `${input.agentId} failed (best-effort, leaving 'pending'):`,
            err instanceof Error ? err.message : String(err),
          );
          const summary: TrustPathAttestationSummary = {
            checkedAt: new Date().toISOString(),
            clean: false,
            crossAccount: true,
            findings: [
              'cross-account analysis-role assume failed; manual attestation required',
            ],
          };
          importAttestationToPersist = { ...existingAttestation, trustPath: summary };
        }
      } else {
        const summary: TrustPathAttestationSummary = {
          checkedAt: new Date().toISOString(),
          clean: false,
          crossAccount: true,
          findings: [
            'cross-account-role: automated trust-path unavailable; manual attestation required',
          ],
        };
        importAttestationToPersist = { ...existingAttestation, trustPath: summary };
      }
    } else {
      try {
        const tp = await computeTrustPath(invocationRoleArn);
        const summary: TrustPathAttestationSummary = {
          checkedAt: new Date().toISOString(),
          clean: tp.clean,
          findings: tp.findings,
        };
        importAttestationToPersist = tp.clean
          ? {
              ...existingAttestation,
              status: 'attested',
              attestedBy: 'system:trust-path',
              attestedAt: summary.checkedAt,
              trustPath: summary,
            }
          : { ...existingAttestation, trustPath: summary };
      } catch (err) {
        // Best-effort: leave the attestation 'pending' and let the gate govern.
        console.error(
          `agent-config-resolver: trust-path attestation for ${input.agentId} failed ` +
            `(best-effort, leaving 'pending'):`,
          err,
        );
      }
    }
  }

  // Merge custom metadata. The 6-field base is byte-identical to the pre-US-IMP
  // path; the imported governance blocks (invocation / origin /
  // governanceAttestation) are folded back in ONLY when the trust-path
  // attestation actually ran, so every non-imported / roleless / non-activation
  // update persists exactly the same metadata as before.
  const baseMeta = {
    categories: input.categories !== undefined ? input.categories : existingMeta.categories,
    icon: input.icon !== undefined ? input.icon : existingMeta.icon,
    state: input.state || existingMeta.state,
    appId: input.appId !== undefined ? input.appId : existingMeta.appId,
    manifest: existingMeta.manifest,
    orgId: preservedOrgId,
  };
  const updatedMeta = registryService.serializeCustomMetadata(
    (importAttestationToPersist
      ? {
          ...baseMeta,
          invocation: importView.invocation,
          origin: importView.origin,
          governanceAttestation: importAttestationToPersist,
        }
      : baseMeta) as AgentCustomMetadata,
  );
  if (importAttestationToPersist) {
    // The gate reads attestation status from this content; hand it the freshly
    // attested view so a same-request auto-attest lets activation proceed.
    gateContentOverride = updatedMeta;
  }

  const record = await registryService.updateResource('agent', input.agentId, {
    name: (parsedNewConfig.name as string | undefined) || existing.name,
    description: newConfig,
    customMetadata: updatedMeta,
  });

  // If the caller changed state, propagate to the Registry status as well.
  // Gate on the actual Registry status, not the metadata — customMetadata.state
  // can drift out of sync with record.status (e.g. when deserialize falls back
  // to its 'active' default for records missing the field). The user-facing
  // state is derived from record.status via toInternalState, so that's what
  // must change for the toggle to actually take effect.
  if (input.state && desiredRegistryStatus && desiredRegistryStatus !== existing.status) {
    // Governance activation gate (US-IMP): runs ONLY on the APPROVED transition
    // for an imported, unattested record. A no-op for every other record and
    // transition, so all non-activation / non-imported update paths are
    // unchanged. In strict mode it throws here, BEFORE the APPROVED status write.
    // When the lazy trust-path auto-attested above, gateContentOverride carries
    // the attested metadata so this gate sees 'attested' and is a no-op.
    if (desiredRegistryStatus === RegistryRecordStatusValues.APPROVED) {
      await enforceImportActivationGate(
        registryService,
        input.agentId,
        gateContentOverride ?? existing.customDescriptorContent ?? undefined,
      );
    }
    await registryService.updateResourceStatus('agent', input.agentId, desiredRegistryStatus);
    // Re-fetch after status transition so the returned state reflects the
    // post-SubmitForApproval record (PENDING_APPROVAL or APPROVED) rather
    // than the stale DRAFT/UPDATING snapshot from updateResource above.
    const refreshed = await registryService.getResource('agent', input.agentId);
    return registryService.mapToAgentConfig(refreshed ?? record);
  }

  return registryService.mapToAgentConfig(record);
}

/**
 * Registry-backed delete: deletes the resource from the Registry.
 * Returns success/failure object matching the existing shape.
 */
export async function deleteAgentConfigRegistry(agentId: string): Promise<{ success: boolean; message?: string }> {
  const registryService = getRegistryService();
  try {
    await registryService.deleteResource('agent', agentId);
    return {
      success: true,
      message: `Agent config ${agentId} deleted successfully`,
    };
  } catch (error) {
    console.error('Error deleting agent config from Registry:', error);
    return {
      success: false,
      message: `Failed to delete agent config: ${error}`,
    };
  }
}

/**
 * Registry-backed manifest publish: validates the manifest, fetches the
 * existing record, updates custom metadata with the new manifest, and
 * calls updateResource. Returns the mapped AgentConfig.
 */
export async function publishAgentManifestRegistry(agentId: string, manifestStr: string): Promise<AgentConfig> {
  // Parse the AWSJSON manifest string
  let manifest: RawAgentManifest;
  try {
    manifest = JSON.parse(manifestStr);
  } catch {
    throw new Error('Invalid manifest JSON: unable to parse');
  }

  // Validate required fields
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    throw new Error(`Manifest validation failed: ${validation.errors.join('; ')}`);
  }

  const registryService = getRegistryService();

  // Verify agent exists in Registry
  const existing = await registryService.getResource('agent', agentId);
  if (!existing) {
    throw new Error(`Agent config not found: ${agentId}`);
  }

  // Deserialize existing custom metadata and merge in the new manifest
  const existingMeta = registryService.deserializeCustomMetadata<{
    categories: string[];
    icon: string;
    state: string;
    appId?: string;
    manifest?: Record<string, unknown>;
    orgId?: string;
  }>(existing.customDescriptorContent ?? null, {
    categories: [],
    icon: '',
    state: 'active',
    appId: undefined,
    manifest: undefined,
    orgId: undefined,
  });

  const updatedMeta = registryService.serializeCustomMetadata({
    ...existingMeta,
    manifest,
  } as AgentCustomMetadata);

  const record = await registryService.updateResource('agent', agentId, {
    name: existing.name,
    description: existing.description,
    customMetadata: updatedMeta,
  });

  return registryService.mapToAgentConfig(record);
}

/**
 * Searches for agent configs via Registry semantic search.
 * Returns results mapped to the AgentConfig GraphQL type.
 */
async function searchAgentConfigsRegistry(query: string): Promise<AgentConfig[]> {
  const registryService = getRegistryService();
  const records = await registryService.searchResources('agent', query);
  return records.map((record) => registryService.mapToAgentConfig(record));
}

/** Result of a bulk activation, grouped by per-agent outcome. */
interface ActivateAgentsResult {
  activated: string[];
  failed: string[];
  alreadyActive: string[];
}

/**
 * Parses a Registry record's customDescriptorContent JSON and returns its
 * `sourceProjectId` when present. Malformed/missing metadata yields
 * `undefined` rather than throwing — a single bad record must not abort the
 * whole bulk operation.
 */
function extractSourceProjectId(customDescriptorContent: string | undefined): string | undefined {
  if (!customDescriptorContent) return undefined;
  try {
    const parsed = JSON.parse(customDescriptorContent);
    if (parsed && typeof parsed === 'object' && typeof parsed.sourceProjectId === 'string') {
      return parsed.sourceProjectId;
    }
  } catch {
    // Malformed metadata — treat as "no project" and skip.
  }
  return undefined;
}

/**
 * Activates every fabricated agent belonging to a project in one operation.
 *
 * Fabricated agents carry their originating `sourceProjectId` inside the
 * Registry record's customDescriptorContent JSON. We list all agent records,
 * select those matching `projectId`, and submit each non-active one for
 * approval (APPROVED == active via toInternalState). Already-active agents
 * (status APPROVED) are reported separately and skipped.
 *
 * Per-agent failures are swallowed and collected so one bad agent never
 * aborts activation of the rest; the whole operation never throws on a
 * single-agent error. Logs are kept free of record metadata (which can
 * carry org-scoped fields) — only the agent name and error message are
 * logged.
 */
export async function activateProjectAgents(projectId: string): Promise<ActivateAgentsResult> {
  const registryService = getRegistryService();
  const result: ActivateAgentsResult = { activated: [], failed: [], alreadyActive: [] };

  const records = await registryService.listResources('agent');
  for (const record of records) {
    if (extractSourceProjectId(record.customDescriptorContent) !== projectId) {
      continue;
    }

    const name = record.name || record.recordId;

    if (record.status === RegistryRecordStatusValues.APPROVED) {
      result.alreadyActive.push(name);
      continue;
    }

    try {
      // Governance activation gate (US-IMP): strict-blocks imported, unattested
      // agents BEFORE the APPROVED write. The throw is caught below so a blocked
      // agent lands in `failed` without aborting activation of the rest of the
      // batch; shadow/permissive emits telemetry and proceeds as before.
      await enforceImportActivationGate(
        registryService,
        record.recordId,
        record.customDescriptorContent ?? undefined,
      );
      await registryService.updateResourceStatus('agent', record.recordId, RegistryRecordStatusValues.APPROVED);
      result.activated.push(name);
    } catch (err) {
      console.error(
        `Failed to activate agent "${name}": ${err instanceof Error ? err.message : String(err)}`,
      );
      result.failed.push(name);
    }
  }

  return result;
}

async function listAgentConfigs(): Promise<AgentConfig[]> {
  const result = await docClient.send(
    new ScanCommand({
      TableName: AGENT_CONFIG_TABLE,
    })
  );

  return (result.Items || []).map(item => ({
    agentId: item.agentId,
    orgId: item.orgId || '',
    // AWSJSON type expects a JSON string, so ensure it's stringified
    config: typeof item.config === 'string' ? item.config : JSON.stringify(item.config),
    state: item.state || 'active',
    categories: item.categories || [],
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));
}

async function getAgentConfig(agentId: string): Promise<AgentConfig | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: AGENT_CONFIG_TABLE,
      Key: { agentId },
    })
  );

  if (!result.Item) {
    return null;
  }

  return {
    agentId: result.Item.agentId,
    orgId: result.Item.orgId || '',
    // AWSJSON type expects a JSON string, so ensure it's stringified
    config: typeof result.Item.config === 'string' ? result.Item.config : JSON.stringify(result.Item.config),
    state: result.Item.state || 'active',
    categories: result.Item.categories || [],
    createdAt: result.Item.createdAt,
    updatedAt: result.Item.updatedAt,
  };
}

async function createAgentConfig(input: AgentConfigMutationInput): Promise<AgentConfig> {
  const now = new Date().toISOString();
  const config = typeof input.config === 'string' ? JSON.parse(input.config) : input.config;

  const agentConfig: AgentConfig = {
    agentId: input.agentId,
    orgId: '',
    config,
    state: input.state || 'active',
    categories: input.categories || [],
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: AGENT_CONFIG_TABLE,
      Item: agentConfig,
    })
  );

  return {
    ...agentConfig,
    config: JSON.stringify(config),
  };
}

async function updateAgentConfig(input: AgentConfigMutationInput): Promise<AgentConfig> {
  const existing = await getAgentConfig(input.agentId);
  if (!existing) {
    throw new Error(`Agent config not found: ${input.agentId}`);
  }

  const now = new Date().toISOString();
  // Defensive: legacy DynamoDB rows may have non-JSON `config` strings.
  const existingConfig = (() => {
    if (typeof existing.config !== 'string') return existing.config ?? {};
    try { return JSON.parse(existing.config); } catch { return {}; }
  })();
  const newConfig = input.config 
    ? (typeof input.config === 'string' ? (() => { try { return JSON.parse(input.config); } catch { return {}; } })() : input.config)
    : existingConfig;

  // D-02: Optimistic locking — increment version and use conditional write
  const currentVersion = (existing as AgentConfig & { version?: number }).version || 0;
  const nextVersion = currentVersion + 1;

  const updatedConfig: AgentConfig = {
    agentId: input.agentId,
    orgId: existing.orgId || '',
    config: newConfig,
    state: input.state || existing.state,
    categories: input.categories !== undefined ? input.categories : existing.categories,
    createdAt: existing.createdAt,
    updatedAt: now,
  };

  try {
    await docClient.send(
      new PutCommand({
        TableName: AGENT_CONFIG_TABLE,
        Item: { ...updatedConfig, version: nextVersion },
        ConditionExpression: currentVersion === 0
          ? 'attribute_not_exists(version) OR version = :currentVersion'
          : 'version = :currentVersion',
        ExpressionAttributeValues: {
          ':currentVersion': currentVersion,
        },
      })
    );
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      throw new Error(`Conflict: agent config ${input.agentId} was modified concurrently. Please retry.`);
    }
    throw error;
  }

  return {
    ...updatedConfig,
    config: JSON.stringify(newConfig),
  };
}

async function deleteAgentConfig(agentId: string): Promise<{ success: boolean; message?: string }> {
  try {
    await docClient.send(
      new DeleteCommand({
        TableName: AGENT_CONFIG_TABLE,
        Key: { agentId },
      })
    );

    return {
      success: true,
      message: `Agent config ${agentId} deleted successfully`,
    };
  } catch (error) {
    console.error('Error deleting agent config:', error);
    return {
      success: false,
      message: `Failed to delete agent config: ${error}`,
    };
  }
}


// ─── Manifest Validation ─────────────────────────────────────

export function validateManifest(manifest: RawAgentManifest): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof manifest.name !== 'string' || manifest.name.trim() === '') {
    errors.push('name is required and must be a non-empty string');
  }
  if (typeof manifest.description !== 'string' || manifest.description.trim() === '') {
    errors.push('description is required and must be a non-empty string');
  }
  if (typeof manifest.version !== 'string' || manifest.version.trim() === '') {
    errors.push('version is required and must be a non-empty string');
  }

  return { valid: errors.length === 0, errors };
}

// ─── Import Descriptor Validation (US-IMP-001) ───────────────

/**
 * The nine invocation protocols recognised by the import pipeline. Typed as
 * AgentInvocationProtocol[] so every entry must be a valid protocol and the
 * list stays in lock-step with the union in registry-service.ts.
 */
const IMPORT_INVOCATION_PROTOCOLS: readonly AgentInvocationProtocol[] = [
  'AGENTCORE_RUNTIME',
  'BEDROCK_AGENT',
  'LAMBDA_INVOKE',
  'HTTP_ENDPOINT',
  'MCP',
  'A2A',
  'STEP_FUNCTIONS',
  'SAGEMAKER_ENDPOINT',
  'SQS_ASYNC',
];

/** Narrowing helper: true when `value` is a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates the invocation + origin blocks of an agent import descriptor
 * (US-IMP-001). Sits beside validateManifest and follows the same
 * `{ valid, errors }` contract.
 *
 * Requires:
 *   - `invocation.protocol` is one of the nine AgentInvocationProtocol values
 *   - `invocation.target` is a non-empty string
 *   - `origin.ownership === 'external'`
 *
 * Each missing/invalid field contributes a specific, field-naming error so
 * callers (and the UI) can pinpoint exactly what is wrong. Accepts `unknown`
 * and narrows internally — never throws on malformed input.
 */
export function validateImportDescriptor(
  descriptor: unknown,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  const root = isPlainObject(descriptor) ? descriptor : {};
  const invocation = isPlainObject(root.invocation) ? root.invocation : undefined;
  const origin = isPlainObject(root.origin) ? root.origin : undefined;

  const protocol = invocation?.protocol;
  if (
    typeof protocol !== 'string' ||
    !IMPORT_INVOCATION_PROTOCOLS.includes(protocol as AgentInvocationProtocol)
  ) {
    errors.push(
      `invocation.protocol is required and must be one of: ${IMPORT_INVOCATION_PROTOCOLS.join(', ')}`,
    );
  }

  const target = invocation?.target;
  if (typeof target !== 'string' || target.trim() === '') {
    errors.push('invocation.target is required and must be a non-empty string');
  }

  if (origin?.ownership !== 'external') {
    errors.push("origin.ownership is required and must be 'external'");
  }

  return { valid: errors.length === 0, errors };
}

// ─── Publish Agent Manifest ──────────────────────────────────

async function publishAgentManifest(agentId: string, manifestStr: string): Promise<unknown> {
  // Parse the AWSJSON manifest string
  let manifest: RawAgentManifest;
  try {
    manifest = JSON.parse(manifestStr);
  } catch {
    throw new Error('Invalid manifest JSON: unable to parse');
  }

  // Validate required fields
  const validation = validateManifest(manifest);
  if (!validation.valid) {
    throw new Error(`Manifest validation failed: ${validation.errors.join('; ')}`);
  }

  // Verify agent exists
  const existing = await docClient.send(
    new GetCommand({
      TableName: AGENT_CONFIG_TABLE,
      Key: { agentId },
    })
  );

  if (!existing.Item) {
    throw new Error(`Agent config not found: ${agentId}`);
  }

  // Store manifest in agent config item
  const now = new Date().toISOString();
  const result = await docClient.send(
    new UpdateCommand({
      TableName: AGENT_CONFIG_TABLE,
      Key: { agentId },
      UpdateExpression: 'SET #manifest = :manifest, #updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#manifest': 'manifest',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':manifest': manifest,
        ':updatedAt': now,
      },
      ReturnValues: 'ALL_NEW',
    })
  );

  const item = result.Attributes!;
  return {
    agentId: item.agentId,
    orgId: item.orgId || '',
    config: typeof item.config === 'string' ? item.config : JSON.stringify(item.config),
    state: item.state || 'active',
    categories: item.categories || [],
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    manifest: item.manifest,
  };
}
