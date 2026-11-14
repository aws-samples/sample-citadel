/**
 * intake-resolver-index-grants.guard.test.ts
 *
 * Ensures the intake-orchestration resolver's IAM role in services-stack.ts
 * grants `dynamodb:Query` on every DynamoDB GSI its code (and transitively
 * imported modules) can query at runtime.
 *
 * The test statically scans TypeScript source to discover (table, IndexName)
 * pairs inside QueryCommand calls, then scans the services-stack.ts IAM
 * grants to verify each index ARN is covered. Purely source-based — no CDK
 * synth required.
 *
 * This prevents the class of bug where a new GSI query is added to the
 * resolver or an imported module but the IAM grant is not updated — the
 * test fails instead of production (AccessDeniedException).
 */
import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

const BACKEND_ROOT = path.resolve(__dirname, "../..");
const SRC_DIR = path.join(BACKEND_ROOT, "src");
const SERVICES_STACK = path.join(BACKEND_ROOT, "lib/services-stack.ts");

/**
 * Map from env-var name (or function name) used as TableName to the
 * deterministic table name suffix used in services-stack.ts grants.
 * The env pattern is `citadel-<suffix>-${props.environment}`.
 */
const TABLE_ENV_TO_SUFFIX: Record<string, string> = {
  WORKFLOWS_TABLE: "workflows",
  APPS_TABLE: "apps",
  AGENT_CONFIG_TABLE: "agents",
  PROJECTS_TABLE: "projects",
  CONVERSATIONS_TABLE: "conversations",
};

/** Maps function-call helpers to their env-var counterparts. */
const TABLE_FN_TO_ENV: Record<string, string> = {
  workflowsTable: "WORKFLOWS_TABLE",
  appsTable: "APPS_TABLE",
  projectsTable: "PROJECTS_TABLE",
  conversationsTable: "CONVERSATIONS_TABLE",
};

// ── Source scanning ───────────────────────────────────────────────────

interface IndexQuery {
  tableSuffix: string;
  indexName: string;
  sourceFile: string;
  line: number;
}

function collectLocalImports(filePath: string): string[] {
  const source = fs.readFileSync(filePath, "utf-8");
  const sf = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const imports: string[] = [];
  ts.forEachChild(sf, (node) => {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      if (specifier.startsWith(".")) {
        const dir = path.dirname(filePath);
        let resolved = path.resolve(dir, specifier);
        if (!resolved.endsWith(".ts")) resolved += ".ts";
        if (fs.existsSync(resolved)) {
          imports.push(resolved);
        }
      }
    }
  });
  return imports;
}

function transitiveImports(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if (!current.startsWith(SRC_DIR)) continue;
    try {
      for (const imp of collectLocalImports(current)) {
        if (!seen.has(imp)) queue.push(imp);
      }
    } catch {
      // File might not parse — skip.
    }
  }
  return [...seen];
}

function resolveTableSuffix(expr: ts.Expression): string | null {
  if (ts.isStringLiteral(expr)) {
    // Direct string like "citadel-workflows-test" → extract "workflows"
    const m = expr.text.match(/^citadel-(\w+)-/);
    return m ? m[1] : null;
  }
  if (ts.isIdentifier(expr)) {
    const env = TABLE_ENV_TO_SUFFIX[expr.text];
    return env ?? null;
  }
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    const env = TABLE_FN_TO_ENV[expr.expression.text];
    if (env) return TABLE_ENV_TO_SUFFIX[env] ?? null;
  }
  return null;
}

function extractIndexQueries(filePath: string): IndexQuery[] {
  const source = fs.readFileSync(filePath, "utf-8");
  const sf = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const results: IndexQuery[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "QueryCommand" &&
      node.arguments?.length === 1 &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const obj = node.arguments[0];
      let indexName: string | null = null;
      let tableSuffix: string | null = null;

      for (const prop of obj.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name))
          continue;
        if (
          prop.name.text === "IndexName" &&
          ts.isStringLiteral(prop.initializer)
        ) {
          indexName = prop.initializer.text;
        }
        if (prop.name.text === "TableName") {
          tableSuffix = resolveTableSuffix(prop.initializer);
        }
      }

      if (indexName && tableSuffix) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        results.push({
          tableSuffix,
          indexName,
          sourceFile: path.relative(BACKEND_ROOT, filePath),
          line: line + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sf);
  return results;
}

// ── Stack grant scanning ─────────────────────────────────────────────

/**
 * Scans services-stack.ts for index ARN patterns in the intake resolver's
 * grant block. Handles both literal index names and references via
 * exported constants.
 */
function extractGrantedIndexes(): Set<string> {
  const source = fs.readFileSync(SERVICES_STACK, "utf-8");
  const granted = new Set<string>();

  // Find the intake-resolver grant block
  const startIdx = source.indexOf("intakeOrchestrationResolverFn");
  const endIdx = source.indexOf("intakeOrchestrationDataSourceRole", startIdx);
  if (startIdx === -1 || endIdx === -1) return granted;

  const grantBlock = source.slice(startIdx, endIdx);

  // Split into lines for context-aware scanning
  const lines = grantBlock.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match lines containing /index/ — these are the grant resource ARNs
    if (!line.includes("/index/")) continue;

    // Extract the table suffix: look for citadel-<suffix> in the same line
    // or in nearby preceding lines (the tableArn call may be on the same line)
    const tableSuffix = extractTableSuffix(line, lines, i);
    if (!tableSuffix) continue;

    // Extract the index name: literal string or ${CONSTANT}
    const literalMatch = line.match(/\/index\/([A-Za-z][\w-]*)/);
    if (literalMatch && !literalMatch[1].startsWith("$")) {
      granted.add(`${tableSuffix}::${literalMatch[1]}`);
      continue;
    }

    const constMatch = line.match(/\/index\/\$\{(\w+)\}/);
    if (constMatch) {
      const resolved = resolveConstantToIndexName(constMatch[1]);
      if (resolved) {
        granted.add(`${tableSuffix}::${resolved}`);
      }
    }
  }

  return granted;
}

function extractTableSuffix(
  line: string,
  lines: string[],
  lineIdx: number,
): string | null {
  // Check the current line and up to 5 preceding lines for citadel-<suffix>
  for (let j = lineIdx; j >= Math.max(0, lineIdx - 5); j--) {
    const m = lines[j].match(/citadel-(\w+)-/);
    if (m) return m[1];
  }
  return null;
}

/**
 * Resolves a constant name to its index name value by scanning
 * backend-stack.ts for the export.
 */
function resolveConstantToIndexName(constName: string): string | null {
  // Well-known constants
  const known: Record<string, string> = {
    AGENTS_TABLE_GSI_NAME: "sourceProjectId-index",
    WORKFLOWS_TABLE_ORG_STATUS_INDEX: "OrgStatusIndex",
    WORKFLOWS_TABLE_BLUEPRINT_INDEX: "BlueprintIndex",
  };
  if (known[constName]) return known[constName];

  // Fall back to scanning backend-stack.ts
  const backendStack = path.join(BACKEND_ROOT, "lib/backend-stack.ts");
  if (!fs.existsSync(backendStack)) return null;
  const source = fs.readFileSync(backendStack, "utf-8");
  const pattern = new RegExp(
    `export\\s+const\\s+${constName}\\s*=\\s*["']([^"']+)["']`,
  );
  const match = source.match(pattern);
  return match ? match[1] : null;
}

// ── Tests ────────────────────────────────────────────────────────────

const INTAKE_ENTRY = path.join(
  SRC_DIR,
  "lambda/intake-orchestration-resolver.ts",
);

describe("intake-resolver-index-grants guard", () => {
  const allFiles = transitiveImports(INTAKE_ENTRY);
  const allIndexQueries: IndexQuery[] = [];
  for (const f of allFiles) {
    allIndexQueries.push(...extractIndexQueries(f));
  }

  // Deduplicate by (tableSuffix, indexName)
  const uniqueQueries = new Map<string, IndexQuery>();
  for (const q of allIndexQueries) {
    const key = `${q.tableSuffix}::${q.indexName}`;
    if (!uniqueQueries.has(key)) {
      uniqueQueries.set(key, q);
    }
  }

  it("discovers at least one GSI query in the intake resolver bundle", () => {
    expect(uniqueQueries.size).toBeGreaterThan(0);
    for (const [key, q] of uniqueQueries) {
      // eslint-disable-next-line no-console
      console.log(`  GSI query: ${key} (${q.sourceFile}:${q.line})`);
    }
  });

  it("every IndexName queried by the intake resolver bundle has a dynamodb:Query grant in services-stack.ts", () => {
    const granted = extractGrantedIndexes();

    const missing: string[] = [];
    for (const [key, q] of uniqueQueries) {
      if (!granted.has(key)) {
        missing.push(
          `citadel-${q.tableSuffix}-*/index/${q.indexName} (found at ${q.sourceFile}:${q.line})`,
        );
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `The intake-orchestration resolver queries the following GSIs but ` +
          `services-stack.ts does not grant dynamodb:Query on them:\n\n` +
          missing.map((m) => `  - ${m}`).join("\n") +
          `\n\nAdd a grant for each missing index in the ` +
          `intakeOrchestrationResolverFn policy block in backend/lib/services-stack.ts.`,
      );
    }
  });
});
