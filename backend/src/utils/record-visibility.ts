/**
 * Record-visibility policy for catalog registry records.
 *
 * Pure, dependency-free module that encodes the visibility matrix defined in
 * decision fa3f8363, as updated by PR-3 (Continuum CRITICAL: blank orgId
 * was being treated as a cross-tenant wildcard).
 *
 * Statuses governed by the registry lifecycle:
 *   DRAFT, PENDING_APPROVAL, APPROVED, REJECTED, DEPRECATED
 *
 * Records with NO status (legacy DynamoDB items not yet migrated to the
 * registry) are always visible — they predate the governance model and are
 * surfaced unchanged until migration adds a status.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

import { ALL_ORGS } from "./org-constants";

export interface Viewer {
  isAdmin: boolean;
  roles: string[];
  orgId: string | null;
  userId: string | null;
}

export interface VisibleRecord {
  status?: string;
  orgId?: string;
  createdBy?: string;
  /**
   * Explicit "this record's org could not be resolved" flag, carried by
   * mappers/projections when the underlying metadata never stamped an
   * orgId. When set, the record is NEVER shared and NEVER org-matched,
   * regardless of what (if anything) `orgId` happens to hold.
   */
  orgUnknown?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** All statuses that the registry lifecycle governs. */
const GOVERNED_STATUSES = new Set([
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "REJECTED",
  "DEPRECATED",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isArchitect(viewer: Viewer): boolean {
  return viewer.roles.includes("architect");
}

/**
 * Whether the record is the explicit system-shared marker. Only the
 * `ALL_ORGS` sentinel qualifies — there is no empty-string alias. A record
 * flagged `orgUnknown` is never shared even if its `orgId` happens to equal
 * `ALL_ORGS` (defensive: a contradictory/corrupt record fails closed).
 */
function isSystemShared(record: VisibleRecord): boolean {
  if (record.orgUnknown === true) return false;
  return record.orgId === ALL_ORGS;
}

/**
 * Whether the record's org matches the viewer's org. Fail-closed: a blank,
 * absent, or `orgUnknown` orgId on the record NEVER matches any viewer —
 * it is not treated as a wildcard. The only wildcard is the explicit
 * `ALL_ORGS` marker (see {@link isSystemShared}).
 */
function orgMatch(viewer: Viewer, record: VisibleRecord): boolean {
  if (record.orgUnknown === true) return false;
  if (isSystemShared(record)) return true;
  if (record.orgId === undefined || record.orgId === "") return false;
  if (viewer.orgId === null || viewer.orgId === "") return false;
  return record.orgId === viewer.orgId;
}

/**
 * Whether the viewer owns the record.
 * Fallback: when `createdBy` is undefined (agent records that don't yet carry
 * the field), org-match is used as a proxy until the backfill lands. This
 * fallback is fail-closed exactly like `orgMatch` — it never treats a
 * blank/absent/orgUnknown org as a match.
 */
function ownerMatch(viewer: Viewer, record: VisibleRecord): boolean {
  if (record.createdBy === undefined) {
    return orgMatch(viewer, record);
  }
  return record.createdBy === viewer.userId;
}

// ---------------------------------------------------------------------------
// Core policy
// ---------------------------------------------------------------------------

/**
 * Returns `true` when `viewer` is allowed to see `record`.
 *
 * Matrix (decision fa3f8363, PR-3 update):
 *
 * | Status            | admin | architect (same-org / owner / ALL_ORGS) | everyone else |
 * |-------------------|-------|-------------------------------------------|---------------|
 * | (none / legacy)   | ✓     | ✓                                         | ✓             |
 * | APPROVED          | ✓     | ✓                                         | ✓             |
 * | PENDING_APPROVAL  | ✓     | same-org or ALL_ORGS                      | ✗             |
 * | DRAFT             | ✓     | owner (or org fallback)                   | ✗             |
 * | REJECTED          | ✓     | ✗                                         | ✗             |
 * | DEPRECATED        | ✓     | ✗                                         | ✗             |
 *
 * A record with a blank, absent, or `orgUnknown` orgId is NEVER treated as
 * shared or org-matching — it fails closed immediately, for every status
 * and every non-admin persona.
 */
export function isRecordVisible(
  viewer: Viewer,
  record: VisibleRecord,
): boolean {
  // Admin bypass — sees everything.
  if (viewer.isAdmin) return true;

  const status = record.status;

  // Legacy records (no status) are always visible.
  if (status === undefined) return true;

  // Non-governed status (defensive) — treat as invisible to non-admins.
  if (!GOVERNED_STATUSES.has(status)) return false;

  // APPROVED is universally visible.
  if (status === "APPROVED") return true;

  // Everything below is admin-only for non-architects.
  if (!isArchitect(viewer)) return false;

  // Architect-specific visibility.
  switch (status) {
    case "PENDING_APPROVAL":
      return orgMatch(viewer, record);
    case "DRAFT":
      return ownerMatch(viewer, record);
    case "REJECTED":
    case "DEPRECATED":
      return false;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Derived helper — useful for documentation & test oracles
// ---------------------------------------------------------------------------

/**
 * Returns the set of governed statuses a viewer can potentially see,
 * assuming the most favourable org/owner match.  Useful for generating
 * query filters and for test oracles.
 */
export function visibleStatusesFor(viewer: Viewer): string[] {
  if (viewer.isAdmin) {
    return Array.from(GOVERNED_STATUSES);
  }

  const result: string[] = ["APPROVED"];

  if (isArchitect(viewer)) {
    result.push("PENDING_APPROVAL", "DRAFT");
  }

  return result;
}

// ---------------------------------------------------------------------------
// Event → Viewer factory — bridges the AppSync identity to the Viewer type
// ---------------------------------------------------------------------------

// Import lazily to keep the core policy functions above dependency-free.
// These imports are used ONLY by viewerFromEvent, which is the single call
// site that bridges an AppSync event into the pure Viewer value.
import {
  extractOrgFromEvent,
  isAdminFromEvent,
  deriveRoles,
} from "./auth-event";
import { extractUserIdFromEvent } from "./auth";

/**
 * Constructs a {@link Viewer} from an AppSync resolver event.
 *
 * Combines the auth helpers scattered across auth-event.ts and auth.ts into
 * a single factory so every list/search call site can build a Viewer in one
 * call instead of four.
 */
export async function viewerFromEvent(event: unknown): Promise<Viewer> {
  const [orgId] = await Promise.all([extractOrgFromEvent(event)]);
  return {
    isAdmin: isAdminFromEvent(event),
    roles: deriveRoles(event),
    orgId,
    userId: extractUserIdFromEvent(event),
  };
}
