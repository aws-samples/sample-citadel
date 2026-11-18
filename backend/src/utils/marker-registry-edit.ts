/**
 * Shared marker-only registry edit helper.
 *
 * Edits ONLY allowlisted descriptor marker fields (orgId, orgUnknown,
 * requiredPermissions, credentialMode) on existing registry records, with
 * automatic approval restoration for records that were APPROVED before the
 * edit and governance ledger integration.
 *
 * Approval restoration uses `updateResourceStatus` directly (not
 * `submitForApproval`) — AgentCore auto-approves on submit, which bypasses
 * the human gate; the direct status-update path records the system
 * principal and reason explicitly.
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

    try {
      await registryService.updateResource(type, recordId, {
        customMetadata: JSON.stringify(newMeta),
      });
    } catch (err) {
      return {
        recordId,
        priorStatus,
        postStatus: priorStatus,
        fieldsChanged: changedFields,
        reapproved: false,
        error: `updateResource failed: ${String(err)}`,
      };
    }

    // 7. Restore approval if record was APPROVED before the edit
    let postStatus = "DRAFT"; // updateResource demotes to DRAFT
    let reapproved = false;

    if (priorStatus === "APPROVED") {
      try {
        // Direct status-update (not submitForApproval) — records the
        // system principal and reason explicitly, does not auto-approve
        // via AgentCore's implicit approval pathway.
        const restored = await registryService.updateResourceStatus(
          type,
          recordId,
          RegistryRecordStatusValues.APPROVED,
          `${operationLabel}: marker-only edit of [${changedFields.join(", ")}]; restoring prior APPROVED status`,
        );
        postStatus = restored.status ?? "APPROVED";
        reapproved = postStatus === "APPROVED";
      } catch (err) {
        console.warn(
          `Marker edit: failed to restore APPROVED status for ${recordId}: ${String(err)}`,
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
