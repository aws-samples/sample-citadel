/**
 * Shared field-name constants for the denormalized registry-approval fields
 * written onto AGENT_CONFIG_TABLE rows by registry-sync.ts and
 * ensure-agent-config-rows.ts.
 *
 * These names are the cross-language parity contract with the Python
 * dispatch-time approval gate (arbiter/governance/record_approval.py),
 * which reads these same attribute names off the DynamoDB item. Any rename
 * here must be mirrored on the Python side's shared fixture/constant.
 */

/** Raw registry status string (e.g. "APPROVED", "DRAFT", "PENDING_APPROVAL",
 * "REJECTED", "DEPRECATED"). Deliberately the RAW value, never the lossy
 * internal `state` mapping — `state` alone cannot distinguish "approved" from
 * "activated with no approval precondition". Absent (UNSET) when the source
 * has no status signal; NEVER defaulted to "APPROVED". */
export const REGISTRY_STATUS_FIELD = "registryStatus";

/** The registry recordId this row's status was denormalized from. */
export const REGISTRY_RECORD_ID_FIELD = "registryRecordId";

/** ISO timestamp of the last time registryStatus was written/changed. */
export const STATUS_UPDATED_AT_FIELD = "statusUpdatedAt";
