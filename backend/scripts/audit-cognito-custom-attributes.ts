/**
 * CIT-210: one-shot audit (and optional remediation) of the two legacy
 * Cognito custom attributes, `custom:role` and `custom:organization`.
 *
 * Why this exists (finding 7aa877f8): until commit 1c025bc the user pool
 * client had no WriteAttributes allow-list, so any authenticated user could
 * self-write `custom:role=admin` / an arbitrary `custom:organization` via
 * UpdateUserAttributes. Commit 39b2de8 made admin determination
 * group-authoritative (`cognito:groups` only) and the pre-token trigger now
 * drops an unearned `custom:role=admin` claim, so a poisoned attribute no
 * longer grants anything — but stale values are still sitting in the pool.
 * This script finds them and, on request, cleans them up.
 *
 * Model (decisions 228b3cc8 / 39b2de8):
 *   - Cognito GROUP membership is the sanctioned role carrier.
 *   - `custom:role` is display/legacy; it should mirror the user's group.
 *   - `custom:organization` holds the canonical organisation NAME (never an
 *     orgId) and must match a live `name` row in the organisations table.
 *
 * Findings:
 *   ROLE_MISMATCH  custom:role is set but the user is not in a group of the
 *                  same name (covers custom:role=admin without admin group).
 *   ORG_UNKNOWN    custom:organization is set but is not a valid org name.
 *   ORG_MISSING    user is in ≥1 group but has no custom:organization.
 *
 * Remediation (`--apply` only):
 *   ROLE_MISMATCH  exactly one group  → set custom:role to that group name
 *                  no groups          → delete custom:role
 *                  several groups     → NO write; listed for manual review
 *   ORG_UNKNOWN    delete custom:organization
 *   ORG_MISSING    NO write (the right org is unknowable); manual review
 *   Every modified user then gets AdminUserGlobalSignOut so their next
 *   login re-mints claims (mirrors assignUserRole in
 *   user-management-resolver.ts). Groups are NEVER added or removed.
 *
 * Usage:
 *   npm run audit:cognito-custom-attributes                  (dry-run)
 *   npm run audit:cognito-custom-attributes -- --dry-run     (same; explicit)
 *   npm run audit:cognito-custom-attributes -- --out audit.json
 *   npm run audit:cognito-custom-attributes -- --apply
 *   npm run audit:cognito-custom-attributes -- --json        (JSON on stdout)
 *
 *   --dry-run   explicit no-op alias for the default mode; mutually
 *               exclusive with --apply.
 *   --out FILE  write the JSON export to FILE. The file is written
 *               atomically and ONLY after the audit completed, so a failed
 *               run never leaves a 0-byte or partial export behind. Use this
 *               for the rollback record rather than `--json > FILE` (a shell
 *               redirect creates the file before the script runs).
 *   --json      print only the JSON document to stdout.
 *
 * Required env:
 *   USER_POOL_ID         – Cognito user pool id
 *   ORGANISATION_TABLE   – organisations DynamoDB table name
 *   AWS_REGION           – optional, defaults to us-west-2
 *
 * Exit codes:
 *   0  no findings (or, with --apply, every finding remediated cleanly)
 *   1  fatal error, or one or more remediation writes failed
 *   3  findings remain (dry-run always; apply when manual items remain)
 *
 * Output hygiene: only `username` and `sub` are ever printed or exported.
 * ListUsers is called WITHOUT AttributesToGet (Cognito rejects `custom:`
 * names there — finding c8ccaea5), so the full attribute record is returned
 * per page; the script immediately projects sub/custom:role/
 * custom:organization and discards everything else. Email and other PII
 * are never retained, logged, or written to the export.
 */
import {
  AdminDeleteUserAttributesCommand,
  AdminListGroupsForUserCommand,
  AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  type AttributeType,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  type NativeAttributeValue,
} from "@aws-sdk/lib-dynamodb";
import * as fs from "fs";

// ---------------------------------------------------------------------------
// Pure logic (exported for unit tests — no AWS involvement)
// ---------------------------------------------------------------------------

export type FindingKind = "ROLE_MISMATCH" | "ORG_UNKNOWN" | "ORG_MISSING";

export interface AuditUser {
  username: string;
  sub?: string;
  /** Cognito group names the user belongs to. */
  groups: string[];
  /** Value of `custom:role`, or null/undefined when absent. */
  role?: string | null;
  /** Value of `custom:organization`, or null/undefined when absent. */
  organization?: string | null;
}

export interface Finding {
  username: string;
  sub?: string;
  kind: FindingKind;
  detail: string;
  /** Stored values at audit time — the rollback record for `--json` exports. */
  previous: {
    role: string | null;
    organization: string | null;
    groups: string[];
  };
}

export type RemediationAction =
  | { type: "SET_ROLE"; username: string; value: string }
  | {
      type: "DELETE_ATTRIBUTE";
      username: string;
      attribute: "custom:role" | "custom:organization";
    }
  | { type: "GLOBAL_SIGN_OUT"; username: string };

export interface ManualReviewItem {
  username: string;
  sub?: string;
  kind: FindingKind;
  reason: string;
}

export interface RemediationPlan {
  actions: RemediationAction[];
  manual: ManualReviewItem[];
}

/**
 * Classifies one user against the trust model. Comparison of the org name
 * is EXACT (no trim / case-fold) — `createOrganization` stores names
 * verbatim and every tenancy comparison in this codebase is byte-exact
 * (decision 228b3cc8; see utils/org-name.ts).
 */
export function classifyUser(
  user: AuditUser,
  validOrgNames: ReadonlySet<string>,
): Finding[] {
  const findings: Finding[] = [];
  const role = user.role ?? "";
  const org = user.organization ?? "";
  const previous = {
    role: user.role ?? null,
    organization: user.organization ?? null,
    groups: [...user.groups],
  };

  if (role !== "" && !user.groups.includes(role)) {
    const detail =
      role === "admin"
        ? "custom:role=admin without admin group membership"
        : `custom:role=${role} but groups=[${user.groups.join(",")}]`;
    findings.push({
      username: user.username,
      sub: user.sub,
      kind: "ROLE_MISMATCH",
      previous,
      detail,
    });
  }

  if (org !== "" && !validOrgNames.has(org)) {
    findings.push({
      username: user.username,
      sub: user.sub,
      kind: "ORG_UNKNOWN",
      previous,
      detail: `custom:organization=${org} is not a live organisation name`,
    });
  }

  if (org === "" && user.groups.length > 0) {
    findings.push({
      username: user.username,
      sub: user.sub,
      kind: "ORG_MISSING",
      previous,
      detail: `in groups=[${user.groups.join(",")}] but no custom:organization`,
    });
  }

  return findings;
}

/**
 * Turns a user's findings into an ordered list of write actions. Attribute
 * writes come first; a single GLOBAL_SIGN_OUT is appended if (and only if)
 * at least one attribute write is planned. Findings the script cannot
 * safely fix are returned under `manual` and produce no action.
 */
export function planRemediation(
  user: AuditUser,
  findings: Finding[],
): RemediationPlan {
  const actions: RemediationAction[] = [];
  const manual: ManualReviewItem[] = [];

  for (const f of findings) {
    switch (f.kind) {
      case "ROLE_MISMATCH": {
        if (user.groups.length === 1) {
          actions.push({
            type: "SET_ROLE",
            username: user.username,
            value: user.groups[0],
          });
        } else if (user.groups.length === 0) {
          actions.push({
            type: "DELETE_ATTRIBUTE",
            username: user.username,
            attribute: "custom:role",
          });
        } else {
          manual.push({
            username: user.username,
            sub: user.sub,
            kind: f.kind,
            reason: `user is in ${user.groups.length} groups [${user.groups.join(",")}]; custom:role cannot be derived unambiguously`,
          });
        }
        break;
      }
      case "ORG_UNKNOWN":
        actions.push({
          type: "DELETE_ATTRIBUTE",
          username: user.username,
          attribute: "custom:organization",
        });
        break;
      case "ORG_MISSING":
        manual.push({
          username: user.username,
          sub: user.sub,
          kind: f.kind,
          reason:
            "no custom:organization; the correct organisation must be assigned by an admin via assignUserRole",
        });
        break;
    }
  }

  if (actions.length > 0) {
    actions.push({ type: "GLOBAL_SIGN_OUT", username: user.username });
  }

  return { actions, manual };
}

// ---------------------------------------------------------------------------
// Infrastructure helpers
// ---------------------------------------------------------------------------

/** Default pause between Cognito admin calls to stay under the TPS cap. */
const DEFAULT_COGNITO_SLEEP_MS = 50;

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
 * backfill-org-name-reservations.ts's scanOrganizationRows: a real org row
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

async function listGroups(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  username: string,
): Promise<string[]> {
  const groups: string[] = [];
  let nextToken: string | undefined;
  do {
    const page = await cognito.send(
      new AdminListGroupsForUserCommand({
        UserPoolId: userPoolId,
        Username: username,
        NextToken: nextToken,
      }),
    );
    for (const g of page.Groups ?? []) {
      if (g.GroupName) groups.push(g.GroupName);
    }
    nextToken = page.NextToken;
  } while (nextToken);
  return groups;
}

/** Streams every user in the pool as an AuditUser (groups resolved). */
async function* iterateUsers(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  sleepMs: number,
): AsyncGenerator<AuditUser> {
  let paginationToken: string | undefined;
  do {
    const page = await cognito.send(
      new ListUsersCommand({
        UserPoolId: userPoolId,
        // AttributesToGet is deliberately OMITTED. Cognito ListUsers only
        // accepts standard attribute names there; a `custom:` name makes the
        // whole call fail with InvalidParameterException ("Input fails to
        // satisfy the constraints") — finding c8ccaea5. Passing just ["sub"]
        // would silently drop the two custom attributes we are auditing. So
        // we take the full attribute list and project the three fields we
        // need right here; nothing else from the record is retained.
        PaginationToken: paginationToken,
      }),
    );
    for (const u of page.Users ?? []) {
      if (!u.Username) continue;
      await sleep(sleepMs);
      const groups = await listGroups(cognito, userPoolId, u.Username);
      yield {
        username: u.Username,
        sub: attr(u.Attributes, "sub") ?? undefined,
        groups,
        role: attr(u.Attributes, "custom:role"),
        organization: attr(u.Attributes, "custom:organization"),
      };
    }
    paginationToken = page.PaginationToken;
  } while (paginationToken);
}

async function executeAction(
  cognito: CognitoIdentityProviderClient,
  userPoolId: string,
  action: RemediationAction,
): Promise<void> {
  switch (action.type) {
    case "SET_ROLE":
      await cognito.send(
        new AdminUpdateUserAttributesCommand({
          UserPoolId: userPoolId,
          Username: action.username,
          UserAttributes: [{ Name: "custom:role", Value: action.value }],
        }),
      );
      return;
    case "DELETE_ATTRIBUTE":
      await cognito.send(
        new AdminDeleteUserAttributesCommand({
          UserPoolId: userPoolId,
          Username: action.username,
          UserAttributeNames: [action.attribute],
        }),
      );
      return;
    case "GLOBAL_SIGN_OUT":
      await cognito.send(
        new AdminUserGlobalSignOutCommand({
          UserPoolId: userPoolId,
          Username: action.username,
        }),
      );
      return;
  }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface AuditSummary {
  mode: "dry-run" | "apply";
  scanned: number;
  usersWithFindings: number;
  findings: Record<FindingKind, number>;
  plannedActions: number;
  appliedActions: number;
  modifiedUsers: number;
  manualReview: number;
  errors: number;
}

export interface AuditResult {
  exitCode: 0 | 1 | 3;
  summary: AuditSummary;
  findings: Finding[];
  manual: ManualReviewItem[];
  actions: RemediationAction[];
}

export interface RunAuditOptions {
  cognito: CognitoIdentityProviderClient;
  doc: DynamoDBDocumentClient;
  userPoolId: string;
  organisationTable: string;
  apply: boolean;
  /** Print ONLY the JSON document to stdout (for `--json > file`). */
  json?: boolean;
  /**
   * Write the JSON document to this path — but only once the audit has run
   * to completion, and atomically (temp file + rename). A run that throws
   * part-way leaves NO file behind, so an operator can never mistake an
   * empty/partial export for a rollback record. Prefer this over
   * `--json > file`: with a shell redirect the shell creates the file before
   * the script starts, so a failed run still leaves a 0-byte file.
   */
  out?: string;
  sleepMs?: number;
}

/**
 * Atomic write: the document is fully written to a sibling temp file and
 * then renamed over the target, so the target either does not exist or
 * holds the complete document. The temp file is removed on failure.
 */
export function writeExportAtomically(target: string, contents: string): void {
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, contents, { encoding: "utf8", flag: "wx" });
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (cleanupErr) {
      log("warn", `could not remove temp export ${tmp}: ${String(cleanupErr)}`);
    }
    throw err;
  }
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function printTable(findings: Finding[]): void {
  const rows = findings.map((f) => [
    f.kind,
    f.username,
    f.sub ?? "-",
    f.detail,
  ]);
  const header = ["FINDING", "USERNAME", "SUB", "DETAIL"];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const fmt = (r: string[]) => r.map((c, i) => pad(c, widths[i])).join("  ");
  // eslint-disable-next-line no-console
  console.log(fmt(header));
  // eslint-disable-next-line no-console
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) {
    // eslint-disable-next-line no-console
    console.log(fmt(r));
  }
}

export async function runAudit(opts: RunAuditOptions): Promise<AuditResult> {
  const {
    cognito,
    doc,
    userPoolId,
    organisationTable,
    apply,
    json = false,
    out,
  } = opts;
  const sleepMs = opts.sleepMs ?? DEFAULT_COGNITO_SLEEP_MS;
  const quiet = json;
  const info = (msg: string) => {
    if (!quiet) log("info", msg);
  };

  const summary: AuditSummary = {
    mode: apply ? "apply" : "dry-run",
    scanned: 0,
    usersWithFindings: 0,
    findings: { ROLE_MISMATCH: 0, ORG_UNKNOWN: 0, ORG_MISSING: 0 },
    plannedActions: 0,
    appliedActions: 0,
    modifiedUsers: 0,
    manualReview: 0,
    errors: 0,
  };
  const allFindings: Finding[] = [];
  const allManual: ManualReviewItem[] = [];
  const allActions: RemediationAction[] = [];

  const validOrgNames = await loadValidOrgNames(doc, organisationTable);
  info(`loaded ${validOrgNames.size} live organisation name(s)`);

  for await (const user of iterateUsers(cognito, userPoolId, sleepMs)) {
    summary.scanned++;
    const findings = classifyUser(user, validOrgNames);
    if (findings.length === 0) continue;

    summary.usersWithFindings++;
    for (const f of findings) summary.findings[f.kind]++;
    allFindings.push(...findings);

    const plan = planRemediation(user, findings);
    summary.plannedActions += plan.actions.length;
    summary.manualReview += plan.manual.length;
    allManual.push(...plan.manual);
    allActions.push(...plan.actions);

    if (!apply || plan.actions.length === 0) continue;

    // Attribute writes first; sign-out last and ONLY if every write for
    // this user succeeded (a half-applied user is reported as an error and
    // left signed in so the operator can re-run after fixing the cause).
    let failed = false;
    for (const action of plan.actions) {
      if (action.type === "GLOBAL_SIGN_OUT" && failed) break;
      try {
        await sleep(sleepMs);
        await executeAction(cognito, userPoolId, action);
        summary.appliedActions++;
        info(`applied ${action.type} for username=${user.username}`);
      } catch (err) {
        failed = true;
        summary.errors++;
        if (!quiet) {
          log(
            "error",
            `username=${user.username} ${action.type} failed: ${String(err)}`,
          );
        }
      }
    }
    if (!failed) summary.modifiedUsers++;
  }

  const remaining = apply
    ? summary.manualReview + summary.errors
    : allFindings.length;
  let exitCode: 0 | 1 | 3 = 0;
  if (summary.errors > 0) exitCode = 1;
  else if (remaining > 0) exitCode = 3;

  const document = {
    summary,
    findings: allFindings,
    manual: allManual,
    actions: allActions,
  };
  const serialized = JSON.stringify(document, null, 2);

  // Only reached when the audit ran to completion: the export is written
  // before any console output so a later stdout failure cannot lose it.
  if (out) {
    writeExportAtomically(out, serialized);
    info(`wrote export to ${out}`);
  }

  if (json) {
    // eslint-disable-next-line no-console
    console.log(serialized);
  } else {
    if (allFindings.length > 0) {
      printTable(allFindings);
    } else {
      info("no findings");
    }
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ summary, manual: allManual }, null, 2));
  }

  return { exitCode, ...document };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface CliFlags {
  apply: boolean;
  json: boolean;
  out?: string;
}

/**
 * Parses CLI flags. `--dry-run` is accepted as an explicit no-op alias for
 * the default mode so the invocation shape matches the sibling backfill
 * scripts; combining it with `--apply` is a contradiction and is rejected
 * rather than resolved by precedence.
 */
export function parseFlags(argv: string[]): CliFlags {
  const apply = argv.includes("--apply");
  const dryRun = argv.includes("--dry-run");
  const json = argv.includes("--json");
  if (apply && dryRun) {
    throw new Error("--dry-run and --apply are mutually exclusive");
  }
  let out: string | undefined;
  const outIdx = argv.indexOf("--out");
  if (outIdx !== -1) {
    const value = argv[outIdx + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("--out requires a file path argument");
    }
    out = value;
  }
  return { apply, json, out };
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<number> {
  const { apply, json, out } = parseFlags(argv);

  const userPoolId = process.env.USER_POOL_ID;
  const organisationTable = process.env.ORGANISATION_TABLE;
  const region = process.env.AWS_REGION || "us-west-2";

  if (!userPoolId) throw new Error("USER_POOL_ID env var required");
  if (!organisationTable)
    throw new Error("ORGANISATION_TABLE env var required");

  if (!json) {
    log("info", `Mode: ${apply ? "APPLY" : "DRY-RUN"}`);
    log(
      "info",
      `USER_POOL_ID=${userPoolId} ORGANISATION_TABLE=${organisationTable} REGION=${region}${out ? ` OUT=${out}` : ""}`,
    );
  }

  const cognito = new CognitoIdentityProviderClient({ region });
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

  const result = await runAudit({
    cognito,
    doc,
    userPoolId,
    organisationTable,
    apply,
    json,
    out,
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
