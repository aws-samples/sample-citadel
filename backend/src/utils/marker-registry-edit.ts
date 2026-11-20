/**
 * Shared marker-only registry edit helper.
 *
 * Edits ONLY allowlisted descriptor marker fields (orgId, orgUnknown,
 * requiredPermissions, credentialMode) on existing registry records, with
 * automatic approval restoration for records that were APPROVED before the
 * edit and governance ledger integration.
 *
 * Approval restoration follows the full AgentCore registry lifecycle:
 *   1. updateResource demotes APPROVED → DRAFT
 *   2. submitForApproval advances DRAFT → PENDING_APPROVAL
 *      (or auto-approves straight to APPROVED when the registry has
 *       auto-approval configured)
 *   3. If PENDING_APPROVAL after submit, decideRecord
 *      (updateResourceStatus APPROVED) completes the restoration
 *
 * This respects REGISTRY_TRANSITIONS which forbids DRAFT → APPROVED
 * directly — only PENDING_APPROVAL → APPROVED is valid.
 */
import {
  RegistryService,
  ResourceType,
  RegistryRecord,
  RegistryRecordStatusValues,
} from "../services/registry-service";

// ---- Types ----

export type AllowedMarkerField =
  "orgId" | "orgUnknown" | "requiredPermissions" | "credentialMode";

const ALLOWED_FIELDS = new Set<AllowedMarkerField>([
  "orgId",
  "orgUnknown",
  "requiredPermissions",
  "credentialMode",
]);

export interface MarkerEditSpec {
  recordId: string;
  type: ResourceType;
  fieldsToSet: Partial<Record<AllowedMarkerField, unknown>>;
  fieldsToRemove?: AllowedMarkerField[];
}

export interface MarkerEditResult {
  recordId: string;
  priorStatus: string;
  postStatus: string;
  fieldsChanged: AllowedMarkerField[];
  reapproved: boolean;
  ledgerDecisionId?: string;
  error?: string;
}

export interface GovernanceDecision {
  type: string;
  operation: string;
  recordId: string;
  fieldsChanged: AllowedMarkerField[];
  priorStatus: string;
  postStatus: string;
  reapproved: boolean;
  decidedBy: string;
  reason: string;
  timestamp: string;
}

export interface MarkerEditOptions {
  registryService: RegistryService;
  dryRun: boolean;
  ledgerWriter?: (decision: GovernanceDecision) => Promise<string | undefined>;
  operationLabel: string;
}

// ---- Helpers ----

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validateFieldsAllowed(
  fieldsToSet: Record<string, unknown>,
  fieldsToRemove: string[],
): void {
  for (const key of Object.keys(fieldsToSet)) {
    if (!ALLOWED_FIELDS.has(key as AllowedMarkerField)) {
      throw new Error(`Field "${key}" is not in the marker-edit allowlist`);
    }
  }
  for (const key of fieldsToRemove) {
    if (!ALLOWED_FIELDS.has(key as AllowedMarkerField)) {
      throw new Error(`Field "${key}" is not in the marker-edit allowlist`);
    }
  }
}

// ---- Main ----

export async function applyMarkerEdit(
  spec: MarkerEditSpec,
  options: MarkerEditOptions,
): Promise<MarkerEditResult> {
  const { registryService, dryRun, ledgerWriter, operationLabel } = options;
  const { recordId, type, fieldsToSet, fieldsToRemove = [] } = spec;

  try {
    // 1. Validate allowlist
    validateFieldsAllowed(fieldsToSet, fieldsToRemove);

    // 2. Read current record
    let record: RegistryRecord | null;
    try {
      record = await registryService.getResource(type, recordId);
    } catch (err) {
      return {
        recordId,
        priorStatus: "UNKNOWN",
        postStatus: "UNKNOWN",
        fieldsChanged: [],
        reapproved: false,
        error: `Record not found: ${String(err)}`,
      };
    }

    if (!record) {
      return {
        recordId,
        priorStatus: "UNKNOWN",
        postStatus: "UNKNOWN",
        fieldsChanged: [],
        reapproved: false,
        error: "Record not found (null)",
      };
    }

    // 3. Parse customDescriptorContent
    let meta: Record<string, unknown>;
    try {
      meta = record.customDescriptorContent
        ? JSON.parse(record.customDescriptorContent)
        : {};
    } catch {
      return {
        recordId,
        priorStatus: record.status ?? "UNKNOWN",
        postStatus: record.status ?? "UNKNOWN",
        fieldsChanged: [],
        reapproved: false,
        error: "Malformed customDescriptorContent",
      };
    }

    // 4. Compute diff
    const changedFields: AllowedMarkerField[] = [];
    const newMeta = { ...meta };

    for (const [key, value] of Object.entries(fieldsToSet)) {
      if (!deepEqual(meta[key], value)) {
        changedFields.push(key as AllowedMarkerField);
        newMeta[key] = value;
      }
    }
    for (const key of fieldsToRemove) {
      if (key in meta) {
        changedFields.push(key as AllowedMarkerField);
        delete newMeta[key];
      }
    }

    // Idempotent: no-op when nothing changed
    if (changedFields.length === 0) {
      return {
        recordId,
        priorStatus: record.status ?? "UNKNOWN",
        postStatus: record.status ?? "UNKNOWN",
        fieldsChanged: [],
        reapproved: false,
      };
    }

    const priorStatus = record.status ?? "UNKNOWN";

    // 5. Dry-run: return diff without writing
    if (dryRun) {
      return {
        recordId,
        priorStatus,
        postStatus: priorStatus === "APPROVED" ? "APPROVED" : priorStatus,
        fieldsChanged: changedFields,
        reapproved: priorStatus === "APPROVED",
      };
    }

    // 6. Write via updateResource
    // Also propagate changed fields into nested config if present
    if (
      newMeta.config &&
      typeof newMeta.config === "object" &&
      !Array.isArray(newMeta.config)
    ) {
      const config = newMeta.config as Record<string, unknown>;
      for (const [key, value] of Object.entries(fieldsToSet)) {
        if (changedFields.includes(key as AllowedMarkerField)) {
          config[key] = value;
        }
      }
      for (const key of fieldsToRemove) {
        if (changedFields.includes(key as AllowedMarkerField)) {
          delete config[key];
        }
      }
    }

    let settleFailed = false;
    try {
      const updated = await registryService.updateResource(type, recordId, {
        customMetadata: JSON.stringify(newMeta),
      });
      settleFailed = updated.settleFailed === true;
    } catch (err) {
      // A thrown error here means the write itself (UpdateRegistryRecord)
      // never landed — genuinely abandon the record, nothing to restore.
      // Contrast with `settleFailed` above: that signals the write landed
      // but the post-write settle poll was throttled, which must NOT take
      // this early-return path (see LIVE INCIDENT 2026-11-20).
      return {
        recordId,
        priorStatus,
        postStatus: priorStatus,
        fieldsChanged: changedFields,
        reapproved: false,
        error: `updateResource failed: ${String(err)}`,
      };
    }

    // 7. Restore approval if record was APPROVED before the edit.
    //
    // The full lifecycle is:
    //   updateResource demoted → DRAFT
    //   submitForApproval      → PENDING_APPROVAL (or APPROVED if auto-approval)
    //   decideRecord (APPROVED)→ APPROVED          (only when still PENDING_APPROVAL)
    //
    // DRAFT → APPROVED directly is forbidden by REGISTRY_TRANSITIONS.
    let postStatus = "DRAFT"; // updateResource demotes to DRAFT
    let reapproved = false;

    if (priorStatus === "APPROVED") {
      try {
        // Step 1: Submit for approval (DRAFT → PENDING_APPROVAL, or
        // auto-approve to APPROVED when the registry is configured for it)
        const submitted = await registryService.submitForApproval(recordId);
        const submittedStatus = submitted.status ?? "PENDING_APPROVAL";

        if (submittedStatus === "APPROVED") {
          // Registry auto-approved — we're done
          postStatus = "APPROVED";
          reapproved = true;
        } else if (submittedStatus === "PENDING_APPROVAL") {
          // Step 2: Decide the record (PENDING_APPROVAL → APPROVED)
          const reason =
            `${operationLabel}: marker-only edit of [${changedFields.join(", ")}]; ` +
            `restoring prior APPROVED status`;
          const decided = await registryService.updateResourceStatus(
            type,
            recordId,
            RegistryRecordStatusValues.APPROVED,
            reason,
          );
          postStatus = decided.status ?? "APPROVED";
          reapproved = postStatus === "APPROVED";
        } else {
          // Unexpected post-submit status — log and leave as-is
          console.warn(
            `Marker edit: unexpected status after submitForApproval for ${recordId}: ${submittedStatus}`,
          );
          postStatus = submittedStatus;
        }
      } catch (err) {
        console.warn(
          `Marker edit: failed to restore APPROVED status for ${recordId}${settleFailed ? " (write settle step was also throttled)" : ""}: ${String(err)}`,
        );
        // postStatus stays DRAFT — manual approval needed
      }
    }

    // 8. Governance ledger
    let ledgerDecisionId: string | undefined;
    if (ledgerWriter && reapproved) {
      try {
        ledgerDecisionId = await ledgerWriter({
          type: "marker_only_registry_edit",
          operation: operationLabel,
          recordId,
          fieldsChanged: changedFields,
          priorStatus,
          postStatus,
          reapproved,
          decidedBy: `system:${operationLabel}`,
          reason: `Marker-only edit of [${changedFields.join(", ")}]; approval restored by system principal`,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        console.warn(
          `Marker edit: governance ledger write failed for ${recordId}: ${String(err)}`,
        );
      }
    }

    return {
      recordId,
      priorStatus,
      postStatus,
      fieldsChanged: changedFields,
      reapproved,
      ledgerDecisionId,
    };
  } catch (err) {
    return {
      recordId,
      priorStatus: "UNKNOWN",
      postStatus: "UNKNOWN",
      fieldsChanged: [],
      reapproved: false,
      error: String(err),
    };
  }
}
