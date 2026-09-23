/**
 * Maps the raw Registry record status (finding 414f8013's `registryStatus`
 * discriminator) to the human-readable label shown in the registry status
 * badge (finding c5df5322) on AgentCard/ToolCard. This badge is distinct
 * from the legacy `state` toggle badge ('active'/'inactive'/'maintenance')
 * — it surfaces the underlying Registry approval-lifecycle status
 * (Draft / Pending approval / Approved / Rejected / Deprecated) so a
 * registry-backed record's real lifecycle position is visible even though
 * the legacy state field only distinguishes active/inactive/maintenance.
 *
 * Returns null for legacy (non-registry-backed) records — i.e. when
 * registryStatus is null/undefined — so callers can conditionally omit the
 * badge entirely rather than render a misleading label.
 */
const REGISTRY_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  DEPRECATED: 'Deprecated',
};

export function registryStatusLabel(registryStatus: string | null | undefined): string | null {
  if (!registryStatus) return null;
  return REGISTRY_STATUS_LABELS[registryStatus] ?? registryStatus;
}
