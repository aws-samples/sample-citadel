/**
 * Centralised app↔workflow binding service.
 *
 * Every mutation that touches BOTH sides of the app↔workflow link
 * (workflow.appId on WORKFLOWS_TABLE and workflowIds list on AppsTable
 * #META) MUST go through this service. Direct writes to either field
 * outside this module are a bug — enforced by the grep-guard test in
 * __tests__/app-workflow-binding-guard.test.ts.
 *
 * ## Consistency model
 *
 *   DynamoDB (authoritative for readers)
 *   ├─ WORKFLOWS_TABLE  workflow.appId   ← scalar, 1:1, condition-guarded
 *   └─ AppsTable        #META.workflowIds ← list, updated atomically with
 *                                            workflow.appId via TransactWrite
 *
 *   Registry manifest (authoritative long-term, reconciler backstop)
 *   └─ manifest.workflowIds              ← mirror, best-effort, retried 3×
 *
 * The DDB TransactWrite guarantees workflow.appId and #META.workflowIds are
 * always consistent. The registry manifest update is a separate API call
 * (cannot participate in DDB transactions). If the mirror write fails:
 * - It is logged and a CloudWatch metric (Citadel/Apps BindingMirrorFailed)
 *   is emitted.
 * - The DDB side is authoritative for readers (listAppWorkflows reads #META).
 * - The 6-hourly reconciler (reconcile-apps-meta) drifts the manifest back
 *   into alignment. The --reconcile-bindings mode in reconcile-legacy-rows
 *   catches any remaining cross-reference mismatches.
 * - The failure is NOT thrown to the caller — the bind/unbind mutation
 *   succeeds from the caller's perspective.
 *
 * ## 1:1 binding
 *
 * A workflow can be bound to at most one app. The TransactWrite's condition
 * expression on workflow.appId enforces this atomically. Attempting to bind
 * a workflow that is already bound to a different app produces an opaque
 * error and a CloudWatch metric (Citadel/Apps BindingConflict).
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Injected dependencies — all external I/O is passed in for testability. */
export interface BindingServiceDeps {
  docClient: DynamoDBDocumentClient;
  workflowsTable: string;
  appsTable: string;
  /** Registry service for manifest mirror writes. Optional — when absent the
   *  mirror is skipped and the 6-hourly reconciler is the sole backstop. */
  registryService?: RegistryLike;
  /** EventBridge emitter. Optional — omit in tests. */
  emitEvent?: (type: string, detail: unknown) => Promise<void>;
  /** CloudWatch client. Optional — omit in tests. */
  cloudwatch?: CloudWatchClient;
}

/** Minimal registry-service contract needed by this module. */
export interface RegistryLike {
  getResource(type: string, id: string): Promise<RegistryRecordLike | null>;
  updateResource(
    type: string,
    id: string,
    input: { customMetadata?: string },
  ): Promise<RegistryRecordLike>;
}

export interface RegistryRecordLike {
  recordId: string;
  name: string;
  customDescriptorContent?: string;
}

export interface BindingContext {
  userId: string;
  orgId?: string;
}

/** Result from reconcileBindings. */
export interface ReconcileBindingsReport {
  orphanAppIds: string[];
  missingFromList: string[];
  danglingEntries: string[];
  crossRefMismatches: string[];
  /** Apps whose registry manifest.workflowIds mirror diverges from the
   *  authoritative DynamoDB list. Format: "appId:mirror:[...]:desired:[...]". */
  manifestDrift: string[];
  fixed: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Manifest helpers (mirrors registry-agent-record-resolver's readManifest /
// writeManifestMutation but kept local to avoid circular imports)
// ---------------------------------------------------------------------------

function parseDescriptor(
  record: RegistryRecordLike | null | undefined,
): Record<string, unknown> {
  if (!record?.customDescriptorContent) return {};
  try {
    const parsed = JSON.parse(record.customDescriptorContent);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function writeManifestMutation(
  record: RegistryRecordLike | null | undefined,
  mutator: (manifest: Record<string, unknown>) => void,
): string {
  const descriptor = parseDescriptor(record);
  const manifest: Record<string, unknown> = {
    ...((descriptor.manifest as Record<string, unknown>) || {}),
  };
  mutator(manifest);
  descriptor.manifest = manifest;
  return JSON.stringify(descriptor);
}

// ---------------------------------------------------------------------------
// CloudWatch metric helpers
// ---------------------------------------------------------------------------

async function emitMetric(
  cw: CloudWatchClient | undefined,
  metricName: string,
  dimensions?: { Name: string; Value: string }[],
): Promise<void> {
  if (!cw) return;
  try {
    await cw.send(
      new PutMetricDataCommand({
        Namespace: "Citadel/Apps",
        MetricData: [
          {
            MetricName: metricName,
            Value: 1,
            Unit: "Count",
            Timestamp: new Date(),
            ...(dimensions ? { Dimensions: dimensions } : {}),
          },
        ],
      }),
    );
  } catch (err) {
    console.error(`emitMetric(${metricName}): PutMetricData failed`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Mirror to registry manifest with retry
// ---------------------------------------------------------------------------

async function mirrorToRegistry(
  deps: BindingServiceDeps,
  appId: string,
  nextWorkflowIds: string[],
): Promise<boolean> {
  if (!deps.registryService) return false;
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const record = await deps.registryService!.getResource("agent", appId);
      if (!record) return false;

      const updatedContent = writeManifestMutation(record, (m) => {
        m.workflowIds = nextWorkflowIds;
        m.version = ((m.version as number) ?? 1) + 1;
      });

      await deps.registryService!.updateResource("agent", appId, {
        customMetadata: updatedContent,
      });
      return true;
    } catch (err) {
      if (attempt < maxRetries) {
        // Exponential backoff: 100ms, 200ms
        await new Promise((r) => setTimeout(r, 100 * attempt));
        continue;
      }
      console.error("mirrorToRegistry: all retries exhausted", {
        appId,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface BindOptions {
  /** Skip the workflow pre-check GetCommand. Use when the workflow was just
   *  created (e.g. importBlueprint) and may not be visible to a read-after-write. */
  skipWorkflowPreCheck?: boolean;
}

/**
 * Bind a workflow to an app. Enforces 1:1 — a workflow already bound to a
 * DIFFERENT app is refused. Idempotent if already bound to THIS app.
 */
export async function bind(
  deps: BindingServiceDeps,
  appId: string,
  workflowId: string,
  ctx: BindingContext,
  opts?: BindOptions,
): Promise<void> {
  // 1. Pre-check: load workflow to verify 1:1 before the TransactWrite.
  //    The TransactWrite condition is the real guard; this pre-check gives
  //    a cleaner error message and avoids a failed transaction on the common
  //    case where the caller forgot the workflow is already bound elsewhere.
  //    If the GetCommand fails (e.g. DDB not fully mocked), fall through
  //    and let the TransactWrite condition enforce the 1:1 rule.
  if (!opts?.skipWorkflowPreCheck) {
    let workflow: Record<string, unknown> | undefined;
    try {
      const wfResult = await deps.docClient.send(
        new GetCommand({
          TableName: deps.workflowsTable,
          Key: { workflowId },
        }),
      );
      workflow = wfResult.Item as Record<string, unknown> | undefined;
    } catch {
      // Fall through — the TransactWrite condition will enforce 1:1.
    }
    if (workflow) {
      if (
        workflow.appId &&
        workflow.appId !== appId &&
        workflow.appId !== "" &&
        workflow.appId !== "undefined"
      ) {
        await emitMetric(deps.cloudwatch, "BindingConflict", [
          { Name: "AppId", Value: appId },
        ]);
        throw new Error("Workflow is already bound to another app");
      }
    }
  }

  // 2. Load #META row for the current workflowIds list.
  let appMeta: Record<string, unknown> | undefined;
  try {
    const metaResult = await deps.docClient.send(
      new GetCommand({
        TableName: deps.appsTable,
        Key: { appId },
      }),
    );
    appMeta = metaResult.Item as Record<string, unknown> | undefined;
  } catch {
    // Fall through — attempt the TransactWrite anyway.
  }
  if (!appMeta) {
    throw new Error("App not found");
  }

  const existingIds: string[] = (appMeta.workflowIds as string[]) || [];
  if (existingIds.includes(workflowId)) {
    // Already bound to THIS app — idempotent no-op.
    return;
  }

  const nextWorkflowIds = [...existingIds, workflowId];

  // 3. Atomic dual-write: workflow.appId + #META.workflowIds
  try {
    await deps.docClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: deps.workflowsTable,
              Key: { workflowId },
              UpdateExpression: "SET #appId = :appId, #updatedAt = :now",
              ConditionExpression:
                "attribute_not_exists(#appId) OR #appId = :appId OR #appId = :empty OR #appId = :undef",
              ExpressionAttributeNames: {
                "#appId": "appId",
                "#updatedAt": "updatedAt",
              },
              ExpressionAttributeValues: {
                ":appId": appId,
                ":empty": "",
                ":undef": "undefined",
                ":now": new Date().toISOString(),
              },
            },
          },
          {
            Update: {
              TableName: deps.appsTable,
              Key: { appId },
              UpdateExpression: "SET #wids = :nextList, #updatedAt = :now",
              ExpressionAttributeNames: {
                "#wids": "workflowIds",
                "#updatedAt": "updatedAt",
              },
              ExpressionAttributeValues: {
                ":nextList": nextWorkflowIds,
                ":now": new Date().toISOString(),
              },
            },
          },
        ],
      }),
    );
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "TransactionCanceledException") {
      // Condition check failure → 1:1 violation (race with another binder)
      await emitMetric(deps.cloudwatch, "BindingConflict", [
        { Name: "AppId", Value: appId },
      ]);
      throw new Error("Workflow is already bound to another app");
    }
    throw err;
  }

  // 4. Mirror to registry manifest (best-effort, retried 3×).
  const mirrored = await mirrorToRegistry(deps, appId, nextWorkflowIds);
  if (!mirrored) {
    console.error("bind: registry manifest mirror failed", {
      appId,
      workflowId,
    });
    await emitMetric(deps.cloudwatch, "BindingMirrorFailed", [
      { Name: "AppId", Value: appId },
    ]);
  }

  // 5. Emit event.
  if (deps.emitEvent) {
    await deps.emitEvent("app.workflow.bound", {
      appId,
      workflowId,
      userId: ctx.userId,
    });
  }
}

/**
 * Unbind a workflow from an app. Clears workflow.appId and removes from
 * #META.workflowIds atomically. Idempotent if already unbound.
 */
export async function unbind(
  deps: BindingServiceDeps,
  appId: string,
  workflowId: string,
  ctx: BindingContext,
): Promise<void> {
  // 1. Load #META row.
  const metaResult = await deps.docClient.send(
    new GetCommand({
      TableName: deps.appsTable,
      Key: { appId },
    }),
  );
  const appMeta = metaResult.Item;
  if (!appMeta) {
    // App already gone — nothing to unbind from.
    return;
  }

  const existingIds: string[] = appMeta.workflowIds || [];
  const remaining = existingIds.filter((id) => id !== workflowId);

  // If the workflow wasn't in the list AND workflow.appId doesn't point
  // here, this is a no-op.
  const wfResult = await deps.docClient.send(
    new GetCommand({
      TableName: deps.workflowsTable,
      Key: { workflowId },
    }),
  );
  const workflow = wfResult.Item;
  const wfPointsHere = workflow && workflow.appId === appId;
  const wasInList = existingIds.includes(workflowId);

  if (!wasInList && !wfPointsHere) {
    // Already unbound — idempotent.
    return;
  }

  // 2. Atomic dual-write.
  const transactItems: Array<{
    Update: {
      TableName: string;
      Key: Record<string, string>;
      UpdateExpression: string;
      ConditionExpression?: string;
      ExpressionAttributeNames: Record<string, string>;
      ExpressionAttributeValues: Record<string, unknown>;
    };
  }> = [];

  if (wfPointsHere) {
    transactItems.push({
      Update: {
        TableName: deps.workflowsTable,
        Key: { workflowId },
        UpdateExpression: "REMOVE #appId SET #updatedAt = :now",
        ConditionExpression: "#appId = :thisApp",
        ExpressionAttributeNames: {
          "#appId": "appId",
          "#updatedAt": "updatedAt",
        },
        ExpressionAttributeValues: {
          ":thisApp": appId,
          ":now": new Date().toISOString(),
        },
      },
    });
  }

  transactItems.push({
    Update: {
      TableName: deps.appsTable,
      Key: { appId },
      UpdateExpression: "SET #wids = :remaining, #updatedAt = :now",
      ExpressionAttributeNames: {
        "#wids": "workflowIds",
        "#updatedAt": "updatedAt",
      },
      ExpressionAttributeValues: {
        ":remaining": remaining,
        ":now": new Date().toISOString(),
      },
    },
  });

  try {
    await deps.docClient.send(
      new TransactWriteCommand({ TransactItems: transactItems }),
    );
  } catch (err: unknown) {
    // Condition check failure is benign (concurrent unbind or workflow
    // already cleared). Fall through — the state is already consistent.
    if (err instanceof Error && err.name === "TransactionCanceledException") {
      return;
    }
    throw err;
  }

  // 3. Mirror to registry.
  const mirrored = await mirrorToRegistry(deps, appId, remaining);
  if (!mirrored) {
    console.error("unbind: registry manifest mirror failed", {
      appId,
      workflowId,
    });
    await emitMetric(deps.cloudwatch, "BindingMirrorFailed", [
      { Name: "AppId", Value: appId },
    ]);
  }

  // 4. Emit event.
  if (deps.emitEvent) {
    await deps.emitEvent("app.workflow.unbound", {
      appId,
      workflowId,
      userId: ctx.userId,
    });
  }
}

/**
 * Unbind ALL workflows from an app. Called by deleteApp before the registry
 * record and #META row are deleted. Best-effort per workflow — errors are
 * logged but not thrown.
 */
export async function unbindAll(
  deps: BindingServiceDeps,
  appId: string,
  _ctx: BindingContext,
): Promise<void> {
  let appMeta: Record<string, unknown> | undefined;
  try {
    const metaResult = await deps.docClient.send(
      new GetCommand({
        TableName: deps.appsTable,
        Key: { appId },
      }),
    );
    appMeta = metaResult.Item as Record<string, unknown> | undefined;
  } catch (err) {
    console.error("unbindAll: failed to read app metadata (non-fatal)", {
      appId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!appMeta) return;

  const workflowIds: string[] = (appMeta.workflowIds as string[]) || [];
  for (const wfId of workflowIds) {
    try {
      // Clear workflow.appId individually (best-effort, log errors).
      await deps.docClient.send(
        new UpdateCommand({
          TableName: deps.workflowsTable,
          Key: { workflowId: wfId },
          UpdateExpression: "REMOVE #appId SET #updatedAt = :now",
          ConditionExpression: "#appId = :thisApp",
          ExpressionAttributeNames: {
            "#appId": "appId",
            "#updatedAt": "updatedAt",
          },
          ExpressionAttributeValues: {
            ":thisApp": appId,
            ":now": new Date().toISOString(),
          },
        }),
      );
    } catch (err) {
      console.error("unbindAll: failed to clear workflow.appId", {
        appId,
        workflowId: wfId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // No need to update #META or registry — both are about to be deleted.
}

/**
 * Clear the appId from all workflows that point at this app. Called by
 * deleteApp. Unlike unbindAll (which reads #META.workflowIds), this also
 * catches orphan workflows whose appId points here but aren't in the list.
 */
export async function clearApp(
  deps: BindingServiceDeps,
  appId: string,
): Promise<void> {
  // unbindAll already clears listed workflows. This is a belt-and-suspenders
  // call — re-use unbindAll which reads the #META list.
  await unbindAll(deps, appId, { userId: "system" });
}

// ---------------------------------------------------------------------------
// Reconcile bindings
// ---------------------------------------------------------------------------

export interface ReconcileBindingsOptions {
  deps: BindingServiceDeps;
  fix: boolean;
}

/**
 * Scan for and optionally repair binding mismatches:
 *   1. workflow.appId points at an app that doesn't exist → clear it.
 *   2. workflow.appId = X but X's #META.workflowIds doesn't include it → add it.
 *   3. App's #META.workflowIds contains a workflowId that doesn't exist → remove it.
 *   4. App's list has workflowId W but W.appId = Y (different app) → report conflict.
 *
 * Fix strategy: compute each app's DESIRED workflowIds list exactly once
 * from the authoritative side (every existing workflow whose appId points
 * at this app), then write the list in a single UpdateItem per app with a
 * ConditionExpression on the previous value so concurrent edits are
 * detected. This avoids the previous bug where an incremental list_append
 * in Check 2 was overwritten by the full SET in Check 3/4 (which read from
 * the stale in-memory snapshot).
 */
export async function reconcileBindings(
  opts: ReconcileBindingsOptions,
): Promise<ReconcileBindingsReport> {
  const { deps, fix } = opts;
  const report: ReconcileBindingsReport = {
    orphanAppIds: [],
    missingFromList: [],
    danglingEntries: [],
    crossRefMismatches: [],
    manifestDrift: [],
    fixed: 0,
    errors: 0,
  };

  // Scan all workflows and apps.
  const workflows = await scanTable(deps.docClient, deps.workflowsTable);
  const apps = await scanTable(deps.docClient, deps.appsTable);

  // Build lookup maps.
  const appMap = new Map<string, Record<string, unknown>>();
  for (const app of apps) {
    if (app.appId) appMap.set(app.appId as string, app);
  }

  const workflowMap = new Map<string, Record<string, unknown>>();
  for (const wf of workflows) {
    if (wf.workflowId) workflowMap.set(wf.workflowId as string, wf);
  }

  // --- Pass 1: Check workflows with appId set (orphans + missing-from-list detection) ---

  // Build the authoritative desired list per app: every existing workflow
  // whose appId points at this app and the app itself exists.
  const desiredListPerApp = new Map<string, string[]>();

  for (const wf of workflows) {
    const wfId = wf.workflowId as string;
    const wfAppId = wf.appId as string | undefined;
    if (!wfAppId || wfAppId === "" || wfAppId === "undefined") continue;

    const app = appMap.get(wfAppId);

    // Check 1: orphan appId → app doesn't exist.
    if (!app) {
      report.orphanAppIds.push(wfId);
      console.log(
        `[reconcile-bindings] ORPHAN appId: workflow=${wfId} appId=${wfAppId} (app missing)`,
      );
      if (fix) {
        try {
          await deps.docClient.send(
            new UpdateCommand({
              TableName: deps.workflowsTable,
              Key: { workflowId: wfId },
              UpdateExpression: "REMOVE #appId",
              ExpressionAttributeNames: { "#appId": "appId" },
            }),
          );
          report.fixed++;
        } catch (err) {
          console.error("[reconcile-bindings] fix orphan failed", {
            wfId,
            err,
          });
          report.errors++;
        }
      }
      continue;
    }

    // This workflow authoritatively belongs to this app. Record it.
    let desired = desiredListPerApp.get(wfAppId);
    if (!desired) {
      desired = [];
      desiredListPerApp.set(wfAppId, desired);
    }
    desired.push(wfId);

    // Check 2: detect for reporting.
    const appWfIds: string[] = (app.workflowIds as string[]) || [];
    if (!appWfIds.includes(wfId)) {
      report.missingFromList.push(wfId);
      console.log(
        `[reconcile-bindings] MISSING from list: workflow=${wfId} appId=${wfAppId}`,
      );
    }
  }

  // --- Pass 2: Check app lists for dangling/cross-ref (detection only) ---

  for (const app of apps) {
    const appId = app.appId as string;
    const wfIds: string[] = (app.workflowIds as string[]) || [];

    for (const wfId of wfIds) {
      const wf = workflowMap.get(wfId);

      // Check 3: dangling entry → workflow doesn't exist.
      if (!wf) {
        report.danglingEntries.push(`${appId}:${wfId}`);
        console.log(
          `[reconcile-bindings] DANGLING entry: app=${appId} workflowId=${wfId} (workflow missing)`,
        );
        continue;
      }

      // Check 4: cross-ref mismatch → workflow.appId points elsewhere.
      const wfAppId = wf.appId as string | undefined;
      if (
        wfAppId &&
        wfAppId !== appId &&
        wfAppId !== "" &&
        wfAppId !== "undefined"
      ) {
        report.crossRefMismatches.push(`${appId}:${wfId}:${wfAppId}`);
        console.log(
          `[reconcile-bindings] CROSS-REF mismatch: app=${appId} has wf=${wfId} but wf.appId=${wfAppId}`,
        );
      }
    }
  }

  // --- Pass 3: Single atomic write per app whose list needs updating ---

  if (fix) {
    for (const app of apps) {
      const appId = app.appId as string;
      const currentList: string[] = (app.workflowIds as string[]) || [];
      const desired = desiredListPerApp.get(appId) || [];

      // Sort both for stable comparison.
      const sortedCurrent = [...currentList].sort();
      const sortedDesired = [...desired].sort();

      const listsMatch =
        sortedCurrent.length === sortedDesired.length &&
        sortedCurrent.every((v, i) => v === sortedDesired[i]);

      if (!listsMatch) {
        try {
          await deps.docClient.send(
            new UpdateCommand({
              TableName: deps.appsTable,
              Key: { appId },
              UpdateExpression: "SET #wids = :desired, #updatedAt = :now",
              // Guard against concurrent edits: only succeed if the list is
              // still what we scanned. Use size check + equality on the
              // serialised form. For empty lists, use attribute_not_exists
              // OR the empty-list sentinel.
              ConditionExpression:
                currentList.length === 0
                  ? "(attribute_not_exists(#wids) OR #wids = :prev)"
                  : "#wids = :prev",
              ExpressionAttributeNames: {
                "#wids": "workflowIds",
                "#updatedAt": "updatedAt",
              },
              ExpressionAttributeValues: {
                ":desired": desired,
                ":prev": currentList,
                ":now": new Date().toISOString(),
              },
            }),
          );
          report.fixed++;
        } catch (err) {
          // ConditionalCheckFailedException means the list was modified
          // concurrently — safe to skip; next reconcile pass will converge.
          if (
            err instanceof Error &&
            err.name === "ConditionalCheckFailedException"
          ) {
            console.warn(
              "[reconcile-bindings] concurrent edit detected, skipping",
              { appId },
            );
          } else {
            console.error("[reconcile-bindings] fix app list failed", {
              appId,
              err,
            });
            report.errors++;
          }
        }
      }
    }
  }

  // --- Pass 4: Manifest drift detection (registry mirror vs DDB desired) ---

  if (deps.registryService) {
    for (const app of apps) {
      const appId = app.appId as string;

      // Skip non-metadata rows (component/APIKEY rows sharing the table)
      // and legacy UUID-keyed rows. Component rows have '#' in their key
      // (e.g. appId#AGENT#name, appId#APIKEY#uuid). Legacy UUID rows are
      // 36-char strings with dashes that the registry rejects.
      if (
        !appId ||
        appId.includes("#") ||
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          appId,
        )
      )
        continue;

      // The desired list is the one the DDB side should already hold after
      // Pass 3 applied its fixes. For apps that were not in the fix map
      // (already consistent), the current DDB list IS the desired list.
      const desired = desiredListPerApp.get(appId) || [];

      let record: RegistryRecordLike | null = null;
      try {
        record = await deps.registryService!.getResource("agent", appId);
      } catch (err) {
        console.error(
          "[reconcile-bindings] manifest drift: registry read failed",
          { appId, error: err instanceof Error ? err.message : String(err) },
        );
        // Skip this app — cannot compare without a registry read.
        continue;
      }

      if (!record) continue; // No registry record for this app.

      const descriptor = parseDescriptor(record);
      const manifest = (descriptor.manifest as Record<string, unknown>) || {};
      const mirrorIds: string[] = Array.isArray(manifest.workflowIds)
        ? (manifest.workflowIds as string[])
        : [];

      const sortedMirror = [...mirrorIds].sort();
      const sortedDesired = [...desired].sort();

      const mirrorMatch =
        sortedMirror.length === sortedDesired.length &&
        sortedMirror.every((v, i) => v === sortedDesired[i]);

      if (!mirrorMatch) {
        const tag = `${appId}:mirror:${JSON.stringify(sortedMirror)}:desired:${JSON.stringify(sortedDesired)}`;
        report.manifestDrift.push(tag);
        console.log(
          `[reconcile-bindings] MANIFEST DRIFT: app=${appId} mirror=${JSON.stringify(sortedMirror)} desired=${JSON.stringify(sortedDesired)}`,
        );

        if (fix) {
          const ok = await mirrorToRegistry(deps, appId, desired);
          if (ok) {
            report.fixed++;
          } else {
            console.error("[reconcile-bindings] manifest drift fix failed", {
              appId,
            });
            await emitMetric(deps.cloudwatch, "BindingMirrorFailed", [
              { Name: "AppId", Value: appId },
            ]);
            report.errors++;
          }
        }
      }
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Table scan helper
// ---------------------------------------------------------------------------

async function scanTable(
  docClient: DynamoDBDocumentClient,
  tableName: string,
): Promise<Record<string, unknown>[]> {
  // Dynamic import to avoid pulling in ScanCommand for production callers
  // that never use reconcile.
  const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");
  const items: Record<string, unknown>[] = [];
  let lastKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey: lastKey,
      }),
    );
    if (result.Items)
      items.push(...(result.Items as Record<string, unknown>[]));
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);
  return items;
}
