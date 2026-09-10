/**
 * org-name-canonical-guard.test.ts — guards for the RATIFIED decision
 * 228b3cc8: the organisation NAME is canonical for the `custom:organization`
 * claim and every tenancy comparison in this codebase. Names are treated as
 * IMMUTABLE — no rename operation exists, and the whole model (uniqueness
 * reservation, tombstone-on-delete, claim comparisons) rests on that
 * invariant holding forever, not merely by today's convention.
 *
 * Three guards, per decision piece 4:
 *
 *   (a) No `updateOrganization` (or equivalent rename) mutation is declared
 *       in the GraphQL schema's Mutation type, AND the organization-resolver
 *       Lambda's dispatch switch has no case that mutates an existing org's
 *       `name` field. The dispatch-switch check is AST-based (TypeScript
 *       compiler), per the repo convention established in
 *       app-access-control-dead-code-guard.test.ts and the
 *       *-dispatch-gate-enumeration.test.ts family — a regex over the
 *       resolver source could be defeated by reformatting or a case whose
 *       label doesn't literally contain the word "update"/"rename". The
 *       schema.graphql check is a structural SDL field-name extraction
 *       (every field declared inside the primary `type Mutation { ... }`
 *       block, derived by tokenizing each line's leading identifier before
 *       `(` — not a substring search for one literal name), because SDL is
 *       not TypeScript source and has no compiler AST to parse; the
 *       extraction still enumerates the FULL field set exhaustively rather
 *       than testing for the absence of one hard-coded string.
 *
 *   (b) The seeded admin user's `custom:organization` Cognito attribute
 *       value (seed-admin-user/index.py) equals the seeded organisation's
 *       NAME (seed-organizations/index.py) — both currently hard-coded to
 *       "Default". If either seed script's literal value drifts, this test
 *       fails loudly instead of leaving a seeded admin whose claim doesn't
 *       resolve to any real organisation.
 *
 *   (c) The canonical rule is documented in the shared auth helper
 *       (utils/auth-event.ts) so the next reader sees it before reaching
 *       for an orgId comparison. Checked via AST: a comment attached
 *       anywhere in auth-event.ts must mention "custom:organization", the
 *       word "NAME", and "canonical" together — pinning the check to the
 *       specific rule rather than any incidental mention of one term alone.
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SCHEMA_PATH = path.join(REPO_ROOT, "src", "schema", "schema.graphql");
const RESOLVER_PATH = path.join(__dirname, "..", "organization-resolver.ts");
const AUTH_EVENT_PATH = path.join(REPO_ROOT, "src", "utils", "auth-event.ts");
const SEED_ADMIN_PATH = path.join(
  REPO_ROOT,
  "src",
  "lambda",
  "seed-admin-user",
  "index.py",
);
const SEED_ORGS_PATH = path.join(
  REPO_ROOT,
  "src",
  "lambda",
  "seed-organizations",
  "index.py",
);

function parseSourceFile(filePath: string): ts.SourceFile {
  const text = fs.readFileSync(filePath, "utf-8");
  return ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
}

/**
 * Extracts every field name declared directly inside the PRIMARY
 * `type Mutation { ... }` SDL block (from `type Mutation {` to the first
 * line-anchored closing brace), by tokenizing each non-comment line's
 * leading identifier that is immediately followed by `(` or `:` — the two
 * shapes a GraphQL field declaration can take. This enumerates the FULL
 * mutation field set rather than testing for the presence/absence of one
 * hard-coded name.
 */
function extractMutationFieldNames(schema: string): string[] {
  const match = schema.match(/^type Mutation \{[\s\S]*?^\}/m);
  if (!match) {
    throw new Error(
      "Could not locate the primary `type Mutation { ... }` block in schema.graphql",
    );
  }
  const block = match[0];
  const lines = block.split("\n").slice(1, -1); // drop `type Mutation {` and closing `}`
  const names: string[] = [];
  const fieldRe = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[:(]/;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const m = fieldRe.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * Extracts the case labels of the `switch (fieldName)` dispatch in
 * organization-resolver.ts via the TypeScript AST (SwitchStatement ->
 * CaseClause -> StringLiteral), NOT a regex over source text.
 */
function extractDispatchCaseLabels(sf: ts.SourceFile): string[] {
  const labels: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isSwitchStatement(node)) {
      for (const clause of node.caseBlock.clauses) {
        if (
          ts.isCaseClause(clause) &&
          ts.isStringLiteralLike(clause.expression)
        ) {
          labels.push(clause.expression.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return labels;
}

/**
 * True if any AST node in `sf` is a call/new-expression whose callee name
 * matches /update|rename/i AND whose argument list contains an
 * UpdateExpression string literal that both SETs and mentions `name` — the
 * structural shape of a rename operation. Detected via AST traversal
 * (CallExpression/NewExpression -> ObjectLiteralExpression ->
 * PropertyAssignment), not a source-text regex search.
 */
function findRenameShapedOperations(sf: ts.SourceFile): ts.Node[] {
  const hits: ts.Node[] = [];

  function callableName(expr: ts.LeftHandSideExpression): string | null {
    if (ts.isIdentifier(expr)) return expr.text;
    if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
    return null;
  }

  function objectLiteralMentionsNameUpdate(node: ts.Node): boolean {
    let found = false;
    function inner(n: ts.Node): void {
      if (
        ts.isPropertyAssignment(n) &&
        ts.isIdentifier(n.name) &&
        n.name.text === "UpdateExpression" &&
        ts.isStringLiteralLike(n.initializer) &&
        /\bname\b/i.test(n.initializer.text) &&
        /\bSET\b/i.test(n.initializer.text)
      ) {
        found = true;
      }
      ts.forEachChild(n, inner);
    }
    inner(node);
    return found;
  }

  function visit(node: ts.Node): void {
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      node.arguments
    ) {
      const name = callableName(node.expression as ts.LeftHandSideExpression);
      if (name && /update|rename/i.test(name)) {
        for (const arg of node.arguments) {
          if (objectLiteralMentionsNameUpdate(arg)) {
            hits.push(node);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return hits;
}

describe("org-name-canonical guard (decision 228b3cc8, piece 4)", () => {
  describe("(a) no rename/update operation for organisations exists", () => {
    test("schema.graphql's primary Mutation block declares no updateOrganization/renameOrganization field", () => {
      const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");
      const fields = extractMutationFieldNames(schema);
      expect(fields.length).toBeGreaterThan(0); // sanity: parser found real fields
      expect(fields).toContain("createOrganization");
      expect(fields).toContain("deleteOrganization");
      const renameShaped = fields.filter(
        (f) => /update|rename/i.test(f) && /organi[sz]ation/i.test(f),
      );
      expect(renameShaped).toEqual([]);
    });

    test("organization-resolver.ts's dispatch switch has no updateOrganization/renameOrganization case", () => {
      const sf = parseSourceFile(RESOLVER_PATH);
      const labels = extractDispatchCaseLabels(sf);
      expect(labels.length).toBeGreaterThan(0); // sanity
      expect(labels).toContain("createOrganization");
      expect(labels).toContain("deleteOrganization");
      const renameShaped = labels.filter((l) => /update|rename/i.test(l));
      expect(renameShaped).toEqual([]);
    });

    test("organization-resolver.ts contains no AST-detectable UpdateCommand/call that overwrites an org row's `name` field", () => {
      const sf = parseSourceFile(RESOLVER_PATH);
      // The tombstone UpdateCommand (piece 3) legitimately updates `itemType`
      // and `tombstonedAt` on the NAME# reservation row — it must NOT be
      // flagged, since it never touches a `name` attribute via SET.
      const hits = findRenameShapedOperations(sf);
      expect(hits).toEqual([]);
    });

    test("bites: a planted updateOrganization-shaped UpdateCommand IS flagged", () => {
      const scratch = ts.createSourceFile(
        "scratch.ts",
        [
          "async function updateOrganization(orgId: string, newName: string) {",
          "  return docClient.send(",
          "    new UpdateCommand({",
          "      TableName: T,",
          "      Key: { orgId },",
          "      UpdateExpression: 'SET #name = :name',",
          "      ExpressionAttributeValues: { ':name': newName },",
          "    }),",
          "  );",
          "}",
        ].join("\n"),
        ts.ScriptTarget.ESNext,
        true,
        ts.ScriptKind.TS,
      );
      expect(findRenameShapedOperations(scratch).length).toBeGreaterThan(0);
    });

    test("does NOT flag the legitimate tombstone UpdateCommand shape (updates itemType/tombstonedAt, not name)", () => {
      const scratch = ts.createSourceFile(
        "scratch.ts",
        [
          "async function tombstoneReservation(orgId: string) {",
          "  return docClient.send(",
          "    new UpdateCommand({",
          "      TableName: T,",
          "      Key: { orgId },",
          "      UpdateExpression: 'SET itemType = :tombstone, tombstonedAt = :t',",
          "      ExpressionAttributeValues: { ':tombstone': 'name_tombstone', ':t': 'now' },",
          "    }),",
          "  );",
          "}",
        ].join("\n"),
        ts.ScriptTarget.ESNext,
        true,
        ts.ScriptKind.TS,
      );
      expect(findRenameShapedOperations(scratch).length).toBe(0);
    });
  });

  describe("(b) seeded admin's claim equals the seeded organisation's NAME", () => {
    test("seed-admin-user/index.py's custom:organization literal matches a name literal seeded by seed-organizations/index.py", () => {
      const adminSeedSrc = fs.readFileSync(SEED_ADMIN_PATH, "utf-8");
      const orgsSeedSrc = fs.readFileSync(SEED_ORGS_PATH, "utf-8");

      const adminOrgMatch = adminSeedSrc.match(
        /\{'Name':\s*'custom:organization',\s*'Value':\s*'([^']+)'\}/,
      );
      expect(adminOrgMatch).not.toBeNull();
      const adminOrgClaim = adminOrgMatch![1];

      // Every 'name': '<value>' literal seeded into the organisations table.
      const seededNames = Array.from(
        orgsSeedSrc.matchAll(/'name':\s*'([^']+)'/g),
      ).map((m) => m[1]);
      expect(seededNames.length).toBeGreaterThan(0); // sanity

      expect(seededNames).toContain(adminOrgClaim);
    });
  });

  describe("(c) the canonical rule is documented in the shared auth helper", () => {
    test("auth-event.ts contains a comment documenting that custom:organization is the canonical NAME-based tenancy claim", () => {
      const sf = parseSourceFile(AUTH_EVENT_PATH);
      const fullText = sf.getFullText();

      // Collect every comment (JSDoc + line + block) via the AST's own
      // trivia scanner rather than a source-text regex sweep, then check
      // the comment TEXT content for the documenting phrase.
      const comments: string[] = [];
      const fullStart = sf.getFullStart();
      ts.forEachChild(sf, function visit(node: ts.Node) {
        ts.forEachLeadingCommentRange(
          fullText,
          node.getFullStart(),
          (pos, end) => {
            comments.push(fullText.slice(pos, end));
          },
        );
        ts.forEachChild(node, visit);
      });
      // Also scan file-leading comments (before the first statement), which
      // forEachLeadingCommentRange over child nodes can miss for a
      // top-of-file block comment preceding the first import.
      ts.forEachLeadingCommentRange(fullText, fullStart, (pos, end) => {
        comments.push(fullText.slice(pos, end));
      });

      const canonicalRuleDocumented = comments.some(
        (c) =>
          c.includes("custom:organization") &&
          /\bNAME\b/.test(c) &&
          /canonical/i.test(c),
      );
      expect(canonicalRuleDocumented).toBe(true);
    });
  });
});
