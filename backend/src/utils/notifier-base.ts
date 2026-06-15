/**
 * Governance event emitter (QB-005-1 resolution Option iii).
 *
 * Standalone helper for emitting governance.* EventBridge events with:
 * - A discriminated-union payload map across 11 detail-types (compile-time type safety per type).
 * - Fail-closed sanitisation: <script>, <iframe>, <object> tags are stripped from
 * string-valued payload fields before JSON-serialisation. Callers cannot bypass this.
 * - ISO-8601 timestamp + optional correlationId stamped into every Detail.
 *
 * Per QB-005-1 this module does NOT import from backend/src/utils/events.ts; the existing
 * publishEvent helper remains untouched (dead-code retirement is a future cleanup story).
 *
 * Per NOTIFIER_USE_SHARED=false (AC #3), other existing notifier Lambdas
 * (design-progress-notifier, assessment-completion-notifier) do NOT delegate to this
 * helper in Phase 1. Those files remain unchanged.
 */

import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';

// Keep this list in lock-step with the docs/EVENTBRIDGE_CATALOG.md #Governance Events
// section (added by commit 12844ba) and with the discriminated union below.
export const GOVERNANCE_DETAIL_TYPES = [
  'governance.adr.locked',
  'governance.adr.reopen.attempted',
  'governance.specification.created',
  'governance.specification.approved',
  'governance.specification.rejected',
  'governance.round.started',
  'governance.round.completed',
  'governance.round.transcript.overflow',
  'governance.archetype.classified',
  'governance.offfrontier.escalated',
  'governance.grandfathered.bypass',
  // Wave 2.E: emitted by setGovernanceMode resolver on a successful mode flip.
  'governance.mode.transition',
  // Wave 4.C.2: emitted by addConstitutionalRule / updateConstitutionalRule
  // / deleteConstitutionalRule on a successful rules write. Best-effort —
  // failure does not roll back the rule write.
  'governance.constitutional.rule.changed',
  // Wave 4.D.2: emitted by revokeCaseLaw / unrevokeCaseLaw /
  // updateCaseLawPrecedence on a successful case-law row write.
  // Best-effort — failure does not roll back the primary write.
  'governance.caselaw.changed',
] as const;

export type GovernanceDetailType = typeof GOVERNANCE_DETAIL_TYPES[number];

// Per-detail-type typed payload map.
export interface GovernancePayloadMap {
  'governance.adr.locked': { projectId: string; adrId: string; title: string; sourceRoundIds: string[] };
  'governance.adr.reopen.attempted': {
    projectId: string;
    adrId: string;
    revisitConditionMatched: boolean;
    attemptedBy: string;
    authResult: 'ALLOWED' | 'DENIED';
  };
  'governance.specification.created': { projectId: string; specId: string; version: number };
  'governance.specification.approved': { projectId: string; specId: string; approvedBy: string; version: number };
  'governance.specification.rejected': { projectId: string; specId: string; reason: string; rejectedBy: string };
  'governance.round.started': { projectId: string; roundN: number };
  'governance.round.completed': { projectId: string; roundN: number };
  'governance.round.transcript.overflow': { projectId: string; roundN: number; sizeBytes: number };
  'governance.archetype.classified': { projectId: string; archetype: string; confidence: number };
  'governance.offfrontier.escalated': { projectId: string; agentId: string; reason: string };
  'governance.grandfathered.bypass': {
    projectId: string;
    bypassedGate: string;
    projectCreatedAt: string;
    effectiveAt: string;
  };
  // Wave 2.E: payload for governance.mode.transition. Emitted by the
  // setGovernanceMode resolver after a successful SSM write. previousMode
  // is the value read before the flip; newMode is the targetMode just
  // written. effectiveAtUpdated is true when the resolver also wrote the
  // companion effective_at parameter (first permissive→shadow/strict flip).
  'governance.mode.transition': {
    previousMode: string;
    newMode: string;
    env: string;
    reason: string | null;
    actorSub: string;
    timestamp: string;
    effectiveAtUpdated: boolean;
  };
  // Wave 4.C.2: payload for governance.constitutional.rule.changed.
  // Emitted by the rule-editor mutation handlers after a successful
  // rules write. `oldRule` is null for `add`; `newRule` is null for
  // `delete`. `ruleIndex` is the post-insert index for `add`, or the
  // affected index for `update` / `delete`. `oldRule` and `newRule`
  // surface the projected wire shape (JSON-encoded value, or null for
  // exists/not_exists) so downstream consumers see the same shape the
  // frontend renders.
  'governance.constitutional.rule.changed': {
    layerId: string;
    action: 'add' | 'update' | 'delete';
    ruleIndex: number;
    oldRule: { field: string; operator: string; value: string | null } | null;
    newRule: { field: string; operator: string; value: string | null } | null;
    actorSub: string;
    timestamp: string;
  };
  // Wave 4.D.2: payload for governance.caselaw.changed. Emitted by the
  // case-law admin mutations (revoke / unrevoke / update-precedence).
  // `previousValue` and `newValue` capture the field-level delta so
  // downstream consumers can reconstruct the change without an extra
  // DDB read. For revoke / unrevoke, both are {revoked: boolean}; for
  // update-precedence, both are {precedence: number}.
  'governance.caselaw.changed': {
    caseId: string;
    action: 'revoke' | 'unrevoke' | 'update-precedence';
    previousValue: Record<string, unknown>;
    newValue: Record<string, unknown>;
    reason: string | null;
    actorSub: string;
    timestamp: string;
  };
}

export type DetailPayloadOf<D extends GovernanceDetailType> = GovernancePayloadMap[D];

// Fail-closed sanitiser — strips tags (and their content) for the three most
// dangerous HTML embed vectors. Applied recursively across string fields only.
const SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const IFRAME_RE = /<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi;
const OBJECT_RE = /<object\b[^>]*>[\s\S]*?<\/object\s*>/gi;
// Also strip self-closing / un-closed opening tags so `<script src=x>` on its
// own cannot survive.
const SCRIPT_OPEN_RE = /<script\b[^>]*>/gi;
const IFRAME_OPEN_RE = /<iframe\b[^>]*>/gi;
const OBJECT_OPEN_RE = /<object\b[^>]*>/gi;
const SCRIPT_CLOSE_RE = /<\/script\s*>/gi;
const IFRAME_CLOSE_RE = /<\/iframe\s*>/gi;
const OBJECT_CLOSE_RE = /<\/object\s*>/gi;

function sanitizeString(s: string): string {
  let out = s;
  out = out.replace(SCRIPT_RE, '');
  out = out.replace(IFRAME_RE, '');
  out = out.replace(OBJECT_RE, '');
  out = out.replace(SCRIPT_OPEN_RE, '');
  out = out.replace(IFRAME_OPEN_RE, '');
  out = out.replace(OBJECT_OPEN_RE, '');
  out = out.replace(SCRIPT_CLOSE_RE, '');
  out = out.replace(IFRAME_CLOSE_RE, '');
  out = out.replace(OBJECT_CLOSE_RE, '');
  return out;
}

function sanitizeDeep<T>(value: T): T {
  if (typeof value === 'string') return sanitizeString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

let _client: EventBridgeClient | null = null;
function ebClient(): EventBridgeClient {
  if (!_client) _client = new EventBridgeClient({});
  return _client;
}

export async function emitGovernanceEvent<D extends GovernanceDetailType>(
  detailType: D,
  detail: DetailPayloadOf<D>,
  correlationId?: string
): Promise<void> {
  const sanitisedDetail = sanitizeDeep(detail);
  const envelope: Record<string, unknown> = {
    ...(sanitisedDetail as Record<string, unknown>),
    timestamp: new Date().toISOString(),
  };
  if (correlationId !== undefined) envelope.correlationId = correlationId;

  const command = new PutEventsCommand({
    Entries: [
      {
        Source: 'citadel.backend',
        DetailType: detailType,
        Detail: JSON.stringify(envelope),
        EventBusName: process.env.EVENT_BUS_NAME || 'default',
      },
    ],
  });
  await ebClient().send(command);
}

/** Test-only: reset the cached EventBridge client. Do not call from production code. */
export function __resetGovernanceNotifierForTest(): void {
  _client = null;
}
