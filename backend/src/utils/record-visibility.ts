/**
 * Record-visibility policy for catalog registry records.
 *
 * Pure, dependency-free module that encodes the visibility matrix defined in
 * decision fa3f8363.  Every list/search call site filters its result set
 * through `isRecordVisible` before returning to the caller.
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
 * Whether the record's org matches the viewer's org.
 * An empty-string orgId on the record means "system-shared" — visible to all orgs.
 */
function orgMatch(viewer: Viewer, record: VisibleRecord): boolean {
  return record.orgId === "" || record.orgId === viewer.orgId;
}

/**
 * Whether the viewer owns the record.
 * Fallback: when `createdBy` is undefined (agent records that don't yet carry
 * the field), org-match is used as a proxy until the backfill lands.
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
 * Matrix (decision fa3f8363):
 *
 * | Status            | admin | architect (same-org / owner) | everyone else |
 * |-------------------|-------|------------------------------|---------------|
 * | (none / legacy)   | ✓     | ✓                            | ✓             |
 * | APPROVED          | ✓     | ✓                            | ✓             |
 * | PENDING_APPROVAL  | ✓     | same-org or system-shared    | ✗             |
 * | DRAFT             | ✓     | owner (or org fallback)      | ✗             |
 * | REJECTED          | ✓     | ✗                            | ✗             |
 * | DEPRECATED        | ✓     | ✗                            | ✗             |
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
