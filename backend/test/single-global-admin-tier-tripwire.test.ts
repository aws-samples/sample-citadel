/**
 * TRIPWIRE — pins the "single GLOBAL admin tier" assumption.
 *
 * WHY THIS EXISTS (finding 59e5a79c + the promotion-policy cross-org
 * policy write): two accepted risks are safe ONLY while `admin` means
 * platform-wide admin, i.e. while there is exactly one, org-blind admin
 * tier:
 *
 *   1. `assignUserRole` / `removeUserRole` in
 *      backend/src/lambda/user-management-resolver.ts perform NO org
 *      confinement — an admin caller may mutate group membership (and
 *      `custom:organization`) of ANY user in ANY org, and may grant the
 *      `admin` group itself.
 *   2. `setPromotionPolicy(orgId, ...)` in
 *      backend/src/lambda/promotion-policy-resolver.ts writes a policy row
 *      for a CLIENT-SUPPLIED orgId behind a bare `requireAdmin` — no
 *      caller-org vs target-org check.
 *
 * Both are harmless today precisely because any admin is a platform admin.
 * The moment an ORG-SCOPED admin tier exists (a tenant-level admin who is
 * an admin only within their own org), both become cross-tenant
 * escalation paths: an org admin of tenant A could grant themselves roles
 * in tenant B, or overwrite tenant B's promotion policy. The same applies
 * to every org gate that grants admins a bypass (e.g. `assertRowOrg` in
 * backend/src/utils/auth-event.ts returns early for admins).
 *
 * Nothing in the codebase enforces the single-global-tier assumption, so
 * an org-scoped tier would silently inherit these bypasses. This test
 * makes the assumption explicit and FAILS LOUDLY when it breaks.
 *
 * WHAT TO DO WHEN THIS TEST FAILS
 * Do NOT simply update the pinned expectations. First close the two
 * accepted risks that the failing pin has just invalidated:
 *   (a) add target-org vs caller-org reconciliation to `assignUserRole`
 *       and `removeUserRole` (user-management-resolver.ts) — a non-global
 *       admin must not mutate users outside their own org, and must never
 *       grant a tier broader than their own;
 *   (b) add a caller-org check to `setPromotionPolicy`
 *       (promotion-policy-resolver.ts) — the client-supplied `orgId` must
 *       be reconciled against the caller's server-derived org unless the
 *       caller is a PLATFORM admin;
 *   (c) audit every admin bypass keyed on `isAdminFromEvent` /
 *       `roles.includes("admin")` (e.g. `assertRowOrg`) and decide per
 *       site whether the new org-scoped tier may use it.
 * Only then update the expectations here to describe the new tier model.
 *
 * WHAT IS PINNED, AND WHY THESE ARTEFACTS
 *   P1. The set of Cognito groups declared in the CDK (synthesized
 *       CloudFormation template, read from `cdk.out/citadel-backend-<env>
 *       .template.json` rather than instantiating BackendStack in-process
 *       — see the import block below for why — NOT source text, so it is
 *       resilient to renames of construct ids, formatting, refactors).
 *       Post finding 7aa877f8,
 *       admin authority IS membership in the Cognito group "admin", and
 *       `AdminAddUserToGroupCommand` can only add users to groups that
 *       exist — so the declared group set is the entire role-tier
 *       universe. An org-scoped admin group appearing here is the
 *       clearest possible signal. Exact set equality is asserted, so
 *       ADDING a group fires and RENAMING a group fires (intentional:
 *       renames must force re-evaluation, not silently satisfy the pin).
 *   P2. No runtime group provisioning: no production source references
 *       the Cognito `CreateGroupCommand` SDK symbol. Dynamically minting
 *       per-org groups (e.g. `admin-{orgId}`) is the one way to introduce
 *       org-scoped tiers WITHOUT touching the CDK group set; this scan is
 *       matching a precise SDK class name (the only programmatic
 *       group-creation path), not prose.
 *   P3. The admin derivation (backend/src/utils/auth-event.ts —
 *       the ONE shared derivation all resolvers delegate to post-PR-146)
 *       is org-blind and exact-match: exactly the flat group literal
 *       "admin" grants admin; org-qualified variants do not; the
 *       caller's `custom:organization` plays no part in the derivation.
 *       Asserted behaviourally, so it cannot be satisfied by renaming —
 *       loosening the match (prefix/suffix/case/qualified parsing) fires.
 *   P4. The role vocabulary of `hasPermission`
 *       (backend/src/utils/auth.ts) — extracted via TypeScript AST, not
 *       regex, so it survives formatting/comments: keys are exactly
 *       {project_manager, architect, developer}, all org-unqualified, and
 *       the flat "admin" role is a bypass for ALL permissions (the
 *       positive shape of "single global tier"). A new org-admin role key
 *       or a spread that hides one fires.
 *   P5. The user pool's custom attribute schema is exactly
 *       {role, organization} (synthesized template). An org-scoped tier
 *       modeled as a NEW attribute (e.g. `custom:org_role`,
 *       `custom:admin_orgs`) fires here.
 *
 * WHAT THIS TRIPWIRE DOES **NOT** CATCH (known, accepted residual risk)
 *   - Delegating the EXISTING global `admin` group to tenant staff (an
 *     operator adding a customer's employee to `admin`): identical
 *     cross-tenant risk, zero code change — invisible to any code-level
 *     tripwire. That is an operational/process control, not a test.
 *   - Out-of-band group creation (AWS console, CLI
 *     `cognito-idp create-group`) — no artefact in this repo changes.
 *   - An org-scoped authorization scheme built in a brand-new module that
 *     never touches the pinned artefacts (e.g. a separate DynamoDB-backed
 *     entitlement table consulted by new resolvers). P1–P5 cover the
 *     existing admin plumbing, not every conceivable future one.
 */

import * as path from "path";
import * as fs from "fs";
import * as ts from "typescript";
import { loadTemplate } from "../scripts/split-gates/template-utils";
import type { CfnResource } from "../scripts/split-gates/types";
import { guardCdkOutInCi } from "./helpers/cdk-out-guard";

import { isAdminFromEvent, deriveRoles } from "../src/utils/auth-event";
import { hasPermission, createAuthContext } from "../src/utils/auth";

// P1/P5 read the SYNTHESIZED backend template from cdk.out instead of
// instantiating BackendStack in-process (finding: CannotFindAsset in CI —
// BackendStack's SeedOrganizationsFunction resolves its Lambda asset via
// `path.join(__dirname, "../../src/lambda/seed-organizations")` relative to
// lib/backend-stack.ts, which only lands on `backend/src/lambda/...` when
// the process cwd is `backend/`; CI's jest cwd has no such guarantee and the
// asset staging step fails before synth ever reaches the Cognito
// resources). This mirrors the established approach in
// schema-resolver-parity-guard.test.ts / duplicate-alarm-name-guard.test.ts:
// read `cdk.out/citadel-backend-<env>.template.json`, produced by the
// Backend Build + Synth CI job and downloaded as an artifact before Backend
// Tests runs. `SPLIT_GATES_ENV` defaults to "dev" for local runs and is set
// to "test" in CI (ci.yml) to match how that artifact was synthesized.
//
// Env-agnosticism: verified by diffing a `citadel-backend-dev` and
// `citadel-backend-test` synth — the Cognito UserPoolGroup set and the user
// pool's custom attribute schema are byte-identical across environments (no
// account/region/env token ever appears in a GroupName or a Schema entry's
// Name), so no normalization is needed for P1/P5, unlike stateful resources
// such as S3 BucketName (see template-utils.ts's ENV_DERIVED_KEYS) which
// legitimately embed env/account/region and DO require it.
const ENV = process.env.SPLIT_GATES_ENV ?? "dev";
const BACKEND_TEMPLATE_PATH = path.resolve(
  __dirname,
  "..",
  "cdk.out",
  `citadel-backend-${ENV}.template.json`,
);
const backendTemplateExists = fs.existsSync(BACKEND_TEMPLATE_PATH);

/**
 * Throws a loud, self-explanatory failure. Jest's `expect` has no message
 * parameter; a future engineer hitting this must get the full story in the
 * failure output, not just a set diff.
 */
function tripwire(condition: boolean, detail: string): void {
  if (!condition) {
    throw new Error(
      `TRIPWIRE FIRED — single-global-admin assumption broken (finding 59e5a79c / promotion-policy cross-org write).\n` +
        `${detail}\n` +
        `An org-scoped or per-tenant admin tier appears to be introduced. The accepted risks this ` +
        `assumption protected are now live cross-tenant escalation paths. Before updating this test, ` +
        `you MUST: (1) add target-org vs caller-org reconciliation to assignUserRole/removeUserRole in ` +
        `backend/src/lambda/user-management-resolver.ts; (2) add a caller-org check to setPromotionPolicy ` +
        `in backend/src/lambda/promotion-policy-resolver.ts (it writes to a client-supplied orgId behind ` +
        `bare requireAdmin); (3) audit every isAdminFromEvent / roles.includes("admin") bypass of org ` +
        `gates (e.g. assertRowOrg in backend/src/utils/auth-event.ts). See the header comment of ` +
        `backend/test/single-global-admin-tier-tripwire.test.ts. Do NOT simply update the expected values.`,
    );
  }
}

/** The complete, pinned role-tier universe. Exactly one entry grants admin. */
const PINNED_GROUP_NAMES = [
  "admin",
  "architect",
  "developer",
  "project_manager",
];

/** Plausible spellings of an org-scoped/per-tenant admin variant. Used as a
 * behavioural battery against the derivation functions — none may be treated
 * as admin, and none may grant any mapped permission. */
const ORG_SCOPED_ADMIN_VARIANTS = [
  "org_admin",
  "org-admin",
  "orgAdmin",
  "tenant_admin",
  "tenant-admin",
  "admin:org-123",
  "org-123:admin",
  "admin-org-123",
  "org-123-admin",
  "admin/org-123",
  "admin_org123",
  "ADMIN", // case-loosening of the exact match would also break the pin
  "Admin",
];

/** Representative permissions spanning every mapped role plus admin-only
 * governance actions (admin reaches these only via the global bypass). */
const SAMPLE_PERMISSIONS = [
  "project:create",
  "project:read",
  "project:update",
  "adr:reopen",
  "spec:approve",
  "eval:approve",
  "release:promote",
  "tool:approve",
  "user:role:assign", // unmapped — admin-bypass-only territory
  "promotion-policy:write", // unmapped — admin-bypass-only territory
];

function eventWithGroups(
  groups: string[] | string,
  extra?: Record<string, unknown>,
) {
  return { identity: { "cognito:groups": groups, ...(extra || {}) } };
}

function eventWithClaimRole(role: string, extra?: Record<string, unknown>) {
  return { identity: { "custom:role": role, ...(extra || {}) } };
}

describe("single-global-admin tripwire (finding 59e5a79c)", () => {
  // ————————————————————————————————————————————————————————————————————
  // P1 + P5 — CDK: the Cognito group universe and custom attribute schema
  // ————————————————————————————————————————————————————————————————————
  describe("P1/P5 — CDK-declared Cognito role universe", () => {
    if (!backendTemplateExists) {
      guardCdkOutInCi(
        `citadel-backend-${ENV}.template.json`,
        `cd backend && npm run build:lambda && npx cdk synth citadel-backend-${ENV} --quiet`,
      );
      it.skip(`skipped: cdk.out/citadel-backend-${ENV}.template.json missing (run cdk synth first)`, () => {});
      return;
    }

    const template = loadTemplate(BACKEND_TEMPLATE_PATH);

    function resourcesOfType(type: string): Record<string, CfnResource> {
      const out: Record<string, CfnResource> = {};
      for (const [logicalId, res] of Object.entries(template.Resources)) {
        if (res.Type === type) out[logicalId] = res;
      }
      return out;
    }

    test("P1: declared Cognito groups are EXACTLY {admin, architect, developer, project_manager}", () => {
      const groups = resourcesOfType("AWS::Cognito::UserPoolGroup");
      const names = Object.values(groups)
        .map((g) => g.Properties?.GroupName as string)
        .sort();

      const added = names.filter((n) => !PINNED_GROUP_NAMES.includes(n));
      const removed = PINNED_GROUP_NAMES.filter((n) => !names.includes(n));

      tripwire(
        added.length === 0,
        `New Cognito group(s) declared in the CDK: ${JSON.stringify(added)}. ` +
          `The declared group set is the entire role-tier universe (admin is derived solely from ` +
          `membership in the group "admin", and AdminAddUserToGroup can only target existing groups). ` +
          `A new group — especially an org-qualified admin variant — means the tier model is changing.`,
      );
      tripwire(
        removed.length === 0,
        `Pinned Cognito group(s) disappeared or were renamed: ${JSON.stringify(removed)}. ` +
          `Renaming does not satisfy this pin by design — a rename of the admin tier must force ` +
          `re-evaluation of the org-confinement gaps listed in the header comment.`,
      );
      expect(names).toEqual(PINNED_GROUP_NAMES);
    });

    test("P1: exactly ONE group grants admin, and its name is the flat, org-unqualified literal 'admin'", () => {
      const groups = resourcesOfType("AWS::Cognito::UserPoolGroup");
      const names = Object.values(groups).map(
        (g) => g.Properties?.GroupName as string,
      );

      const adminLike = names.filter((n) => /admin/i.test(n));
      tripwire(
        adminLike.length === 1 && adminLike[0] === "admin",
        `Admin-like Cognito group names found: ${JSON.stringify(adminLike)} — expected exactly ` +
          `["admin"]. An org-qualified admin group (e.g. "org_admin", "admin:{orgId}") is the ` +
          `clearest signal that an org-scoped admin tier is being introduced.`,
      );
    });

    test("P5: user pool custom attributes are EXACTLY {role, organization} — no new org/tier dimension", () => {
      const pools = resourcesOfType("AWS::Cognito::UserPool");
      const ids = Object.keys(pools);
      expect(ids.length).toBe(1);

      type SchemaEntry = { Name: string; AttributeDataType?: string };
      const schema: SchemaEntry[] =
        (pools[ids[0]].Properties?.Schema as SchemaEntry[]) || [];
      // Custom attributes are the schema entries that are not standard
      // Cognito attribute names (standard ones: email, given_name, ...).
      const STANDARD = new Set([
        "address",
        "birthdate",
        "email",
        "family_name",
        "gender",
        "given_name",
        "locale",
        "middle_name",
        "name",
        "nickname",
        "phone_number",
        "picture",
        "preferred_username",
        "profile",
        "updated_at",
        "website",
        "zoneinfo",
        "sub",
      ]);
      const customNames = schema
        .map((s) => s.Name)
        .filter((n) => !STANDARD.has(n))
        .sort();

      tripwire(
        JSON.stringify(customNames) ===
          JSON.stringify(["organization", "role"]),
        `User pool custom attributes changed: ${JSON.stringify(customNames)} — expected exactly ` +
          `["organization","role"]. A new custom attribute (e.g. "org_role", "admin_orgs") is the ` +
          `attribute-shaped way an org-scoped admin tier could be smuggled in. NOTE: per finding ` +
          `7aa877f8, custom attributes are client-writable and must NEVER carry authorization anyway.`,
      );
    });
  });

  // ————————————————————————————————————————————————————————————————————
  // P2 — no runtime group provisioning anywhere in production source
  // ————————————————————————————————————————————————————————————————————
  describe("P2 — no dynamic Cognito group creation in production code", () => {
    test("no production source references CreateGroupCommand (per-org groups cannot be minted at runtime)", () => {
      const roots = [
        path.resolve(__dirname, "../src"),
        path.resolve(__dirname, "../lib"),
      ];
      const offenders: string[] = [];

      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (
              entry.name === "node_modules" ||
              entry.name === "__tests__" ||
              entry.name === "dist" ||
              entry.name === "cdk.out"
            ) {
              continue;
            }
            walk(full);
          } else if (
            entry.isFile() &&
            entry.name.endsWith(".ts") &&
            !entry.name.endsWith(".d.ts") &&
            !entry.name.endsWith(".test.ts") &&
            !entry.name.endsWith(".spec.ts")
          ) {
            const content = fs.readFileSync(full, "utf8");
            if (/\bCreateGroupCommand\b/.test(content)) {
              offenders.push(
                path.relative(path.resolve(__dirname, ".."), full),
              );
            }
          }
        }
      };
      roots.forEach(walk);

      tripwire(
        offenders.length === 0,
        `Production source now references the Cognito CreateGroupCommand SDK symbol: ` +
          `${JSON.stringify(offenders)}. Runtime group creation is the way per-org admin groups ` +
          `(e.g. "admin-{orgId}") appear WITHOUT changing the CDK-declared group set — the P1 pin ` +
          `cannot see it, which is exactly why this scan exists.`,
      );
    });
  });

  // ————————————————————————————————————————————————————————————————————
  // P3 — the shared admin derivation is org-blind and exact-match
  // ————————————————————————————————————————————————————————————————————
  describe("P3 — admin derivation (auth-event.ts) is exact-match on the flat 'admin' group and org-blind", () => {
    test("exact group 'admin' IS admin, in both array and comma-separated claim shapes", () => {
      expect(isAdminFromEvent(eventWithGroups(["admin"]))).toBe(true);
      expect(isAdminFromEvent(eventWithGroups("developer, admin"))).toBe(true);
      expect(
        isAdminFromEvent({
          identity: { claims: { "cognito:groups": ["admin"] } },
        }),
      ).toBe(true);
    });

    test("the caller's custom:organization plays NO part in the admin derivation (admin is global, not org-relative)", () => {
      // Admin with an org attribute is still admin — no org confinement
      // exists in the derivation. This is the CURRENT (accepted-risk) shape.
      expect(
        isAdminFromEvent(
          eventWithGroups(["admin"], { "custom:organization": "org-1" }),
        ),
      ).toBe(true);
      // An org attribute alone (or with a forged custom:role) grants nothing.
      expect(
        isAdminFromEvent(
          eventWithClaimRole("admin", { "custom:organization": "org-1" }),
        ),
      ).toBe(false);
    });

    test.each(ORG_SCOPED_ADMIN_VARIANTS)(
      "org-scoped admin variant %j in cognito:groups is NOT admin and derives no admin role",
      (variant) => {
        tripwire(
          isAdminFromEvent(eventWithGroups([variant])) === false,
          `isAdminFromEvent now treats the group ${JSON.stringify(variant)} as admin. The derivation ` +
            `was exact-match on the single flat literal "admin"; recognising an org-qualified or ` +
            `loosened variant means an org-scoped admin tier now exists.`,
        );
        tripwire(
          isAdminFromEvent(eventWithGroups(`developer, ${variant}`)) === false,
          `isAdminFromEvent (comma-separated shape) now treats ${JSON.stringify(variant)} as admin.`,
        );
        tripwire(
          !deriveRoles(eventWithGroups([variant])).includes("admin"),
          `deriveRoles now folds the group ${JSON.stringify(variant)} into the 'admin' role.`,
        );
      },
    );

    test.each(ORG_SCOPED_ADMIN_VARIANTS)(
      "org-qualified custom:role claim %j derives no admin and grants ZERO mapped permissions",
      (variant) => {
        const roles = deriveRoles(eventWithClaimRole(variant));
        tripwire(
          !roles.includes("admin"),
          `deriveRoles now maps custom:role=${JSON.stringify(variant)} to 'admin'.`,
        );
        const ctx = createAuthContext(eventWithClaimRole(variant));
        for (const permission of SAMPLE_PERMISSIONS) {
          tripwire(
            hasPermission(ctx, permission) === false,
            `hasPermission grants ${JSON.stringify(permission)} to role ${JSON.stringify(variant)}. ` +
              `An org-qualified role string entering the permission map means the role vocabulary ` +
              `has grown an org dimension.`,
          );
        }
      },
    );

    test("the flat 'admin' role bypasses ALL permissions — the positive shape of the single global tier", () => {
      const ctx = { userId: "u-1", groups: ["admin"], roles: ["admin"] };
      for (const permission of SAMPLE_PERMISSIONS) {
        expect(hasPermission(ctx, permission)).toBe(true);
      }
    });
  });

  // ————————————————————————————————————————————————————————————————————
  // P4 — the hasPermission role vocabulary (TypeScript AST, not regex)
  // ————————————————————————————————————————————————————————————————————
  describe("P4 — hasPermission role vocabulary (auth.ts, extracted via AST)", () => {
    test("rolePermissions keys are EXACTLY {architect, developer, project_manager}, statically enumerable, org-unqualified", () => {
      const authPath = path.resolve(__dirname, "../src/utils/auth.ts");
      const source = fs.readFileSync(authPath, "utf8");
      const sf = ts.createSourceFile(
        "auth.ts",
        source,
        ts.ScriptTarget.Latest,
        true,
      );

      let found = false;
      let keys: string[] = [];
      let allStatic = true;

      const visit = (node: ts.Node): void => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === "rolePermissions" &&
          node.initializer &&
          ts.isObjectLiteralExpression(node.initializer)
        ) {
          found = true;
          for (const prop of node.initializer.properties) {
            if (ts.isPropertyAssignment(prop)) {
              const n = prop.name;
              if (ts.isIdentifier(n) || ts.isStringLiteral(n)) {
                keys.push(n.text);
              } else {
                allStatic = false; // computed property name — not enumerable
              }
            } else {
              allStatic = false; // spread / shorthand / method — could hide roles
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);

      tripwire(
        found,
        `The 'rolePermissions' object literal was not found in backend/src/utils/auth.ts. The role ` +
          `vocabulary has moved or been restructured — re-locate it, re-verify it carries no org ` +
          `dimension, and re-point this pin.`,
      );
      tripwire(
        allStatic,
        `rolePermissions in auth.ts now contains a spread, computed key, or non-literal member — ` +
          `the role vocabulary is no longer statically enumerable, so an org-scoped role could hide ` +
          `inside it.`,
      );

      keys = keys.sort();
      const expected = ["architect", "developer", "project_manager"];
      const added = keys.filter((k) => !expected.includes(k));
      tripwire(
        added.length === 0,
        `New role key(s) in hasPermission's rolePermissions map: ${JSON.stringify(added)}. A new ` +
          `role — especially an admin-like or org-qualified one — changes the tier model that the ` +
          `two accepted risks depend on.`,
      );
      expect(keys).toEqual(expected);

      for (const k of keys) {
        tripwire(
          !/admin/i.test(k) && !/[:/\\]/.test(k),
          `Role key ${JSON.stringify(k)} looks admin-like or org-qualified.`,
        );
      }
    });
  });
});
