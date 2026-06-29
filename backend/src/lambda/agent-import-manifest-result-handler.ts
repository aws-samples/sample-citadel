/**
 * Agent Import — Manifest RESULT handler (Tier-3 agent import, B1).
 *
 * EventBridge consumer on the shared agent bus (citadel-agents-${env}) that
 * ingests an ASYNC, LLM-proposed agent manifest from the Fabricator and parks
 * it on the DRAFT import record for HUMAN REVIEW. It mirrors the
 * EventBridge-triggered handler convention in this codebase (idempotency guard,
 * RegistryService read-modify-write of customMetadata, structured logging).
 *
 * CONTRACT (B2 / arbiter-A producers MUST conform):
 *   detail-type `agent.import.manifest.proposed`
 *     detail = { requestId, correlationId, importId,
 *                proposedManifest: <AgentCapabilityDescriptor-shaped JSON>,
 *                status: 'proposed' }
 *   detail-type `agent.import.manifest.failed`
 *     detail = { requestId, correlationId, importId, error, status: 'failed' }
 *
 * SECURITY INVARIANTS (non-negotiable):
 *   1. The proposed manifest is UNTRUSTED LLM output: it is recursively
 *      sanitized (sanitizeUntrustedJson) BEFORE it is stored.
 *   2. The handler writes ONLY customMetadata.proposedManifest. It NEVER
 *      promotes/mutates manifest, invocation, state, or governanceAttestation,
 *      and never changes the record's status/name (no activation).
 *   3. The proposal is stored confidence='low', reviewState='pending_review',
 *      source='llm_tier3' (all fieldConfidence 'low').
 *   4. Idempotent on correlationId||requestId (duplicate emits collapse).
 *   5. No raw proposed payload (and no secret/credential) is ever logged — only
 *      sizes, the truncation flag, and stable injection-pattern IDs.
 */
import { EventBridgeEvent } from 'aws-lambda';
import { IdempotencyGuard } from '../utils/idempotency';
import {
  sanitizeUntrustedJson,
  JsonValue,
} from '../utils/sanitize-untrusted-json';
import { RegistryService } from '../services/registry-service';
import type {
  AgentCustomMetadata,
  ProposedManifestMetadata,
  ProposedManifestConfidence,
} from '../services/registry-service';

/** Detail-types this handler consumes on the agent bus. */
export const PROPOSED_DETAIL_TYPE = 'agent.import.manifest.proposed';
export const FAILED_DETAIL_TYPE = 'agent.import.manifest.failed';

/** Length cap for a stored failure detail (sanitized + truncated). */
const MAX_ERROR_LENGTH = 2000;

const idempotencyGuard = new IdempotencyGuard(process.env.IDEMPOTENCY_TABLE!);

/**
 * Safe metadata defaults for deserializing the DRAFT import record. A record
 * with no prior proposal simply carries no proposedManifest; everything else
 * is preserved on the read-modify-write.
 */
const META_DEFAULTS: AgentCustomMetadata = {
  categories: [],
  icon: '',
  state: 'active',
};

interface ProposedDetail {
  requestId?: string;
  correlationId?: string;
  importId?: string;
  proposedManifest?: unknown;
  status?: string;
}

interface FailedDetail {
  requestId?: string;
  correlationId?: string;
  importId?: string;
  error?: unknown;
  status?: string;
}

type ResultDetail = ProposedDetail & FailedDetail;

/** Constructs the RegistryService from env. Lazily, so tests can mock it. */
function getRegistryService(): RegistryService {
  const registryId = process.env.REGISTRY_ID;
  if (!registryId) {
    throw new Error('REGISTRY_ID is not configured');
  }
  const region = process.env.AWS_REGION || 'us-east-1';
  return new RegistryService({ registryId, region });
}

/**
 * Builds an all-'low' fieldConfidence map from the top-level keys of the
 * sanitized proposed manifest. LLM-inferred fields are always low-confidence.
 */
function buildAllLowFieldConfidence(
  manifest: JsonValue,
): Record<string, ProposedManifestConfidence> {
  const out: Record<string, ProposedManifestConfidence> = {};
  if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
    for (const key of Object.keys(manifest)) {
      out[key] = 'low';
    }
  }
  return out;
}

/** Coerces an untrusted error value to a sanitized, length-capped string. */
function sanitizeError(error: unknown): string {
  const raw = typeof error === 'string' ? error : JSON.stringify(error ?? 'unknown error');
  const res = sanitizeUntrustedJson(raw, { maxStringLength: MAX_ERROR_LENGTH });
  return typeof res.value === 'string' ? res.value : '[sanitized]';
}

export const handler = async (
  event: EventBridgeEvent<string, ResultDetail>,
): Promise<void> => {
  const detailType = event['detail-type'];
  const detail = event.detail ?? {};
  const correlationId = detail.correlationId || detail.requestId || event.id;
  const importId = detail.importId;

  // Structured log — metadata only, NEVER the raw payload.
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'agent-import-manifest-result: received',
      detailType,
      importId: importId ?? null,
      correlationId,
    }),
  );

  if (detailType !== PROPOSED_DETAIL_TYPE && detailType !== FAILED_DETAIL_TYPE) {
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'agent-import-manifest-result: ignoring unrelated detail-type',
        detailType,
      }),
    );
    return;
  }

  if (!importId) {
    // Cannot target a record without an importId. Do not throw: the idempotency
    // guard consumes the key before fn runs, so a throw would not enable a
    // meaningful retry — log (no payload) and drop the malformed event.
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'agent-import-manifest-result: missing importId; dropping event',
        detailType,
        correlationId,
      }),
    );
    return;
  }

  const { executed } = await idempotencyGuard.withIdempotency(
    correlationId,
    async () => {
      const registryService = getRegistryService();

      // Load the DRAFT import record so the write preserves every existing
      // field (manifest/invocation/state/governanceAttestation/...).
      const record = await registryService.getResource('agent', importId);
      if (!record) {
        console.error(
          JSON.stringify({
            level: 'error',
            msg: 'agent-import-manifest-result: import record not found; nothing to write',
            importId,
            correlationId,
          }),
        );
        return;
      }

      const meta = registryService.deserializeCustomMetadata<AgentCustomMetadata>(
        record.customDescriptorContent ?? null,
        META_DEFAULTS,
      );

      const proposedAt = new Date().toISOString();
      let proposedManifest: ProposedManifestMetadata;

      if (detailType === PROPOSED_DETAIL_TYPE) {
        // (1) Recursively sanitize the UNTRUSTED proposed manifest.
        const sanitized = sanitizeUntrustedJson(detail.proposedManifest);
        proposedManifest = {
          manifest: sanitized.value as Record<string, unknown>,
          confidence: 'low',
          reviewState: 'pending_review',
          source: 'llm_tier3',
          fieldConfidence: buildAllLowFieldConfidence(sanitized.value),
          proposedAt,
          correlationId,
          sanitized: true,
          ...(sanitized.truncated ? { truncated: true } : {}),
        };
        console.log(
          JSON.stringify({
            level: 'info',
            msg: 'agent-import-manifest-result: storing proposed manifest (pending review)',
            importId,
            correlationId,
            truncated: sanitized.truncated,
            nodeCount: sanitized.nodeCount,
            // Stable injection-pattern IDs only — never raw matched text.
            sanitizedMatches: sanitized.matches,
          }),
        );
      } else {
        // Minimal failure marker — no manifest body.
        proposedManifest = {
          reviewState: 'failed',
          source: 'llm_tier3',
          error: sanitizeError(detail.error),
          correlationId,
          proposedAt,
          sanitized: true,
        };
        console.log(
          JSON.stringify({
            level: 'info',
            msg: 'agent-import-manifest-result: recording failure marker',
            importId,
            correlationId,
          }),
        );
      }

      // (2) Write ONLY proposedManifest. Spreading `meta` preserves every other
      // field byte-for-byte (manifest/invocation/state/governanceAttestation);
      // the update sends customMetadata only — no name/status change.
      const mergedMeta: AgentCustomMetadata = {
        ...meta,
        proposedManifest,
      };
      await registryService.updateResource('agent', importId, {
        customMetadata: registryService.serializeCustomMetadata(mergedMeta),
      });
    },
  );

  if (!executed) {
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'agent-import-manifest-result: duplicate event skipped',
        correlationId,
      }),
    );
  }
};
