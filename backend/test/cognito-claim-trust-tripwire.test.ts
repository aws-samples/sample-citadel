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
});
