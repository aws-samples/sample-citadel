/**
 * TRIPWIRE — pins "the `custom:role` Cognito claim/attribute is never an
 * authorization signal".
 *
 * WHY THIS EXISTS (finding 7aa877f8, escalation 2026-09-30)
 * `custom:role` is a Cognito custom attribute. Before the user pool client
 * declared an explicit WriteAttributes allow-list (pinned separately in
 * backend/test/backend-stack-user-pool-client-write-attributes.test.ts —
 * cross-referenced, not duplicated here), Cognito's permissive default let
 * ANY authenticated end user call UpdateUserAttributes on their own account
 * and self-grant `custom:role=admin`. Finding 7aa877f8 made the ADMIN
 * derivation group-only. The 2026-09-30 escalation (CIT-213) found that
 * non-admin roles (`architect`, `project_manager`, `developer`) still
 * trusted the claim — `deriveRoles`, `hasRoleFromEvent` (Path 1),
 * `createAuthContext`, `validateCognitoToken` and the pre-token-generation
 * trigger all read it — so a user who could write the attribute could grant
 * themselves `architect` (spec:approve, release:promote, tool:execute, ...).
 *
 * The WriteAttributes allow-list closes the write side. This tripwire closes
 * the READ side, defence in depth: even if the allow-list regresses, or an
 * operator sets the attribute by hand, or a future pool client is added
 * without one, nothing in production code may DECIDE anything from
 * `custom:role`. `cognito:groups` is the sole authorization signal for every
 * role, because group membership can only be changed server-side via the
 * Admin* Cognito API.
 *
 * WHAT TO DO WHEN THIS TEST FAILS
 * Do NOT simply update the pinned expectations. A new read of `custom:role`
 * in production code has appeared. First:
 *   (a) delete the read and derive the role from `cognito:groups` instead —
 *       use the shared helpers in backend/src/utils/auth-event.ts
 *       (`readGroups`, `deriveRoles`, `hasRoleFromEvent`, `isAdminFromEvent`)
 *       or, for HTTP-API handlers, backend/src/lambda/utils/auth-http-event.ts;
 *   (b) if the value is genuinely needed for DISPLAY only, read it in the
 *       frontend from the ID token, never in a Lambda that also authorizes;
 *   (c) if you believe a new WRITE of the claim is needed, it belongs in
 *       pre-token-generation.ts, derived from `groupsToOverride`, and the
 *       allow-list count below (exactly ONE write site) must be justified
 *       in a code review before it is changed.
 *
 * WHAT IS PINNED
 *   T1. Static scan (TypeScript AST, so comments and docstrings are ignored
 *       and formatting/quoting is irrelevant) of every production `.ts`
 *       under backend/src (excluding `__tests__`): every string literal
 *       `"custom:role"` must be one of
 *         - a TYPE DECLARATION property (`"custom:role"?: string` /
 *           `["custom:role"]?: string` inside an interface or type literal
 *           — a shape description, not a read), or
 *         - the single claim WRITE in pre-token-generation.ts
 *           (`claimsToAddOrOverride["custom:role"] = <group-derived>`).
 *       Anything else — an element access, a comparison, a `readClaim(...)`
 *       argument, an object-literal key, a destructuring — is a read for a
 *       decision and fires.
 *   T2. pre-token-generation.ts contains no `userAttributes["custom:role"]`
 *       (the trigger never consults the stored attribute).
 *   T3. auth-event.ts contains no `readClaim(event, "custom:role")` (the
 *       shared helper never reads the claim).
 *   T4. Negative self-test: the scanner used for T1 DOES flag fixture code
 *       that reads the claim, so a silent scanner regression cannot turn
 *       this file into a no-op.
 *
 * `custom:organization` (decision 00d40a31, option A, 2026-09-30). The org
 * claim is minted by pre-token-generation.ts from the UserOrgMembership
 * DynamoDB table (GetItem by Cognito `sub`) and read back by
 * auth-event.ts's `extractOrgFromEvent` from the JWT ONLY. The stored
 * `custom:organization` user-pool attribute is a display/back-compat mirror
 * written by `assignUserRole`; it is never an authorization input.
 *   T5. pre-token-generation.ts contains no
 *       `userAttributes["custom:organization"]` expression (the trigger
 *       never consults the stored attribute — not even as a fallback when
 *       the membership lookup fails; that path fails closed).
 *   T6. The body of `function extractOrgFromEvent` in auth-event.ts contains
 *       no call to `lookupUserOrganization` (the former AdminGetUser
 *       fallback for a missing claim). Scoped to the function body by AST,
 *       so the remaining informational callers elsewhere are unaffected.
 *   T7. Negative self-test for T5/T6 against fixtures that WOULD violate.
 *   T8. pre-token-generation.ts WRITES `claimsToSuppress` (AST: object
 *       property or assignment target). Omitting the org claim from
 *       claimsToAddOrOverride is not fail-closed on its own: the pool
 *       client's readAttributes includes `custom:organization`, so Cognito's
 *       default mapping would copy the stored attribute into the ID token as
 *       that claim. The three omission paths are pinned behaviourally in
 *       src/lambda/__tests__/pre-token-generation.test.ts.
 *   T9. Negative self-test for T8 (the historical un-suppressed handler shape
 *       is NOT detected; the fixed shapes are).
 *
 * WHAT THIS TRIPWIRE DOES **NOT** CATCH (known, accepted residual risk)
 *   - A read via a computed/concatenated key (`identity["custom:" + "role"]`)
 *     or through a variable holding the literal. The scan matches the
 *     literal string; obfuscation is a code-review concern.
 *   - Reads in the frontend, in Python (arbiter/), or in the CDK `lib/`.
 *   - Any NEW authorization signal that is also client-writable (a new
 *     custom attribute). single-global-admin-tier-tripwire.test.ts P5 pins
 *     the custom attribute set to {role, organization} and fires on that.
 */

import * as path from "path";
import * as fs from "fs";
import * as ts from "typescript";

const SRC_ROOT = path.resolve(__dirname, "../src");
const PRE_TOKEN_GENERATION = path.join(
  SRC_ROOT,
  "lambda",
  "pre-token-generation.ts",
);
const AUTH_EVENT = path.join(SRC_ROOT, "utils", "auth-event.ts");

const CLAIM = "custom:role";

/**
 * Throws a loud, self-explanatory failure. Jest's `expect` has no message
 * parameter; a future engineer hitting this must get the full story in the
 * failure output, not just a diff.
 */
function tripwire(condition: boolean, detail: string): void {
  if (!condition) {
    throw new Error(
      `TRIPWIRE FIRED — a production read of the client-writable \`custom:role\` claim/attribute ` +
        `has appeared (finding 7aa877f8, escalation 2026-09-30 / CIT-213).\n${detail}\n` +
        `\`cognito:groups\` is the SOLE authorization signal for every role. Derive roles via ` +
        `backend/src/utils/auth-event.ts (readGroups / deriveRoles / hasRoleFromEvent / isAdminFromEvent) ` +
        `or backend/src/lambda/utils/auth-http-event.ts. See the header comment of ` +
        `backend/test/cognito-claim-trust-tripwire.test.ts. Do NOT simply update the pinned expectations.`,
    );
  }
}

export interface ClaimOccurrence {
  file: string;
  line: number;
  kind: "type-declaration" | "claim-write" | "read";
  text: string;
}

function isStringLiteralLike(
  node: ts.Node,
): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/** `"custom:role"?: string` or `["custom:role"]?: string` inside an
 * interface / type literal — a shape description, never a read. */
function isTypeDeclarationProperty(literal: ts.Node): boolean {
  let nameNode: ts.Node = literal;
  let p: ts.Node = literal.parent;
  if (p && ts.isComputedPropertyName(p)) {
    nameNode = p;
    p = p.parent;
  }
  return !!p && ts.isPropertySignature(p) && p.name === nameNode;
}

/** `X["custom:role"] = <expr>` — an element access that is the LEFT side of
 * a plain assignment. */
function isClaimWrite(literal: ts.Node): boolean {
  const access = literal.parent;
  if (!access || !ts.isElementAccessExpression(access)) return false;
  if (access.argumentExpression !== literal) return false;
  const assignment = access.parent;
  return (
    !!assignment &&
    ts.isBinaryExpression(assignment) &&
    assignment.left === access &&
    assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
  );
}

/**
 * Classifies every `"custom:role"` string literal in a TypeScript source
 * text. Comments are invisible to the AST, so prose mentions never count.
 * Exported (via module scope) so T4 can self-test the classifier against a
 * fixture that WOULD violate.
 */
export function scanCustomRoleOccurrences(
  sourceText: string,
  fileName: string,
): ClaimOccurrence[] {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  const out: ClaimOccurrence[] = [];

  const visit = (node: ts.Node): void => {
    if (isStringLiteralLike(node) && node.text === CLAIM) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      const lineText = sourceText.split("\n")[line]?.trim() ?? "";
      let kind: ClaimOccurrence["kind"] = "read";
      if (isTypeDeclarationProperty(node)) kind = "type-declaration";
      else if (isClaimWrite(node)) kind = "claim-write";
      out.push({ file: fileName, line: line + 1, kind, text: lineText });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Text of every `X[...]` / `f(...)` expression node, whitespace-normalised,
 * for the T2/T3 exact-shape pins. */
export function expressionTexts(
  sourceText: string,
  fileName: string,
): string[] {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isElementAccessExpression(node) || ts.isCallExpression(node)) {
      out.push(node.getText(sf).replace(/\s+/g, ""));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// ————————————————————————————————————————————————————————————————————————
// `custom:organization` helpers (T5/T6/T7 — decision 00d40a31)
// ————————————————————————————————————————————————————————————————————————

/** Whitespace-normalised element-access text of the historical trigger
 * fallback: `userAttributes["custom:organization"]` (any quote style). */
const USER_ATTR_ORG_READ = /^userAttributes\[["'`]custom:organization["'`]\]$/;

function orgTripwire(condition: boolean, detail: string): void {
  if (!condition) {
    throw new Error(
      `TRIPWIRE FIRED — the \`custom:organization\` claim is no longer server-derived only ` +
        `(decision 00d40a31, option A, 2026-09-30).\n${detail}\n` +
        `The claim is minted by pre-token-generation.ts from the UserOrgMembership table (GetItem by sub) and ` +
        `read back by extractOrgFromEvent from the JWT ONLY. The stored user-pool attribute is display/back-compat ` +
        `and must never be consulted for authorization — not in the trigger, not as a fallback in auth-event.ts. ` +
        `See docs/ORG_SCOPING.md "Claim trust model". Do NOT simply update the pinned expectations.`,
    );
  }
}

/**
 * Collects the callee text of every call expression lexically inside the
 * top-level `function <name>(...)` declaration (direct or `await`ed — the
 * `await` is not part of the CallExpression node, so it is transparent
 * here). `found` is false when no such declaration exists, so a pin can
 * fail loudly instead of passing vacuously on an empty list.
 */
export function callsInsideFunction(
  sourceText: string,
  fileName: string,
  functionName: string,
): { found: boolean; callees: string[] } {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let target: ts.FunctionDeclaration | undefined;
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === functionName) {
      target = stmt;
      break;
    }
  }
  if (!target || !target.body) return { found: false, callees: [] };

  const callees: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      callees.push(node.expression.getText(sf).replace(/\s+/g, ""));
    }
    ts.forEachChild(node, visit);
  };
  visit(target.body);
  return { found: true, callees };
}

/**
 * True when the source WRITES `claimsToSuppress` — either as a property in
 * an object literal (`{ ..., claimsToSuppress }` / `claimsToSuppress: x`)
 * or as an assignment target (`x.claimsToSuppress = ...`). Comments are
 * invisible to the AST, so prose mentions never count. Used by T8: the
 * trigger must actively suppress `custom:organization` on its omission
 * paths, because the pool client's readAttributes would otherwise let the
 * stored attribute surface as that very claim in the ID token.
 */
export function writesClaimsToSuppress(
  sourceText: string,
  fileName: string,
): boolean {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      (ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "claimsToSuppress"
    ) {
      found = true;
      return;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === "claimsToSuppress"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

function listProductionSources(root: string): string[] {
  const files: string[] = [];
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
        files.push(full);
      }
    }
  };
  walk(root);
  return files.sort();
}

const rel = (p: string): string =>
  path.relative(path.resolve(__dirname, ".."), p);

describe("cognito claim-trust tripwire (finding 7aa877f8, escalation 2026-09-30)", () => {
  // ————————————————————————————————————————————————————————————————————
  // T1 — no production read of custom:role anywhere under backend/src
  // ————————————————————————————————————————————————————————————————————
  describe("T1 — every `custom:role` literal in production source is a type declaration or THE claim write", () => {
    const sources = listProductionSources(SRC_ROOT);
    const occurrences = sources.flatMap((file) =>
      scanCustomRoleOccurrences(fs.readFileSync(file, "utf8"), file),
    );

    test("sanity: the scan covered production source (auth-event.ts, auth.ts, pre-token-generation.ts present)", () => {
      expect(sources).toContain(AUTH_EVENT);
      expect(sources).toContain(PRE_TOKEN_GENERATION);
      expect(sources).toContain(path.join(SRC_ROOT, "utils", "auth.ts"));
      expect(sources.some((f) => f.includes("__tests__"))).toBe(false);
    });

    test("no `custom:role` literal is READ for a decision", () => {
      const reads = occurrences.filter((o) => o.kind === "read");
      tripwire(
        reads.length === 0,
        `Production read(s) of "custom:role":\n` +
          reads.map((r) => `  ${rel(r.file)}:${r.line}  ${r.text}`).join("\n"),
      );
    });

    test("exactly ONE claim write exists, and it is in pre-token-generation.ts", () => {
      const writes = occurrences.filter((o) => o.kind === "claim-write");
      tripwire(
        writes.length === 1 && writes[0].file === PRE_TOKEN_GENERATION,
        `Expected exactly one \`X["custom:role"] = ...\` write site, in ${rel(PRE_TOKEN_GENERATION)}; found:\n` +
          writes.map((w) => `  ${rel(w.file)}:${w.line}  ${w.text}`).join("\n"),
      );
    });

    test('type-declaration occurrences are shape descriptions only (`"custom:role"?: string`)', () => {
      const decls = occurrences.filter((o) => o.kind === "type-declaration");
      // Every allow-listed declaration must be an OPTIONAL string property —
      // a required or non-string typing would suggest code is about to rely
      // on the value.
      const suspicious = decls.filter(
        (d) => !/\[?"custom:role"\]?\?\s*:\s*string\b/.test(d.text),
      );
      tripwire(
        suspicious.length === 0,
        `Type declaration(s) of "custom:role" that are not \`"custom:role"?: string\`:\n` +
          suspicious
            .map((d) => `  ${rel(d.file)}:${d.line}  ${d.text}`)
            .join("\n"),
      );
    });
  });

  // ————————————————————————————————————————————————————————————————————
  // T2 / T3 — exact-shape pins on the two historical read sites
  // ————————————————————————————————————————————————————————————————————
  describe("T2/T3 — the two historical read sites stay deleted", () => {
    test('T2: pre-token-generation.ts never evaluates userAttributes["custom:role"]', () => {
      const texts = expressionTexts(
        fs.readFileSync(PRE_TOKEN_GENERATION, "utf8"),
        PRE_TOKEN_GENERATION,
      );
      const hits = texts.filter((t) =>
        /^userAttributes\[["'`]custom:role["'`]\]$/.test(t),
      );
      tripwire(
        hits.length === 0,
        `${rel(PRE_TOKEN_GENERATION)} reads the stored custom:role attribute (${hits.join(", ")}). ` +
          `The promoted claim must be derived from groupConfiguration.groupsToOverride only.`,
      );
    });

    test('T3: auth-event.ts never calls readClaim(event, "custom:role")', () => {
      const texts = expressionTexts(
        fs.readFileSync(AUTH_EVENT, "utf8"),
        AUTH_EVENT,
      );
      const hits = texts.filter((t) =>
        /^readClaim\([A-Za-z_$][\w$]*,["'`]custom:role["'`]\)$/.test(t),
      );
      tripwire(
        hits.length === 0,
        `${rel(AUTH_EVENT)} reads the custom:role claim (${hits.join(", ")}). ` +
          `Use readGroups(event) — cognito:groups is the sole role signal.`,
      );
    });
  });

  // ————————————————————————————————————————————————————————————————————
  // T4 — negative self-test: the scanner really does catch violations
  // ————————————————————————————————————————————————————————————————————
  describe("T4 — scanner self-test (a fixture that WOULD violate is detected)", () => {
    const FIXTURE = `
      // prose mention of custom:role in a comment must NOT count
      /* nor "custom:role" inside a block comment */
      interface Identity { "custom:role"?: string; claims?: { ["custom:role"]?: string } }
      function readClaim(e: unknown, n: string): unknown { return n; }
      export function bad1(identity: Record<string, unknown>) {
        return identity["custom:role"] === "architect";           // read (element access)
      }
      export function bad2(event: unknown) {
        return readClaim(event, "custom:role");                   // read (call argument)
      }
      export function bad3(attrs: Array<{ Name: string }>) {
        return attrs.find((a) => a.Name === "custom:role");       // read (comparison)
      }
      export function bad4(userAttributes: Record<string, string>) {
        const role = userAttributes["custom:role"];               // read (T2 shape)
        return role;
      }
      export function write(claims: Record<string, string>) {
        claims["custom:role"] = "admin";                          // the one allowed shape
      }
    `;

    const occurrences = scanCustomRoleOccurrences(FIXTURE, "fixture.ts");

    test("flags every read shape (element access, call argument, comparison)", () => {
      const reads = occurrences.filter((o) => o.kind === "read");
      expect(reads.map((r) => r.text)).toEqual([
        expect.stringContaining('identity["custom:role"] === "architect"'),
        expect.stringContaining('readClaim(event, "custom:role")'),
        expect.stringContaining('a.Name === "custom:role"'),
        expect.stringContaining('userAttributes["custom:role"]'),
      ]);
    });

    test("classifies the type declarations and the single write correctly, and ignores comments", () => {
      expect(
        occurrences.filter((o) => o.kind === "type-declaration").length,
      ).toBe(2);
      expect(occurrences.filter((o) => o.kind === "claim-write").length).toBe(
        1,
      );
      // 2 decls + 1 write + 4 reads; the two comment mentions are invisible.
      expect(occurrences.length).toBe(7);
    });

    test("T2/T3 expression matcher detects the exact historical shapes", () => {
      const texts = expressionTexts(FIXTURE, "fixture.ts");
      expect(
        texts.some((t) => /^userAttributes\[["'`]custom:role["'`]\]$/.test(t)),
      ).toBe(true);
      expect(
        texts.some((t) =>
          /^readClaim\([A-Za-z_$][\w$]*,["'`]custom:role["'`]\)$/.test(t),
        ),
      ).toBe(true);
    });
  });

  // ————————————————————————————————————————————————————————————————————
  // T5 / T6 — the `custom:organization` claim is server-derived only
  // ————————————————————————————————————————————————————————————————————
  describe("T5/T6 — custom:organization is minted from the membership table and read from the claim only (decision 00d40a31)", () => {
    test('T5: pre-token-generation.ts never evaluates userAttributes["custom:organization"]', () => {
      const texts = expressionTexts(
        fs.readFileSync(PRE_TOKEN_GENERATION, "utf8"),
        PRE_TOKEN_GENERATION,
      );
      const hits = texts.filter((t) => USER_ATTR_ORG_READ.test(t));
      orgTripwire(
        hits.length === 0,
        `${rel(PRE_TOKEN_GENERATION)} reads the stored custom:organization attribute (${hits.join(", ")}). ` +
          `The claim must be derived from the UserOrgMembership table (GetItem by sub) only — not from the attribute, not even as a fallback.`,
      );
    });

    test("T6: auth-event.ts extractOrgFromEvent never calls lookupUserOrganization (no Cognito-attribute fallback)", () => {
      const calls = callsInsideFunction(
        fs.readFileSync(AUTH_EVENT, "utf8"),
        AUTH_EVENT,
        "extractOrgFromEvent",
      );
      orgTripwire(
        calls.found,
        `${rel(AUTH_EVENT)} no longer declares \`function extractOrgFromEvent\` — this pin must be re-targeted, not deleted.`,
      );
      const hits = calls.callees.filter((c) => c === "lookupUserOrganization");
      orgTripwire(
        hits.length === 0,
        `${rel(AUTH_EVENT)} extractOrgFromEvent calls lookupUserOrganization (${hits.length}x). ` +
          `A caller with no claim must resolve to null (fail closed), never to the display-only attribute.`,
      );
    });
  });

  // ————————————————————————————————————————————————————————————————————
  // T7 — negative self-test for T5/T6: the matchers really do catch the
  //      historical shapes, so a silent matcher regression cannot turn the
  //      org pins into a no-op.
  // ————————————————————————————————————————————————————————————————————
  describe("T7 — org-claim matcher self-test (fixtures that WOULD violate are detected)", () => {
    const BAD_TRIGGER = `
      export const handler = async (event: { request: { userAttributes: Record<string, string> } }) => {
        const userAttributes = event.request.userAttributes || {};
        // the historical fallback shape:
        const org = row?.orgName ?? userAttributes["custom:organization"];
        return org;
      };
    `;
    const BAD_AUTH_EVENT = `
      async function lookupUserOrganization(u: string): Promise<string | null> { return u; }
      export async function extractOrgFromEvent(event: unknown): Promise<string | null> {
        const claimOrg = readClaim(event, "custom:organization");
        if (claimOrg) return claimOrg;
        const username = readClaim(event, "sub");
        return username ? await lookupUserOrganization(username) : null;  // the removed fallback
      }
      export async function unrelated(u: string) { return lookupUserOrganization(u); } // outside the function: ignored
    `;
    const GOOD_AUTH_EVENT = `
      export async function extractOrgFromEvent(event: unknown): Promise<string | null> {
        const claimOrg = readClaim(event, "custom:organization");
        return claimOrg ? claimOrg : null;
      }
      export async function other(u: string) { return lookupUserOrganization(u); }
    `;

    test('T5 matcher detects userAttributes["custom:organization"] (any quote style)', () => {
      const texts = expressionTexts(BAD_TRIGGER, "fixture.ts");
      expect(texts.some((t) => USER_ATTR_ORG_READ.test(t))).toBe(true);
      expect(
        USER_ATTR_ORG_READ.test("userAttributes['custom:organization']"),
      ).toBe(true);
      expect(
        USER_ATTR_ORG_READ.test("userAttributes[`custom:organization`]"),
      ).toBe(true);
      // near-miss: a different attribute must NOT match
      expect(USER_ATTR_ORG_READ.test('userAttributes["custom:role"]')).toBe(
        false,
      );
    });

    test("T6 matcher scopes to the extractOrgFromEvent body: flags the fallback call inside, ignores calls outside", () => {
      const bad = callsInsideFunction(
        BAD_AUTH_EVENT,
        "fixture.ts",
        "extractOrgFromEvent",
      );
      expect(bad.found).toBe(true);
      expect(
        bad.callees.filter((c) => c === "lookupUserOrganization"),
      ).toHaveLength(1);

      const good = callsInsideFunction(
        GOOD_AUTH_EVENT,
        "fixture.ts",
        "extractOrgFromEvent",
      );
      expect(good.found).toBe(true);
      expect(good.callees).not.toContain("lookupUserOrganization");
      expect(good.callees).toContain("readClaim");
    });

    test("T6 matcher reports found=false when the function is absent (so the pin fails loudly instead of passing vacuously)", () => {
      const missing = callsInsideFunction(
        "export const x = 1;",
        "fixture.ts",
        "extractOrgFromEvent",
      );
      expect(missing.found).toBe(false);
      expect(missing.callees).toEqual([]);
    });
  });

  // ————————————————————————————————————————————————————————————————————
  // T8 — omission is not enough: the trigger must SUPPRESS the org claim.
  //      Cognito's default ID-token mapping copies every client-readable
  //      attribute (readAttributes includes custom:organization) into the
  //      token, so an un-suppressed omission still lets the stored attribute
  //      surface as the claim extractOrgFromEvent reads.
  // ————————————————————————————————————————————————————————————————————
  describe("T8 — pre-token-generation.ts actively suppresses custom:organization on its omission paths", () => {
    test("T8: the trigger writes claimsToSuppress", () => {
      const src = fs.readFileSync(PRE_TOKEN_GENERATION, "utf8");
      orgTripwire(
        writesClaimsToSuppress(src, PRE_TOKEN_GENERATION),
        `${rel(PRE_TOKEN_GENERATION)} never writes \`claimsToSuppress\`. ` +
          `When no membership row resolves, the trigger must add "custom:organization" to ` +
          `response.claimsOverrideDetails.claimsToSuppress — omitting it from claimsToAddOrOverride is NOT fail-closed, ` +
          `because the pool client's readAttributes lets the stored attribute flow into the ID token as that claim. ` +
          `The behavioural contract (all three omission paths) is pinned in src/lambda/__tests__/pre-token-generation.test.ts.`,
      );
    });

    test("T8: the trigger still names the org claim literally (so the suppress can target it)", () => {
      const src = fs.readFileSync(PRE_TOKEN_GENERATION, "utf8");
      const sf = ts.createSourceFile(
        PRE_TOKEN_GENERATION,
        src,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      let literal = false;
      const visit = (node: ts.Node): void => {
        if (isStringLiteralLike(node) && node.text === "custom:organization")
          literal = true;
        ts.forEachChild(node, visit);
      };
      visit(sf);
      orgTripwire(
        literal,
        `${rel(PRE_TOKEN_GENERATION)} has no "custom:organization" string literal; the claim can be neither minted nor suppressed.`,
      );
    });
  });

  // ————————————————————————————————————————————————————————————————————
  // T9 — negative self-test for T8: the historical un-suppressed handler
  //      shape is detected as NOT writing claimsToSuppress; the fixed shapes
  //      (object-literal property, shorthand, assignment) are all detected.
  // ————————————————————————————————————————————————————————————————————
  describe("T9 — claimsToSuppress matcher self-test", () => {
    const UNSUPPRESSED_TRIGGER = `
      // claimsToSuppress mentioned only in a comment — must not count
      export const handler = async (event: any) => {
        const claimsToAddOrOverride: Record<string, string> = {};
        const org = await resolveOrgClaim(event.userName);
        if (org) claimsToAddOrOverride["custom:organization"] = org;
        event.response.claimsOverrideDetails = {
          ...(event.response.claimsOverrideDetails || {}),
          claimsToAddOrOverride,
        };
        return event;
      };
    `;
    const PROPERTY_SHAPE = `
      event.response.claimsOverrideDetails = {
        claimsToAddOrOverride,
        claimsToSuppress: ["custom:organization"],
      };
    `;
    const SHORTHAND_SHAPE = `
      const claimsToSuppress = ["custom:organization"];
      event.response.claimsOverrideDetails = { claimsToAddOrOverride, claimsToSuppress };
    `;
    const ASSIGNMENT_SHAPE = `
      event.response.claimsOverrideDetails.claimsToSuppress = ["custom:organization"];
    `;

    test("the historical un-suppressed handler is NOT detected as a suppress write (comment mentions ignored)", () => {
      expect(writesClaimsToSuppress(UNSUPPRESSED_TRIGGER, "fixture.ts")).toBe(
        false,
      );
    });

    test("object-literal property, shorthand property and property assignment shapes are all detected", () => {
      expect(writesClaimsToSuppress(PROPERTY_SHAPE, "fixture.ts")).toBe(true);
      expect(writesClaimsToSuppress(SHORTHAND_SHAPE, "fixture.ts")).toBe(true);
      expect(writesClaimsToSuppress(ASSIGNMENT_SHAPE, "fixture.ts")).toBe(true);
    });

    test("a near-miss property name does not match", () => {
      expect(
        writesClaimsToSuppress(
          "const x = { claimsToSuppressed: [] }; y.claimsToAddOrOverride = {};",
          "fixture.ts",
        ),
      ).toBe(false);
    });
  });
});
