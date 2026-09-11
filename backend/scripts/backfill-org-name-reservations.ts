/**
 * One-shot backfill for NAME# reservation rows on organisations that
 * already exist (finding 003a9234, mechanism 2).
 *
 * Context: createOrganization's duplicate-name protection is an atomic
 * conditional put of a `NAME#<name>` reservation row
 * (ConditionExpression: attribute_not_exists(orgId)) in the same
 * OrganisationTable — see organization-resolver.ts. That guard only works
 * for names that already HAVE a reservation row. seed-organizations now
 * writes one for every org it seeds (mechanism 1), but any organisation
 * created BEFORE this backfill runs — including a fresh deployment's
 * seeded rows from before this fix, or any org created via
 * createOrganization prior to PR 159 introducing the reservation
 * mechanism at all — has no reservation row, so its name remains
 * duplicable.
 *
 * This script:
 *   1. Scans the organisations table for every real org row (rows with no
 *      `itemType` — NAME# reservation/tombstone rows are excluded by
 *      construction, since they always carry `itemType`).
 *   2. Groups by `name`.
 *   3. For each name held by exactly ONE org, writes its NAME# reservation
 *      row with a conditional put (attribute_not_exists(orgId)) — safe to
 *      re-run: a reservation created by a previous run of this script, by
 *      seed-organizations, or by a createOrganization call since, is left
 *      untouched.
 *   4. For each name held by 2+ orgs, this is a PRE-EXISTING tenancy
 *      collision (decision 228b3cc8 makes the name the canonical tenancy
 *      key — two orgs sharing a name means two tenants sharing one key).
 *      The script does NOT pick a winner and does NOT write a reservation
 *      for that name. It reports the collision loudly (non-zero exit code
 *      in --apply mode, plus a clearly labelled summary section) and
 *      leaves resolution to an owner decision.
 *
 * Shape chosen: a standalone ts-node SCRIPT (matching
 * scripts/backfill-org-ids.ts), NOT a custom-resource/Lambda (matching
 * src/lambda/backfill-project-org.ts's alternative shape). Rationale: this
 * backfill needs no CDK wiring, no IAM role beyond whatever credentials
 * the operator already has configured locally, and no permanent
 * infrastructure — exactly backfill-org-ids.ts's profile (env-var driven,
 * dry-run by default, one AWS table touched). backfill-project-org.ts's
 * Lambda shape exists because that backfill's doc explicitly frames it as
 * "no permanent CDK Lambda resource" ceremony for a wider blast radius
 * (arbitrary orgId assignment via Cognito lookups); this backfill is a
 * single-table, single-purpose sweep that fits the lighter script pattern.
 *
 * Usage:
 *   ts-node backend/scripts/backfill-org-name-reservations.ts --dry-run  (default)
 *   ts-node backend/scripts/backfill-org-name-reservations.ts --apply
 *
 * Required env:
 *   ORGANIZATIONS_TABLE  – organisations DynamoDB table name
 *   AWS_REGION           – optional, defaults to us-west-2
 *
 * Constraints:
 *   - Dry-run by default. `--apply` flips to write mode.
 *   - Idempotent — re-running finds nothing new to reserve for names
 *     already covered, and re-reports (without re-mutating) any
 *     still-unresolved collision.
 *   - Never collapses a pre-existing duplicate name — collisions are
 *     reported, never auto-resolved.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
  type NativeAttributeValue,
} from "@aws-sdk/lib-dynamodb";

/** Mirrors nameReservationKey() in organization-resolver.ts — must stay
 * byte-identical to the resolver's own derivation. */
export function nameReservationKey(name: string): string {
  return `NAME#${name}`;
}

export interface OrgRow {
  orgId: string;
  name: string;
}

export interface GroupedByName {
  /** Names held by exactly one org — safe to reserve. */
  unique: Map<string, OrgRow>;
  /** Names held by 2+ orgs — pre-existing tenancy collisions, reported
   * (never auto-resolved) below. */
  collisions: Map<string, OrgRow[]>;
}

/**
 * Groups organisation rows by name. A name held by more than one org is a
 * pre-existing tenancy collision (decision 228b3cc8) and must NOT be
 * silently resolved by picking a winner — it is surfaced separately so the
 * caller can report it loudly instead of writing a reservation for it.
 */
export function groupOrgsByName(orgs: OrgRow[]): GroupedByName {
  const byName = new Map<string, OrgRow[]>();
  for (const org of orgs) {
    const list = byName.get(org.name) ?? [];
    list.push(org);
    byName.set(org.name, list);
  }

  const unique = new Map<string, OrgRow>();
  const collisions = new Map<string, OrgRow[]>();
  for (const [name, group] of byName) {
    if (group.length === 1) {
      unique.set(name, group[0]);
    } else {
      collisions.set(name, group);
    }
  }
  return { unique, collisions };
}

export interface BackfillSummary {
  /** Total org rows scanned. */
  scanned: number;
  /** Distinct names with exactly one org. */
  uniqueNames: number;
  /** Reservation rows newly written (apply mode) or that would be written
   * (dry-run mode). */
  reserved: number;
  /** Reservation rows that already existed and were left untouched. */
  alreadyReserved: number;
  /** Names held by 2+ orgs — reported, never resolved. */
  collisions: Array<{ name: string; orgIds: string[] }>;
  /** Per-row write failures (apply mode only), logged and swallowed. */
  errors: number;
}

function emptySummary(): BackfillSummary {
  return {
    scanned: 0,
    uniqueNames: 0,
    reserved: 0,
    alreadyReserved: 0,
    collisions: [],
    errors: 0,
  };
}

type LogLevel = "info" | "warn" | "error";

function log(level: LogLevel, msg: string): void {
  const ts = new Date().toISOString();
  const prefix =
    level === "error" ? "ERROR" : level === "warn" ? "WARN" : "INFO";
  const line = `${ts} [${prefix}] ${msg}`;
  if (level === "error") {
    // eslint-disable-next-line no-console
    console.error(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}

/**
 * Scans the organisations table for real org rows only (excludes NAME#
 * reservation/tombstone rows, which always carry `itemType`; a real org
 * row never does — see organization-resolver.ts's Organization type).
 */
export async function scanOrganizationRows(
  docClient: DynamoDBDocumentClient,
  tableName: string,
): Promise<OrgRow[]> {
  const rows: OrgRow[] = [];
  let exclusiveStartKey: Record<string, NativeAttributeValue> | undefined;

  do {
    const page = await docClient.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "attribute_not_exists(itemType)",
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) {
      if (typeof item.orgId === "string" && typeof item.name === "string") {
        rows.push({ orgId: item.orgId, name: item.name });
      }
    }
    exclusiveStartKey = page.LastEvaluatedKey as
      Record<string, NativeAttributeValue> | undefined;
  } while (exclusiveStartKey);

  return rows;
}

/**
 * Writes the NAME# reservation row for a single org, conditional on the
 * row not already existing. Idempotent: an existing reservation
 * (ConditionalCheckFailedException) is treated as success, not an error —
 * it means a previous run of this script, seed-organizations, or a real
 * createOrganization call already covers this name.
 *
 * Returns `true` if a new reservation was written, `false` if one already
 * existed.
 */
export async function reserveOrgName(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  org: OrgRow,
): Promise<boolean> {
  const now = new Date().toISOString();
  try {
    await docClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          orgId: nameReservationKey(org.name),
          itemType: "name_reservation",
          name: org.name,
          reservedOrgId: org.orgId,
          createdAt: now,
        },
        ConditionExpression: "attribute_not_exists(orgId)",
      }),
    );
    return true;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.name === "ConditionalCheckFailedException"
    ) {
      return false;
    }
    throw err;
  }
}

export async function runBackfill(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  apply: boolean,
): Promise<BackfillSummary> {
  const summary = emptySummary();

  const orgs = await scanOrganizationRows(docClient, tableName);
  summary.scanned = orgs.length;

  const { unique, collisions } = groupOrgsByName(orgs);
  summary.uniqueNames = unique.size;

  for (const [name, group] of collisions) {
    summary.collisions.push({
      name,
      orgIds: group.map((o) => o.orgId),
    });
    log(
      "error",
      `COLLISION: name "${name}" is held by ${group.length} organisations ` +
        `(orgIds: ${group.map((o) => o.orgId).join(", ")}) — this is a ` +
        "pre-existing tenancy collision (decision 228b3cc8: name is the " +
        "canonical tenancy key). NOT resolving automatically; no " +
        "reservation written for this name. An owner must decide which " +
        "org keeps the name (rename/merge/delete) before it can be safely " +
        "reserved.",
    );
  }

  for (const [name, org] of unique) {
    if (!apply) {
      log(
        "info",
        `[DRY-RUN] would reserve name "${name}" -> orgId=${org.orgId}`,
      );
      summary.reserved++;
      continue;
    }
    try {
      const wroteNew = await reserveOrgName(docClient, tableName, org);
      if (wroteNew) {
        log("info", `reserved name "${name}" -> orgId=${org.orgId}`);
        summary.reserved++;
      } else {
        log(
          "info",
          `name "${name}" already reserved (orgId=${org.orgId}); left untouched`,
        );
        summary.alreadyReserved++;
      }
    } catch (err) {
      log(
        "error",
        `failed to reserve name "${name}" (orgId=${org.orgId}): ${String(err)}`,
      );
      summary.errors++;
    }
  }

  return summary;
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dryRun = !apply;

  const tableName = process.env.ORGANIZATIONS_TABLE;
  const region = process.env.AWS_REGION || "us-west-2";

  if (!tableName) throw new Error("ORGANIZATIONS_TABLE env var required");

  log("info", `Mode: ${dryRun ? "DRY-RUN" : "APPLY"}`);
  log("info", `ORGANIZATIONS_TABLE=${tableName} REGION=${region}`);

  const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

  const summary = await runBackfill(docClient, tableName, apply);

  log("info", "--- Backfill summary ---");
  log("info", `mode:             ${dryRun ? "dry-run" : "apply"}`);
  log("info", `scanned:          ${summary.scanned}`);
  log("info", `unique names:     ${summary.uniqueNames}`);
  log("info", `reserved:         ${summary.reserved}`);
  log("info", `already reserved: ${summary.alreadyReserved}`);
  log("info", `collisions:       ${summary.collisions.length}`);
  log("info", `errors:           ${summary.errors}`);

  if (summary.collisions.length > 0) {
    log(
      "error",
      `${summary.collisions.length} unresolved name collision(s) — see ` +
        "COLLISION lines above. Exiting non-zero.",
    );
    process.exitCode = 1;
  }
}

/**
 * Entry-point guard that works under BOTH module systems this script is
 * actually invoked with:
 *   - ts-node / ts-jest, where the file is transpiled to CommonJS and
 *     `require`/`module` exist — checked via `require.main === module`.
 *   - Node's native TypeScript execution (Node 23+, strips types and runs
 *     the file as ESM), where `require` is undefined — detected via
 *     `typeof require === "undefined"` and treated as "this file is the
 *     entrypoint" because these scripts are never imported by another ESM
 *     module, only executed directly or required by CJS tests.
 * `typeof require` (rather than a bare `require` reference) avoids a
 * ReferenceError under ESM, where the identifier doesn't exist at all.
 */
const isCjsEntrypoint =
  typeof require !== "undefined" && require.main === module;
const isEsmEntrypoint = typeof require === "undefined";

if (isCjsEntrypoint || isEsmEntrypoint) {
  main().catch((err) => {
    log("error", `Fatal: ${String(err)}`);
    process.exit(1);
  });
}
