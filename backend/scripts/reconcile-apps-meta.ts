/**
 * Phase 3 Step 4: AppsTable `#META` row reconciler.
 *
 * Detects and (optionally) repairs drift between the Registry (source of
 * truth) and the AppsTable `#META` mirror used by `listApps` via the
 * OrgIndex GSI. Steps 1–3 already write the mirror on create / update /
 * delete; this script catches drift caused by failed writes, partial
 * deploys, or out-of-band edits.
 *
 * Drift classification:
 *   - 'missing'  : Registry record exists but no matching `#META` row.
 *   - 'stale'    : `#META` row exists; one of (name, status, orgId,
 *                  version) differs from the Registry projection.
 *   - 'in-sync'  : Registry projection matches the `#META` row on the
 *                  comparison set. Other fields may differ silently.
 *   - 'orphan'   : `#META` row exists but no matching Registry record.
 *
 * Repair policy:
 *   - --dry-run (default) : log every drift line and a summary; no writes.
 *   - --apply             : write the `#META` row for every 'missing' case
 *                           via `upsertAppMeta` (safe, additive). 'stale'
 *                           and 'orphan' are LOGGED ONLY — admins decide
 *                           whether to fix or remove them.
 *
 * Usage:
 *   ts-node backend/scripts/reconcile-apps-meta.ts --dry-run   (default)
 *   ts-node backend/scripts/reconcile-apps-meta.ts --apply
 *
 * Required env (mirrors backfill-org-ids.ts ergonomics):
 *   REGISTRY_ID  – AgentCore Registry id (auto-loaded from cdk-outputs.json)
 *   APPS_TABLE   – AppsTable name (auto-derived as `citadel-apps-${ENVIRONMENT}`)
 *   AWS_REGION   – optional, defaults to us-west-2
 *
 * Constraints:
 *   - Idempotent — re-running --apply reports 0 missing on the second pass.
 *   - Eventually-consistent on writes: `upsertAppMeta` returns boolean;
 *     failures are logged and counted, never thrown.
 *   - Rate-limit friendly: small sleep between Registry GetItem calls so
 *     large registries do not burst the DDB GetItem capacity.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';

import { bootstrapEnv } from './backfill-org-ids';
import {
  RegistryService,
  RegistryRecord,
} from '../src/services/registry-service';
import {
  AppMetaRow,
  upsertAppMeta,
  APP_META_SORT_VALUE,
} from '../src/utils/apps-table-meta';

// ---------------------------------------------------------------------------
// Pure logic helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export type DriftKind = 'missing' | 'stale' | 'in-sync' | 'orphan';

/**
 * Comparison set: the only fields that drive 'stale' classification. Matches
 * the contract called out in the Step 4 task description. Differences in
 * other fields (description, workflowIds, routingConfig, …) are tolerated to
 * keep noise low.
 */
const DRIFT_FIELDS = ['name', 'status', 'orgId', 'version'] as const;
export type DriftField = (typeof DRIFT_FIELDS)[number];

/**
 * Returns true when two values are equivalent for drift purposes. Numbers
 * are coerced (DDB DocumentClient returns JS numbers; the projection is
 * always a JS number) and null/undefined are normalised to '' so a missing
 * field on either side compares equal to an empty string on the other.
 */
function fieldsEqual(_field: DriftField, a: unknown, b: unknown): boolean {
  if (typeof a === 'number' || typeof b === 'number') {
    return Number(a) === Number(b);
  }
  return (a ?? '') === (b ?? '');
}

/**
 * Classifies the drift state of an AppsTable `#META` row relative to the
 * projection derived from the matching Registry record.
 *
 *   - projection=null,  metaRow!=null → 'orphan'
 *   - projection!=null, metaRow=null  → 'missing'
 *   - both present, comparison field differs → 'stale'
 *   - both present, all comparison fields match → 'in-sync' (other fields
 *     may differ silently)
 */
export function classifyDrift(
  projection: AppMetaRow | null | undefined,
  metaRow: Partial<AppMetaRow> | null | undefined,
): DriftKind {
  const haveProjection = projection != null;
  const haveMeta = metaRow != null;

  if (haveProjection && !haveMeta) return 'missing';
  if (!haveProjection && haveMeta) return 'orphan';
  if (!haveProjection && !haveMeta) return 'in-sync'; // no-op pathological case

  const proj = projection as AppMetaRow;
  const row = metaRow as Partial<AppMetaRow>;

  for (const field of DRIFT_FIELDS) {
    const a = (proj as unknown as Record<string, unknown>)[field];
    const b = (row as unknown as Record<string, unknown>)[field];
    if (!fieldsEqual(field, a, b)) return 'stale';
  }
  return 'in-sync';
}

/**
 * Returns the first comparison field that differs between projection and
 * meta row, or null if every comparison field matches. Used to format the
 * `field=… registry=… meta=…` portion of the per-record stale log line.
 */
export function firstDifferingField(
  projection: AppMetaRow,
  metaRow: Partial<AppMetaRow>,
): DriftField | null {
  for (const field of DRIFT_FIELDS) {
    const a = (projection as unknown as Record<string, unknown>)[field];
    const b = (metaRow as unknown as Record<string, unknown>)[field];
    if (!fieldsEqual(field, a, b)) return field;
  }
  return null;
}

/**
 * Local, side-effect-free copy of the resolver's human-description
 * extractor. Inlined here rather than imported so the CLI does not pull in
 * the resolver module's Lambda-targeted dependencies (EventBridge, Ajv,
 * AppSync helpers). Behaviour is byte-identical: returns the embedded
 * `description` / `info.description` from a JSON-blob description, or the
 * raw value when not JSON / no nested description is present.
 */
function extractHumanDescription(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) return raw;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.description === 'string' && parsed.description.trim()) {
      return parsed.description;
    }
    if (
      typeof parsed?.info?.description === 'string' &&
      parsed.info.description.trim()
    ) {
      return parsed.info.description;
    }
  } catch {
    // not JSON — fall through and return raw
  }
  return raw;
}

/**
 * Projects a Registry record onto the AppMetaRow shape, mirroring the
 * fields the resolvers (registry-agent-record-resolver.ts and
 * app-publish-handler.ts) write on create / update. Defaults match the
 * resolver-side projection so a reconciler-written row is byte-identical
 * to a resolver-written one.
 *
 * Source of each field:
 *   - appId        : record.recordId
 *   - orgId        : manifest.orgId → descriptor.orgId → ''
 *   - name         : record.name
 *   - description  : extractHumanDescription(record.description)
 *   - status       : manifest.status → record.status → 'DRAFT'
 *                    (manifest mirrors the user-facing status incl. PUBLISHED;
 *                    record.status is the underlying Registry SDK enum)
 *   - workflowIds  : manifest.workflowIds → []
 *   - routingConfig: serialised JSON of manifest.routingConfig (or empty)
 *   - createdBy    : manifest.createdBy → descriptor.createdBy → ''
 *   - createdAt    : record.createdAt.toISOString() → ''
 *   - updatedAt    : record.updatedAt.toISOString() → ''
 *   - version      : manifest.version → descriptor.version → 1
 */
export function projectRegistryRecordToMeta(
  record: Pick<
    RegistryRecord,
    | 'recordId'
    | 'name'
    | 'description'
    | 'status'
    | 'customDescriptorContent'
    | 'createdAt'
    | 'updatedAt'
  >,
): AppMetaRow {
  let descriptor: Record<string, any> = {};
  if (record.customDescriptorContent) {
    try {
      const parsed = JSON.parse(record.customDescriptorContent);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        descriptor = parsed as Record<string, any>;
      }
    } catch {
      descriptor = {};
    }
  }

  const manifest =
    descriptor.manifest && typeof descriptor.manifest === 'object'
      ? (descriptor.manifest as Record<string, any>)
      : {};

  const orgId = String(manifest.orgId ?? descriptor.orgId ?? '');
  const status = String(manifest.status ?? record.status ?? 'DRAFT');
  const createdBy = String(manifest.createdBy ?? descriptor.createdBy ?? '');

  const version =
    typeof manifest.version === 'number'
      ? manifest.version
      : typeof descriptor.version === 'number'
        ? descriptor.version
        : 1;

  const workflowIds = Array.isArray(manifest.workflowIds)
    ? (manifest.workflowIds as string[])
    : [];

  // routingConfig is stored as a serialised JSON string in the META row.
  // The manifest may carry it as a structured object; normalise either form.
  const routingConfigRaw = manifest.routingConfig;
  let routingConfig = '';
  if (routingConfigRaw != null) {
    routingConfig =
      typeof routingConfigRaw === 'string'
        ? routingConfigRaw
        : JSON.stringify(routingConfigRaw);
  }

  const description = extractHumanDescription(record.description);

  const createdAt =
    record.createdAt instanceof Date
      ? record.createdAt.toISOString()
      : typeof record.createdAt === 'string'
        ? record.createdAt
        : '';
  const updatedAt =
    record.updatedAt instanceof Date
      ? record.updatedAt.toISOString()
      : typeof record.updatedAt === 'string'
        ? record.updatedAt
        : '';

  return {
    appId: record.recordId,
    orgId,
    name: record.name ?? '',
    description,
    status,
    workflowIds,
    routingConfig,
    createdBy,
    createdAt,
    updatedAt,
    version,
  };
}

// ---------------------------------------------------------------------------
// Env auto-load — APPS_TABLE
// ---------------------------------------------------------------------------

/**
 * Walks up at most `maxDepth` parents from `startDir` looking for
 * `filename`. Mirrors the helper used in backfill-org-ids.ts; duplicated
 * here because that one is private. Trivial enough that re-implementing
 * is cheaper than exporting a second copy from the other script.
 */
function findUpwards(
  startDir: string,
  filename: string,
  maxDepth = 5,
): string | null {
  let dir = startDir;
  for (let i = 0; i < maxDepth; i++) {
    const candidate = path.join(dir, filename);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Populates APPS_TABLE from the nearest `cdk-outputs.json` (under the
 * `citadel-backend-dev` stack key) when unset. Suffix-matches `AppsTable` so
 * the CDK-emitted `ExportsOutputRefAppsTable*` keys resolve correctly.
 * Falls back silently when the file is missing or malformed; the next
 * helper synthesises a deterministic name.
 */
export function loadAppsTableFromCdkOutputs(): void {
  if (process.env.APPS_TABLE) return;
  const outputsPath = findUpwards(process.cwd(), 'cdk-outputs.json');
  if (!outputsPath) return;
  let outputs: Record<string, Record<string, unknown>>;
  try {
    outputs = JSON.parse(fs.readFileSync(outputsPath, 'utf8'));
  } catch {
    return;
  }
  const backend = (outputs['citadel-backend-dev'] ?? {}) as Record<
    string,
    unknown
  >;
  for (const k of Object.keys(backend)) {
    if (k.includes('AppsTable')) {
      const v = backend[k];
      if (typeof v === 'string' && v) {
        process.env.APPS_TABLE = v;
        return;
      }
    }
  }
}

/**
 * Synthesises `APPS_TABLE` from `ENVIRONMENT` when unset, matching the
 * deterministic `citadel-apps-${ENVIRONMENT}` pattern from the CDK stack.
 * Defaults to `citadel-apps-dev` when ENVIRONMENT is unset.
 */
export function deriveAppsTable(): void {
  if (process.env.APPS_TABLE) return;
  const env = process.env.ENVIRONMENT || 'dev';
  process.env.APPS_TABLE = `citadel-apps-${env}`;
}

// ---------------------------------------------------------------------------
// Summary accumulation
// ---------------------------------------------------------------------------

interface Summary {
  scannedRegistry: number;
  scannedMeta: number;
  inSync: number;
  missing: number;
  stale: number;
  orphan: number;
  fixed: number; // only mutated under --apply for 'missing'
  errors: number;
}

function emptySummary(): Summary {
  return {
    scannedRegistry: 0,
    scannedMeta: 0,
    inSync: 0,
    missing: 0,
    stale: 0,
    orphan: 0,
    fixed: 0,
    errors: 0,
  };
}

// ---------------------------------------------------------------------------
// Infrastructure helpers
// ---------------------------------------------------------------------------

/** Min wait between Registry GetItem calls. Cheap insurance against bursts. */
const REGISTRY_SLEEP_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type LogLevel = 'info' | 'warn' | 'error';

function log(level: LogLevel, msg: string): void {
  const ts = new Date().toISOString();
  const prefix =
    level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN' : 'INFO';
  const line = `${ts} [${prefix}] ${msg}`;
  if (level === 'error') {
    // eslint-disable-next-line no-console
    console.error(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

/**
 * Single GetItem on the AppsTable for the `#META` row of the given appId.
 * Returns the raw item or null when absent. Errors are propagated so the
 * caller can count them and continue with the next record.
 */
async function getAppMetaRow(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  appId: string,
): Promise<Record<string, any> | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { appId },
    }),
  );
  return result.Item ?? null;
}

/**
 * Pages through every metadata row in the AppsTable using a Scan with a
 * server-side filter on the `sortId` data attribute. The scan is
 * intentionally tolerant of empty pages and large keyspaces — pagination
 * is via `LastEvaluatedKey` rather than a single shot.
 */
async function* scanMetaRows(
  docClient: DynamoDBDocumentClient,
  tableName: string,
): AsyncGenerator<Record<string, any>> {
  let exclusiveStartKey: Record<string, any> | undefined;
  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: 'sortId = :meta',
        ExpressionAttributeValues: { ':meta': APP_META_SORT_VALUE },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    if (result.Items) {
      for (const item of result.Items) {
        yield item;
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
}

// ---------------------------------------------------------------------------
// Pass 1: walk the Registry, classify each record against its #META row.
// ---------------------------------------------------------------------------

async function reconcileFromRegistry(
  registry: RegistryService,
  docClient: DynamoDBDocumentClient,
  tableName: string,
  apply: boolean,
  summary: Summary,
  seenAppIds: Set<string>,
): Promise<void> {
  log('info', '--- Pass 1: Registry → AppsTable #META ---');

  let records: RegistryRecord[];
  try {
    records = await registry.listResources('agent');
  } catch (err) {
    log('error', `Failed to list Registry agent records: ${String(err)}`);
    summary.errors++;
    return;
  }

  for (const record of records) {
    summary.scannedRegistry++;
    const appId = record.recordId;
    seenAppIds.add(appId);

    let projection: AppMetaRow;
    try {
      projection = projectRegistryRecordToMeta(record);
    } catch (err) {
      log(
        'error',
        `[agent] appId=${appId} projection failed: ${String(err)}`,
      );
      summary.errors++;
      continue;
    }

    let metaRow: Record<string, any> | null;
    try {
      metaRow = await getAppMetaRow(docClient, tableName, appId);
    } catch (err) {
      log(
        'error',
        `[agent] appId=${appId} GetItem failed: ${String(err)}`,
      );
      summary.errors++;
      await sleep(REGISTRY_SLEEP_MS);
      continue;
    }
    await sleep(REGISTRY_SLEEP_MS);

    const drift = classifyDrift(projection, metaRow);
    switch (drift) {
      case 'in-sync':
        summary.inSync++;
        // No log for in-sync rows; keep the output focused on drift.
        break;
      case 'missing':
        summary.missing++;
        log(
          'info',
          `[agent] appId=${appId} drift=missing  -> mirroring from Registry`,
        );
        if (apply) {
          const ok = await upsertAppMeta(tableName, projection);
          if (ok) {
            summary.fixed++;
          } else {
            summary.errors++;
          }
        }
        break;
      case 'stale': {
        summary.stale++;
        const field = firstDifferingField(projection, metaRow!);
        const registryValue =
          field !== null
            ? (projection as unknown as Record<string, unknown>)[field]
            : '<unknown>';
        const metaValue =
          field !== null
            ? (metaRow as unknown as Record<string, unknown>)[field]
            : '<unknown>';
        log(
          'info',
          `[agent] appId=${appId} drift=stale    field=${field ?? '<none>'} registry=${String(registryValue)} meta=${String(metaValue)}`,
        );
        break;
      }
      case 'orphan':
        // Pass 1 cannot produce an 'orphan' classification — it always has
        // a Registry projection. Defensive default.
        log(
          'warn',
          `[agent] appId=${appId} drift=orphan  unexpected in registry pass`,
        );
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Pass 2: walk the AppsTable, flag rows with no matching Registry record.
// ---------------------------------------------------------------------------

async function reconcileFromMeta(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  summary: Summary,
  seenAppIds: Set<string>,
): Promise<void> {
  log('info', '--- Pass 2: AppsTable #META → Registry ---');

  try {
    for await (const item of scanMetaRows(docClient, tableName)) {
      summary.scannedMeta++;
      const appId = String(item.appId ?? '');
      if (!appId) {
        log('warn', `[agent] appId=<missing> skipping #META row with no appId`);
        continue;
      }
      if (seenAppIds.has(appId)) continue; // matched in Pass 1 already
      summary.orphan++;
      log(
        'info',
        `[agent] appId=${appId} drift=orphan   in #META but not in Registry`,
      );
    }
  } catch (err) {
    log('error', `AppsTable scan failed: ${String(err)}`);
    summary.errors++;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Callable entry point — used by both the CLI `main()` and the
// EventBridge-scheduled Lambda handler.
// ---------------------------------------------------------------------------

export interface ReconciliationOptions {
  apply: boolean;
  // Optional injection points for testing (not used by Lambda or CLI):
  // registryService?: RegistryService;
  // appsTable?: string;
}

export interface ReconciliationSummary {
  mode: 'dry-run' | 'apply';
  scannedRegistry: number;
  scannedMeta: number;
  inSync: number;
  missing: number;
  stale: number;
  orphan: number;
  fixed: number;
  errors: number;
}

/**
 * Runs the two reconciliation passes (Registry → #META, then #META →
 * Registry) and returns a structured summary. Reads `REGISTRY_ID` and
 * `APPS_TABLE` from `process.env` directly — does NOT call
 * `bootstrapEnv()` (CLI-only env auto-load). Throws when required env
 * vars are absent so callers see the failure clearly.
 *
 * Used by:
 *   - CLI `main()` after it has populated env from cdk-outputs.json / .env.
 *   - EventBridge-scheduled Lambda (`reconcile-apps-meta-scheduled-handler`)
 *     which receives `REGISTRY_ID` / `APPS_TABLE` as Lambda env vars.
 */
export async function runReconciliation(
  options: ReconciliationOptions,
): Promise<ReconciliationSummary> {
  const { apply } = options;
  const dryRun = !apply;

  const registryId = process.env.REGISTRY_ID;
  const region = process.env.AWS_REGION || 'us-west-2';
  const appsTable = process.env.APPS_TABLE;

  if (!registryId) throw new Error('REGISTRY_ID env var required');
  if (!appsTable) throw new Error('APPS_TABLE env var required');

  log('info', `Mode: ${dryRun ? 'DRY-RUN' : 'APPLY'}`);
  log(
    'info',
    `REGISTRY_ID=${registryId} APPS_TABLE=${appsTable} REGION=${region}`,
  );

  const registry = new RegistryService({ registryId, region });
  const docClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region }),
  );

  const summary = emptySummary();
  const seenAppIds = new Set<string>();

  await reconcileFromRegistry(
    registry,
    docClient,
    appsTable,
    apply,
    summary,
    seenAppIds,
  );
  await reconcileFromMeta(docClient, appsTable, summary, seenAppIds);

  return {
    mode: dryRun ? 'dry-run' : 'apply',
    scannedRegistry: summary.scannedRegistry,
    scannedMeta: summary.scannedMeta,
    inSync: summary.inSync,
    missing: summary.missing,
    stale: summary.stale,
    orphan: summary.orphan,
    fixed: summary.fixed,
    errors: summary.errors,
  };
}

/**
 * CLI entry point. Parses args, populates env via the CLI-only auto-loaders
 * (cdk-outputs.json / .env / deterministic defaults), runs the
 * reconciliation, and logs the human-readable summary block to stdout.
 *
 * The summary log lines are intentionally CLI-only — the Lambda handler
 * logs the JSON-stringified summary instead.
 */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');

  // Reuse backfill-org-ids' env loaders for REGISTRY_ID / AWS_REGION /
  // ENVIRONMENT, then layer on APPS_TABLE-specific loaders.
  bootstrapEnv();
  loadAppsTableFromCdkOutputs();
  deriveAppsTable();

  const summary = await runReconciliation({ apply });

  log('info', '--- Reconciler summary ---');
  log('info', `mode:             ${summary.mode}`);
  log('info', `scanned-registry: ${summary.scannedRegistry}`);
  log('info', `scanned-meta:     ${summary.scannedMeta}`);
  log('info', `in-sync:          ${summary.inSync}`);
  log('info', `missing:          ${summary.missing}`);
  log('info', `stale:            ${summary.stale}`);
  log('info', `orphan:           ${summary.orphan}`);
  if (apply) {
    log('info', `fixed:            ${summary.fixed}`);
  }
  log('info', `errors:           ${summary.errors}`);
}

if (require.main === module) {
  main().catch((err) => {
    log('error', `Fatal: ${String(err)}`);
    process.exit(1);
  });
}
