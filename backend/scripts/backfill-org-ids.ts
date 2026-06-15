/**
 * Phase 2c: one-shot backfill for the orgId field on legacy records.
 *
 * Backfills `meta.orgId` (custom metadata) on Registry records and the
 * `orgId` column on DDB-legacy AgentConfig / ToolsConfig rows for which
 * Phase 2b fabricator threading did not stamp the field (because the
 * records predate the change). Per decision D2(c):
 *
 *   For each record:
 *     - If orgId already set and non-empty → skip.
 *     - If createdBy is absent / '' / 'fabricator' / 'unknown'
 *         → assign 'system' (sentinel) — visible to all via admin paths.
 *     - Else look up createdBy in Cognito (AdminGetUserCommand).
 *         - User exists with custom:organization → use that orgId.
 *         - User missing or no org → assign 'system' (WARN).
 *
 * Usage:
 *   ts-node backend/scripts/backfill-org-ids.ts --dry-run   (default)
 *   ts-node backend/scripts/backfill-org-ids.ts --apply
 *
 * Required env:
 *   REGISTRY_ID           – AgentCore Registry id
 *   USER_POOL_ID          – Cognito user pool id (for AdminGetUser)
 *   AGENT_CONFIG_TABLE    – DDB table name for legacy agent configs
 *   TOOL_CONFIG_TABLE     – DDB table name for legacy tool configs
 *   AWS_REGION            – optional, defaults to us-west-2
 *
 * Constraints:
 *   - Dry-run by default. `--apply` flips to write mode.
 *   - Idempotent — re-running finds nothing to update.
 *   - Rate-limit aware — small sleep between Cognito lookups.
 *   - Per-record errors are logged and swallowed; the main loop never
 *     throws.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  RegistryService,
  ResourceType,
  RegistryRecord,
} from '../src/services/registry-service';

// ---------------------------------------------------------------------------
// Env auto-load helpers
// ---------------------------------------------------------------------------
//
// Convenience: when invoked locally, populate the required env vars from the
// repo-root `cdk-outputs.json` (written by deploy.sh) and `backend/.env`.
// This eliminates the need to manually `export REGISTRY_ID=...` etc. when
// re-running the script after a deploy.
//
// All loaders are no-ops when the source files are missing or malformed, and
// they NEVER overwrite a value that is already set on `process.env`. The
// existing fail-fast checks in `main()` still surface missing values.

/** Walk up at most `maxDepth` parents from `startDir` to find a file. */
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
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Populates REGISTRY_ID, USER_POOL_ID, AGENT_CONFIG_TABLE from the nearest
 * `cdk-outputs.json` (under the `citadel-backend-dev` stack key) when the
 * corresponding env var is unset. Tolerates the `ExportsOutputRef*`-prefixed
 * key form that CDK emits for cross-stack exports by suffix-matching on the
 * human-readable key name.
 */
export function loadEnvFromCdkOutputs(): void {
  const outputsPath = findUpwards(process.cwd(), 'cdk-outputs.json');
  if (!outputsPath) return;

  let outputs: Record<string, Record<string, unknown>>;
  try {
    outputs = JSON.parse(fs.readFileSync(outputsPath, 'utf8'));
  } catch {
    return; // malformed; let the env-var requirement check surface the real error
  }
  const backend = (outputs['citadel-backend-dev'] ?? {}) as Record<
    string,
    unknown
  >;

  // Resolve a value by trying exact-match keys first, then falling back to
  // suffix-match (which matches CDK's `ExportsOutputRef<Logical>...` form).
  const pickFirst = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = backend[k];
      if (typeof v === 'string' && v) return v;
    }
    for (const k of Object.keys(backend)) {
      for (const suffix of keys) {
        if (k.includes(suffix)) {
          const v = backend[k];
          if (typeof v === 'string' && v) return v;
        }
      }
    }
    return undefined;
  };

  if (!process.env.REGISTRY_ID) {
    const v = pickFirst('AgentCoreRegistryId');
    if (v) process.env.REGISTRY_ID = v;
  }
  if (!process.env.USER_POOL_ID) {
    const v = pickFirst('UserPoolId', 'UserPoolIdExport');
    if (v) process.env.USER_POOL_ID = v;
  }
  if (!process.env.AGENT_CONFIG_TABLE) {
    const v = pickFirst('AgentConfigTable');
    if (v) process.env.AGENT_CONFIG_TABLE = v;
  }
}

/**
 * Populates AWS_REGION (from `CDK_DEFAULT_REGION`) and ENVIRONMENT from the
 * nearest `backend/.env` (or `.env`). Pre-existing env vars are not
 * overwritten. The parser is intentionally minimal — KEY=VALUE per line,
 * `#` comments, surrounding quotes stripped — to avoid pulling in a new
 * `dotenv` dependency.
 */
export function loadEnvFromDotenv(): void {
  const candidates = [
    path.join(process.cwd(), 'backend', '.env'),
    path.join(process.cwd(), '.env'),
  ];
  for (const dotenv of candidates) {
    if (!fs.existsSync(dotenv)) continue;
    let text: string;
    try {
      text = fs.readFileSync(dotenv, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (k === 'CDK_DEFAULT_REGION' && !process.env.AWS_REGION) {
        process.env.AWS_REGION = v;
      }
      if (k === 'ENVIRONMENT' && !process.env.ENVIRONMENT) {
        process.env.ENVIRONMENT = v;
      }
    }
    break;
  }
}

/**
 * Derives TOOL_CONFIG_TABLE from `ENVIRONMENT` using the deterministic
 * `citadel-tools-${ENVIRONMENT}` pattern from arbiter-stack.ts. The table is
 * not exported in cdk-outputs.json, so we synthesize the name. Defaults to
 * `citadel-tools-dev` when ENVIRONMENT is unset.
 */
export function deriveToolsTable(): void {
  if (process.env.TOOL_CONFIG_TABLE) return;
  const env = process.env.ENVIRONMENT || 'dev';
  process.env.TOOL_CONFIG_TABLE = `citadel-tools-${env}`;
}

/**
 * Convenience entry point. Order matters: dotenv must run before
 * `deriveToolsTable` so `ENVIRONMENT` is populated when synthesizing the
 * tools table name.
 */
export function bootstrapEnv(): void {
  loadEnvFromCdkOutputs();
  loadEnvFromDotenv();
  deriveToolsTable();
}

// ---------------------------------------------------------------------------
// Pure logic helpers (exported for unit tests)
// ---------------------------------------------------------------------------

export type OrgSource = 'skip' | 'sentinel' | 'claim-copy' | 'cognito-lookup';

export interface MetaShape {
  orgId?: string | null;
  createdBy?: string | null;
}

export interface CognitoUserShape {
  /** Value of the `custom:organization` attribute, or null if absent. */
  orgId?: string | null;
}

/**
 * Decides how to resolve the orgId for a record, given the stored metadata
 * and (optionally) a resolved Cognito user.
 *
 *   - `skip`           – meta.orgId is already set and non-empty.
 *   - `sentinel`       – no way to resolve (absent/fabricator/unknown
 *                        creator, or Cognito returned no org).
 *   - `cognito-lookup` – createdBy is a real user and cognitoUser has not
 *                        yet been resolved (caller should fetch and retry).
 *   - `claim-copy`     – Cognito lookup succeeded and provides a non-empty
 *                        orgId to copy into the record.
 */
export function classifyOrgSource(
  meta: MetaShape | null | undefined,
  cognitoUser: CognitoUserShape | null | undefined,
): OrgSource {
  const existingOrgId = (meta?.orgId ?? '').toString().trim();
  if (existingOrgId !== '') return 'skip';

  const createdBy = (meta?.createdBy ?? '').toString().trim();
  const isSentinelCreator =
    !createdBy || createdBy === 'fabricator' || createdBy === 'unknown';
  if (isSentinelCreator) return 'sentinel';

  // Real user identity. If caller has not supplied a resolved Cognito user
  // yet, signal that a lookup is required.
  if (cognitoUser === null || cognitoUser === undefined) return 'cognito-lookup';

  const cognitoOrgId = (cognitoUser.orgId ?? '').toString().trim();
  if (cognitoOrgId !== '') return 'claim-copy';

  // Cognito resolved but user has no org attribute.
  return 'sentinel';
}

/**
 * Derives the orgId value to persist, given createdBy and the (optional)
 * resolved Cognito user.
 *
 * Sentinel creators and users with no resolvable org both collapse to
 * the 'system' literal.
 */
export function deriveOrgId(
  createdBy: string | null | undefined,
  cognitoUser: CognitoUserShape | null | undefined,
): string {
  const cb = (createdBy ?? '').toString().trim();
  if (!cb || cb === 'fabricator' || cb === 'unknown') return 'system';
  const cognitoOrg = (cognitoUser?.orgId ?? '').toString().trim();
  if (cognitoOrg !== '') return cognitoOrg;
  return 'system';
}

// ---------------------------------------------------------------------------
// Summary accumulation
// ---------------------------------------------------------------------------

interface Summary {
  scanned: number;
  updated: number;
  sentinel: number;
  alreadyPopulated: number;
  errors: number;
}

function emptySummary(): Summary {
  return {
    scanned: 0,
    updated: 0,
    sentinel: 0,
    alreadyPopulated: 0,
    errors: 0,
  };
}

function addSummary(dst: Summary, src: Summary): void {
  dst.scanned += src.scanned;
  dst.updated += src.updated;
  dst.sentinel += src.sentinel;
  dst.alreadyPopulated += src.alreadyPopulated;
  dst.errors += src.errors;
}

// ---------------------------------------------------------------------------
// Infrastructure helpers
// ---------------------------------------------------------------------------

/** Min wait between AdminGetUser calls to stay under the TPS cap. */
const COGNITO_SLEEP_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type LogLevel = 'info' | 'warn' | 'error';

function log(level: LogLevel, msg: string): void {
  const ts = new Date().toISOString();
  const prefix =
    level === 'error' ? 'ERROR' : level === 'warn' ? 'WARN' : 'INFO';
  // One line per event; use stdout for info/warn, stderr for error.
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
 * Fetches a Cognito user's `custom:organization` attribute.
 *
 *   - User exists       → `{ orgId: string | null }`
 *   - User not found    → `null`
 *   - Any other error   → thrown (caller decides)
 */
async function lookupCognitoOrg(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  username: string,
): Promise<CognitoUserShape | null> {
  try {
    const response = await cognito.send(
      new AdminGetUserCommand({
        UserPoolId: userPoolId,
        Username: username,
      }),
    );
    const attr = response.UserAttributes?.find(
      (a) => a.Name === 'custom:organization',
    );
    return { orgId: attr?.Value || null };
  } catch (err: any) {
    if (err?.name === 'UserNotFoundException') {
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Per-record processing (Registry)
// ---------------------------------------------------------------------------

async function processRegistryRecord(
  type: ResourceType,
  registry: RegistryService,
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  record: RegistryRecord,
  apply: boolean,
  summary: Summary,
): Promise<void> {
  summary.scanned++;
  const recordId = record.recordId;

  let meta: Record<string, any>;
  try {
    meta = record.customDescriptorContent
      ? JSON.parse(record.customDescriptorContent)
      : {};
  } catch (err) {
    log(
      'error',
      `[${type}] recordId=${recordId} malformed customDescriptorContent: ${String(err)}`,
    );
    summary.errors++;
    return;
  }

  // Skip fast path.
  if (classifyOrgSource(meta, undefined) === 'skip') {
    summary.alreadyPopulated++;
    log(
      'info',
      `[${type}] recordId=${recordId} createdBy=${meta.createdBy || '<absent>'} -> already populated (orgId=${meta.orgId})`,
    );
    return;
  }

  const createdBy = (meta.createdBy ?? '').toString().trim();
  const isSentinelCreator =
    !createdBy || createdBy === 'fabricator' || createdBy === 'unknown';

  let cognitoUser: CognitoUserShape | null = null;
  let source: 'sentinel' | 'cognito-lookup';

  if (isSentinelCreator) {
    source = 'sentinel';
  } else {
    try {
      cognitoUser = await lookupCognitoOrg(cognito, userPoolId, createdBy);
      await sleep(COGNITO_SLEEP_MS);
    } catch (err) {
      log(
        'error',
        `[${type}] recordId=${recordId} Cognito lookup failed: ${String(err)}`,
      );
      summary.errors++;
      return;
    }
    source = cognitoUser?.orgId ? 'cognito-lookup' : 'sentinel';
    if (source === 'sentinel') {
      log(
        'warn',
        `[${type}] recordId=${recordId} createdBy=${createdBy} user missing or no org in Cognito; assigning sentinel`,
      );
    }
  }

  const orgId = deriveOrgId(createdBy, cognitoUser);
  log(
    'info',
    `[${type}] recordId=${recordId} createdBy=${createdBy || '<absent>'} -> orgId=${orgId} (${source})`,
  );

  if (!apply) {
    if (source === 'sentinel') summary.sentinel++;
    summary.updated++;
    return;
  }

  // Preserve all existing metadata fields; only set / overwrite orgId.
  const updatedMeta = { ...meta, orgId };
  try {
    await registry.updateResource(type, recordId, {
      customMetadata: JSON.stringify(updatedMeta),
    });
    summary.updated++;
    if (source === 'sentinel') summary.sentinel++;
  } catch (err) {
    log(
      'error',
      `[${type}] recordId=${recordId} registry write failed: ${String(err)}`,
    );
    summary.errors++;
  }
}

async function processRegistry(
  type: ResourceType,
  registry: RegistryService,
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  apply: boolean,
): Promise<Summary> {
  const summary = emptySummary();
  log('info', `--- Processing registry '${type}' records ---`);

  let records: RegistryRecord[];
  try {
    records = await registry.listResources(type);
  } catch (err) {
    log('error', `Failed to list ${type} registry records: ${String(err)}`);
    summary.errors++;
    return summary;
  }

  for (const rec of records) {
    try {
      await processRegistryRecord(
        type,
        registry,
        cognito,
        userPoolId,
        rec,
        apply,
        summary,
      );
    } catch (err) {
      log(
        'error',
        `[${type}] recordId=${rec.recordId} unexpected error: ${String(err)}`,
      );
      summary.errors++;
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Per-record processing (DDB-legacy tables)
// ---------------------------------------------------------------------------

async function processDdbTable(
  kind: 'agent' | 'tool',
  tableName: string,
  docClient: DynamoDBDocumentClient,
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  apply: boolean,
): Promise<Summary> {
  const summary = emptySummary();
  log('info', `--- Processing DDB '${kind}' table: ${tableName} ---`);

  const pkName = kind === 'agent' ? 'agentId' : 'toolId';
  let exclusiveStartKey: Record<string, any> | undefined;

  do {
    let scanResult;
    try {
      scanResult = await docClient.send(
        new ScanCommand({
          TableName: tableName,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
    } catch (err) {
      log('error', `DDB scan failed for ${tableName}: ${String(err)}`);
      summary.errors++;
      return summary;
    }

    for (const item of scanResult.Items || []) {
      summary.scanned++;
      const id = item[pkName];
      try {
        const existingOrgId = (item.orgId ?? '').toString().trim();
        if (existingOrgId !== '') {
          summary.alreadyPopulated++;
          log(
            'info',
            `[${kind}] recordId=${id} createdBy=${item.createdBy || '<absent>'} -> already populated (orgId=${existingOrgId})`,
          );
          continue;
        }

        const createdBy = (item.createdBy ?? '').toString().trim();
        const isSentinelCreator =
          !createdBy ||
          createdBy === 'fabricator' ||
          createdBy === 'unknown';

        let cognitoUser: CognitoUserShape | null = null;
        let source: 'sentinel' | 'cognito-lookup';

        if (isSentinelCreator) {
          source = 'sentinel';
        } else {
          try {
            cognitoUser = await lookupCognitoOrg(
              cognito,
              userPoolId,
              createdBy,
            );
            await sleep(COGNITO_SLEEP_MS);
          } catch (err) {
            log(
              'error',
              `[${kind}] recordId=${id} Cognito lookup failed: ${String(err)}`,
            );
            summary.errors++;
            continue;
          }
          source = cognitoUser?.orgId ? 'cognito-lookup' : 'sentinel';
          if (source === 'sentinel') {
            log(
              'warn',
              `[${kind}] recordId=${id} createdBy=${createdBy} user missing or no org in Cognito; assigning sentinel`,
            );
          }
        }

        const orgId = deriveOrgId(createdBy, cognitoUser);
        log(
          'info',
          `[${kind}] recordId=${id} createdBy=${createdBy || '<absent>'} -> orgId=${orgId} (${source})`,
        );

        if (!apply) {
          if (source === 'sentinel') summary.sentinel++;
          summary.updated++;
          continue;
        }

        try {
          await docClient.send(
            new UpdateCommand({
              TableName: tableName,
              Key: { [pkName]: id },
              UpdateExpression:
                'SET #orgId = :orgId, #updatedAt = :updatedAt',
              ExpressionAttributeNames: {
                '#orgId': 'orgId',
                '#updatedAt': 'updatedAt',
              },
              ExpressionAttributeValues: {
                ':orgId': orgId,
                ':updatedAt': new Date().toISOString(),
              },
              ReturnValues: 'UPDATED_NEW',
            }),
          );
          summary.updated++;
          if (source === 'sentinel') summary.sentinel++;
        } catch (err) {
          log(
            'error',
            `[${kind}] recordId=${id} DDB write failed: ${String(err)}`,
          );
          summary.errors++;
        }
      } catch (err) {
        log(
          'error',
          `[${kind}] recordId=${id} unexpected error: ${String(err)}`,
        );
        summary.errors++;
      }
    }

    exclusiveStartKey = scanResult.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return summary;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Entry point. Parses args, validates env, and orchestrates the four
 * record sources (Registry agents, Registry tools, DDB agents, DDB tools).
 */
export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const dryRun = !apply;

  // Auto-load env vars from cdk-outputs.json + backend/.env when not already
  // set in the environment. Keeps the manual `export REGISTRY_ID=...` flow
  // working unchanged — pre-set values always win.
  bootstrapEnv();

  const registryId = process.env.REGISTRY_ID;
  const userPoolId = process.env.USER_POOL_ID;
  const region = process.env.AWS_REGION || 'us-west-2';
  const agentTable = process.env.AGENT_CONFIG_TABLE;
  const toolTable = process.env.TOOL_CONFIG_TABLE;

  if (!registryId) throw new Error('REGISTRY_ID env var required');
  if (!userPoolId) throw new Error('USER_POOL_ID env var required');
  if (!agentTable) throw new Error('AGENT_CONFIG_TABLE env var required');
  if (!toolTable) throw new Error('TOOL_CONFIG_TABLE env var required');

  log('info', `Mode: ${dryRun ? 'DRY-RUN' : 'APPLY'}`);
  log(
    'info',
    `REGISTRY_ID=${registryId} USER_POOL_ID=${userPoolId} REGION=${region}`,
  );
  log(
    'info',
    `AGENT_CONFIG_TABLE=${agentTable} TOOL_CONFIG_TABLE=${toolTable}`,
  );

  const registry = new RegistryService({ registryId, region });
  const cognito = new CognitoIdentityProviderClient({ region });
  const docClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region }),
  );

  const totals = emptySummary();

  addSummary(
    totals,
    await processRegistry('agent', registry, cognito, userPoolId, apply),
  );
  addSummary(
    totals,
    await processRegistry('tool', registry, cognito, userPoolId, apply),
  );
  addSummary(
    totals,
    await processDdbTable(
      'agent',
      agentTable,
      docClient,
      cognito,
      userPoolId,
      apply,
    ),
  );
  addSummary(
    totals,
    await processDdbTable(
      'tool',
      toolTable,
      docClient,
      cognito,
      userPoolId,
      apply,
    ),
  );

  log('info', '--- Backfill summary ---');
  log('info', `mode:              ${dryRun ? 'dry-run' : 'apply'}`);
  log('info', `scanned:           ${totals.scanned}`);
  log('info', `updated:           ${totals.updated}`);
  log('info', `sentinel-assigned: ${totals.sentinel}`);
  log('info', `already-populated: ${totals.alreadyPopulated}`);
  log('info', `errors:            ${totals.errors}`);
}

if (require.main === module) {
  main().catch((err) => {
    log('error', `Fatal: ${String(err)}`);
    process.exit(1);
  });
}
