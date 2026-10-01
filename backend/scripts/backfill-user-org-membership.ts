/**
 * One-shot backfill of the UserOrgMembership table from the legacy
 * `custom:organization` Cognito attribute (decision 00d40a31, option A —
 * server-derived org claim, 2026-09-30).
 *
 * Why this exists: the pre-token-generation trigger
 * (src/lambda/pre-token-generation.ts) now mints the `custom:organization`
 * JWT claim ONLY from the UserOrgMembership DynamoDB table (pk `sub`) and
 * never reads the stored user-pool attribute. `assignUserRole` dual-writes
 * the row and the attribute going forward, but every user assigned BEFORE
 * that change has an attribute and no row — so the next token they mint
 * after the deploy carries no org claim, and every org-scoped resolver
 * fails closed on them. This script creates the missing rows from the
 * attribute, once, so that transition is invisible to users.
 *
 * Model (decisions 228b3cc8 / 00d40a31):
 *   - The membership table is AUTHORITATIVE for user↔org; the attribute is
 *     a display/back-compat mirror. This script therefore only ever FILLS
 *     GAPS — it never overwrites a row that already exists, even when the
 *     row disagrees with the attribute (that is reported, not "fixed").
 *   - `orgName` is the canonical organisation NAME (never an orgId) and
 *     must match a LIVE `name` row in the organisations table. NAME#
 *     reservation / tombstone rows (which carry `itemType`) do not count.
 *   - Comparison is byte-exact (no trim / case-fold).
 *
 * Per user:
 *   no custom:organization            → NO_ORG_ATTRIBUTE (nothing to do)
 *   no `sub` attribute                → NO_SUB            (finding; manual)
 *   attribute is not a live org name  → SKIPPED_UNKNOWN_ORG (finding; fix
 *                                       via the attribute sweep / assignUserRole)
 *   row exists, same orgName          → ALREADY_PRESENT   (idempotent)
 *   row exists, different orgName     → SKIPPED_ROW_MISMATCH (finding; the
 *                                       row wins, an admin must reconcile)
 *   live org, no row                  → WRITE: PutItem {sub, orgName,
 *                                       updatedAt, updatedBy:'backfill'}
 *                                       with attribute_not_exists(sub) so a
 *                                       concurrent assignUserRole is never
 *                                       clobbered.
 *
 * Usage:
 *   npm run backfill:user-org-membership                 (dry-run, default)
 *   npm run backfill:user-org-membership -- --dry-run    (same; explicit)
 *   npm run backfill:user-org-membership -- --apply
 *
 * Required env:
 *   USER_POOL_ID               – Cognito user pool id
 *   ORGANISATION_TABLE         – organisations DynamoDB table name
 *   USER_ORG_MEMBERSHIP_TABLE  – UserOrgMembership DynamoDB table name
 *   AWS_REGION                 – optional, defaults to us-west-2
 *
 * Exit codes:
 *   0  nothing left to do (every user has a row, or nothing to backfill)
 *   1  fatal error, or one or more PutItem writes failed
 *   3  work remains: dry-run found rows to write, and/or findings
 *      (SKIPPED_UNKNOWN_ORG / SKIPPED_ROW_MISMATCH / NO_SUB) need a human
 *
 * Output hygiene: only `username` and `sub` are ever printed. ListUsers is
 * called WITHOUT AttributesToGet (Cognito rejects `custom:` names there —
 * finding c8ccaea5), so the full attribute record comes back per page; the
 * script immediately projects sub + custom:organization and discards the
 * rest. Email and other PII are never retained or logged.
 *
 * Deploy order and the token window are documented in
 * docs/runbooks/user-org-membership-backfill.md.
 *
 * This file deliberately imports no local project module (it mirrors
 * loadValidOrgNames from audit-cognito-custom-attributes.ts instead) so it
 * also runs under Node's native TypeScript execution, whose ESM loader
 * cannot resolve extensionless relative imports.
 */
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  type AttributeType,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  type NativeAttributeValue,
} from "@aws-sdk/lib-dynamodb";

// ---------------------------------------------------------------------------
// Pure logic (exported for unit tests — no AWS involvement)
// ---------------------------------------------------------------------------

export interface PoolUser {
  username: string;
  sub?: string;
  /** Value of `custom:organization`, or null/undefined when absent. */
  organization?: string | null;
}

export interface MembershipRow {
  sub?: string;
  orgName?: unknown;
}

export type Outcome =
  | "WRITE"
  | "ALREADY_PRESENT"
  | "SKIPPED_ROW_MISMATCH"
  | "SKIPPED_UNKNOWN_ORG"
  | "NO_ORG_ATTRIBUTE"
  | "NO_SUB";

export type FindingKind = Extract<
  Outcome,
  "SKIPPED_UNKNOWN_ORG" | "SKIPPED_ROW_MISMATCH" | "NO_SUB"
>;

export interface Finding {
  username: string;
  sub?: string;
  kind: FindingKind;
  detail: string;
}

/**
 * Decides what to do for one user. `existingRow` is the membership row
 * already stored under the user's `sub` (null when none). Pure.
 */
export function classifyUser(
  user: PoolUser,
  validOrgNames: ReadonlySet<string>,
  existingRow: MembershipRow | null | undefined,
): Outcome {
  const org = user.organization ?? "";
  if (org === "") return "NO_ORG_ATTRIBUTE";
  if (!user.sub) return "NO_SUB";
  if (!validOrgNames.has(org)) return "SKIPPED_UNKNOWN_ORG";
  if (existingRow) {
    return existingRow.orgName === org
      ? "ALREADY_PRESENT"
      : "SKIPPED_ROW_MISMATCH";
  }
  return "WRITE";
}

export interface CliFlags {
  apply: boolean;
}

/**
 * `--dry-run` is an explicit no-op alias for the default; combining it
 * with `--apply` is rejected rather than resolved by precedence.
 */
export function parseFlags(argv: string[]): CliFlags {
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run");
  if (apply && dryRun) {
    throw new Error("--dry-run and --apply are mutually exclusive");
  }
  return { apply };
}

// ---------------------------------------------------------------------------
// Infrastructure helpers
// ---------------------------------------------------------------------------

/** Default pause between Cognito/DynamoDB calls to stay under the TPS cap. */
const DEFAULT_SLEEP_MS = 50;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * Loads the set of live organisation NAMES. Mirrors
 * audit-cognito-custom-attributes.ts's loadValidOrgNames: a real org row
 * has a `name` and never carries `itemType`; NAME# reservation/tombstone
 * rows always do and are excluded by the filter expression (and again
 * defensively in code).
 */
export async function loadValidOrgNames(
  doc: DynamoDBDocumentClient,
  tableName: string,
): Promise<Set<string>> {
  const names = new Set<string>();
  let exclusiveStartKey: Record<string, NativeAttributeValue> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "attribute_not_exists(itemType)",
        ProjectionExpression: "#n, itemType",
        ExpressionAttributeNames: { "#n": "name" },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const item of page.Items ?? []) {
      if (item.itemType !== undefined) continue;
      if (typeof item.name === "string" && item.name !== "") {
        names.add(item.name);
      }
    }
    exclusiveStartKey = page.LastEvaluatedKey as
      Record<string, NativeAttributeValue> | undefined;
  } while (exclusiveStartKey);
  return names;
}

function attr(attrs: AttributeType[] | undefined, name: string): string | null {
  return attrs?.find((a) => a.Name === name)?.Value ?? null;
}

/** Streams every user in the pool, projected to {username, sub, organization}. */
async function* iterateUsers(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  sleepMs: number,
): AsyncGenerator<PoolUser> {
  let paginationToken: string | undefined;
  do {
    const page = await cognito.send(
      new ListUsersCommand({
        UserPoolId: userPoolId,
        // AttributesToGet is deliberately OMITTED (finding c8ccaea5): a
        // `custom:` name there fails the whole call, and ["sub"] alone would
        // drop the attribute we are backfilling from. Project client-side.
        PaginationToken: paginationToken,
      }),
    );
    for (const u of page.Users ?? []) {
      if (!u.Username) continue;
      yield {
        username: u.Username,
        sub: attr(u.Attributes, "sub") ?? undefined,
        organization: attr(u.Attributes, "custom:organization"),
      };
    }
    paginationToken = page.PaginationToken;
    if (paginationToken) await sleep(sleepMs);
  } while (paginationToken);
}

async function getMembershipRow(
  doc: DynamoDBDocumentClient,
  tableName: string,
  sub: string,
): Promise<MembershipRow | null> {
  const result = await doc.send(
    new GetCommand({ TableName: tableName, Key: { sub } }),
  );
  return (result.Item as MembershipRow | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface BackfillSummary {
  mode: "dry-run" | "apply";
  scanned: number;
  /** Rows the run would write (dry-run) or attempted to write (apply). */
  plannedWrites: number;
  /** Rows actually written (apply only). */
  written: number;
  alreadyPresent: number;
  rowMismatch: number;
  skippedUnknownOrg: number;
  noOrgAttribute: number;
  noSub: number;
  errors: number;
}

export interface BackfillResult {
  exitCode: 0 | 1 | 3;
  summary: BackfillSummary;
  findings: Finding[];
}

export interface RunBackfillOptions {
  cognito: CognitoIdentityProviderClient;
  doc: DynamoDBDocumentClient;
  userPoolId: string;
  organisationTable: string;
  membershipTable: string;
  apply: boolean;
  sleepMs?: number;
}

export async function runBackfill(
  opts: RunBackfillOptions,
): Promise<BackfillResult> {
  const {
    cognito,
    doc,
    userPoolId,
    organisationTable,
    membershipTable,
    apply,
  } = opts;
  const sleepMs = opts.sleepMs ?? DEFAULT_SLEEP_MS;

  const summary: BackfillSummary = {
    mode: apply ? "apply" : "dry-run",
    scanned: 0,
    plannedWrites: 0,
    written: 0,
    alreadyPresent: 0,
    rowMismatch: 0,
    skippedUnknownOrg: 0,
    noOrgAttribute: 0,
    noSub: 0,
    errors: 0,
  };
  const findings: Finding[] = [];

  const validOrgNames = await loadValidOrgNames(doc, organisationTable);
  log("info", `loaded ${validOrgNames.size} live organisation name(s)`);

  for await (const user of iterateUsers(cognito, userPoolId, sleepMs)) {
    summary.scanned++;
    const who = `username=${user.username} sub=${user.sub ?? "-"}`;

    // Cheap pure pre-checks first so users with nothing to backfill never
    // cost a DynamoDB read.
    const pre = classifyUser(user, validOrgNames, null);
    if (pre === "NO_ORG_ATTRIBUTE") {
      summary.noOrgAttribute++;
      continue;
    }
    if (pre === "NO_SUB") {
      summary.noSub++;
      findings.push({
        username: user.username,
        sub: user.sub,
        kind: "NO_SUB",
        detail: "user record has no sub attribute; cannot key a membership row",
      });
      log("warn", `${who} NO_SUB`);
      continue;
    }
    if (pre === "SKIPPED_UNKNOWN_ORG") {
      summary.skippedUnknownOrg++;
      findings.push({
        username: user.username,
        sub: user.sub,
        kind: "SKIPPED_UNKNOWN_ORG",
        detail: `custom:organization=${user.organization} is not a live organisation name`,
      });
      log("warn", `${who} SKIPPED_UNKNOWN_ORG org=${user.organization}`);
      continue;
    }

    let existing: MembershipRow | null;
    try {
      await sleep(sleepMs);
      existing = await getMembershipRow(doc, membershipTable, user.sub!);
    } catch (err) {
      summary.errors++;
      log("error", `${who} membership GetItem failed: ${String(err)}`);
      continue;
    }

    const outcome = classifyUser(user, validOrgNames, existing);
    if (outcome === "ALREADY_PRESENT") {
      summary.alreadyPresent++;
      log("info", `${who} ALREADY_PRESENT org=${user.organization}`);
      continue;
    }
    if (outcome === "SKIPPED_ROW_MISMATCH") {
      summary.rowMismatch++;
      findings.push({
        username: user.username,
        sub: user.sub,
        kind: "SKIPPED_ROW_MISMATCH",
        detail: `membership row orgName=${String(existing?.orgName)} differs from custom:organization=${user.organization}; row left untouched`,
      });
      log(
        "warn",
        `${who} SKIPPED_ROW_MISMATCH row=${String(existing?.orgName)} attribute=${user.organization}`,
      );
      continue;
    }

    // outcome === "WRITE"
    summary.plannedWrites++;
    if (!apply) {
      log("info", `${who} WOULD WRITE org=${user.organization}`);
      continue;
    }
    try {
      await sleep(sleepMs);
      await doc.send(
        new PutCommand({
          TableName: membershipTable,
          Item: {
            sub: user.sub,
            orgName: user.organization,
            updatedAt: new Date().toISOString(),
            updatedBy: "backfill",
          },
          // Fill-gaps-only: if assignUserRole wrote a row between our
          // GetItem and this PutItem, the newer row wins.
          ConditionExpression: "attribute_not_exists(#sub)",
          ExpressionAttributeNames: { "#sub": "sub" },
        }),
      );
      summary.written++;
      log("info", `${who} WRITTEN org=${user.organization}`);
    } catch (err) {
      if (
        err instanceof Error &&
        err.name === "ConditionalCheckFailedException"
      ) {
        summary.plannedWrites--;
        summary.alreadyPresent++;
        log("info", `${who} row appeared concurrently; left untouched`);
        continue;
      }
      summary.errors++;
      log("error", `${who} membership PutItem failed: ${String(err)}`);
    }
  }

  const pendingWrites = apply ? 0 : summary.plannedWrites;
  let exitCode: 0 | 1 | 3 = 0;
  if (summary.errors > 0) exitCode = 1;
  else if (findings.length > 0 || pendingWrites > 0) exitCode = 3;

  log("info", "--- Backfill summary ---");
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ summary, findings }, null, 2));

  return { exitCode, summary, findings };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const { apply } = parseFlags(argv);

  const userPoolId = process.env.USER_POOL_ID;
  const organisationTable = process.env.ORGANISATION_TABLE;
  const membershipTable = process.env.USER_ORG_MEMBERSHIP_TABLE;
  const region = process.env.AWS_REGION || "us-west-2";

  if (!userPoolId) throw new Error("USER_POOL_ID env var required");
  if (!organisationTable)
    throw new Error("ORGANISATION_TABLE env var required");
  if (!membershipTable)
    throw new Error("USER_ORG_MEMBERSHIP_TABLE env var required");

  log("info", `Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
  log(
    "info",
    `USER_POOL_ID=${userPoolId} ORGANISATION_TABLE=${organisationTable} USER_ORG_MEMBERSHIP_TABLE=${membershipTable} REGION=${region}`,
  );

  const cognito = new CognitoIdentityProviderClient({ region });
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

  const result = await runBackfill({
    cognito,
    doc,
    userPoolId,
    organisationTable,
    membershipTable,
    apply,
  });
  return result.exitCode;
}

/**
 * Entry-point guard that works under BOTH module systems this script is
 * invoked with (see backfill-org-ids.ts for the full rationale):
 *   - ts-node / ts-jest (CommonJS): `require.main === module`.
 *   - Node native TypeScript execution (ESM): `require` is undefined.
 */
const isCjsEntrypoint =
  typeof require !== "undefined" && require.main === module;
const isEsmEntrypoint = typeof require === "undefined";

if (isCjsEntrypoint || isEsmEntrypoint) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      log("error", `Fatal: ${String(err)}`);
      process.exitCode = 1;
    });
}
