/**
 * Guard test: every GraphQL operation document (query, mutation, subscription)
 * in frontend/src must name a root field that actually exists in the matching
 * root type of the backend GraphQL schema.
 *
 * Catches dead operations at CI time instead of at runtime (AppSync
 * FieldUndefined errors in the browser console).
 *
 * CIT-278 — originally covered subscriptions only.
 * CIT-284 — extended to queries and mutations; deleteProject and
 * updateIntegrationStatus were the first two dead mutations caught.
 */
import * as fs from 'fs';
import * as path from 'path';

const FRONTEND_SRC = path.resolve(__dirname, '..', '..');
const SCHEMA_PATH = path.resolve(FRONTEND_SRC, '..', '..', 'backend', 'src', 'schema', 'schema.graphql');

type OperationKind = 'query' | 'mutation' | 'subscription';

const ROOT_TYPE_MAP: Record<OperationKind, string> = {
  query: 'Query',
  mutation: 'Mutation',
  subscription: 'Subscription',
};

/**
 * Extract the body of a top-level `type Foo { ... }` block using brace-depth
 * tracking, so nested braces in comments or descriptions do not truncate it.
 */
function extractTypeBlock(schema: string, typeName: string): string | null {
  const startRe = new RegExp(`(?:^|\\n)type\\s+${typeName}\\s*\\{`);
  const m = startRe.exec(schema);
  if (!m) return null;

  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  while (i < schema.length && depth > 0) {
    if (schema[i] === '{') depth++;
    else if (schema[i] === '}') depth--;
    i++;
  }
  // `i` now points one past the closing `}`
  return schema.substring(start, i - 1);
}

/** Extract field names from a type block body. */
function extractFieldNames(block: string): Set<string> {
  const fields = new Set<string>();
  for (const line of block.split('\n')) {
    // Match lines like `  fieldName(args): Type` or `  fieldName: Type`
    // Skip comment lines
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('"')) continue;
    const fieldMatch = trimmed.match(/^(\w+)\s*[(:]/);
    if (fieldMatch) fields.add(fieldMatch[1]);
  }
  return fields;
}

/** Extract field names from a top-level GraphQL type. */
function extractTypeFields(schema: string, typeName: string): Set<string> {
  const block = extractTypeBlock(schema, typeName);
  if (!block) return new Set();
  return extractFieldNames(block);
}

/** Recursively collect .ts/.tsx files, skipping __tests__ dirs. */
function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      results.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

interface OperationRootField {
  file: string;
  kind: OperationKind;
  operationName: string;
  field: string;
}

/**
 * Extract root fields from GraphQL operation documents embedded in template
 * literals.
 *
 * Matches backtick-delimited strings whose body contains a GraphQL operation
 * keyword (query, mutation, subscription) followed by an operation name,
 * optional variables, and a selection set with a root field.
 *
 * Skips template literals that use JS interpolation (`${...}`) — those compose
 * fragments at runtime and cannot be parsed as standalone GraphQL.
 */
function findOperationRootFields(
  files: string[],
): OperationRootField[] {
  const results: OperationRootField[] = [];

  // Match: <kind> <Name>(<vars>) { \n <rootField>
  const opRe =
    /(query|mutation|subscription)\s+([A-Z]\w*)\s*(?:\([^)]*\))?\s*\{\s*\n\s*([a-zA-Z]\w*)/g;

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const templateLiteralRe = /`([^`]*)`/gs;
    let tlMatch: RegExpExecArray | null;
    while ((tlMatch = templateLiteralRe.exec(content)) !== null) {
      const body = tlMatch[1];

      // Skip template literals with JS interpolation
      if (body.includes('${')) continue;

      opRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = opRe.exec(body)) !== null) {
        results.push({
          file: path.relative(FRONTEND_SRC, file),
          kind: m[1] as OperationKind,
          operationName: m[2],
          field: m[3],
        });
      }
    }
  }
  return results;
}

describe('GraphQL operation guard — every operation root field matches the schema', () => {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  const schemaFields: Record<OperationKind, Set<string>> = {
    query: extractTypeFields(schema, ROOT_TYPE_MAP.query),
    mutation: extractTypeFields(schema, ROOT_TYPE_MAP.mutation),
    subscription: extractTypeFields(schema, ROOT_TYPE_MAP.subscription),
  };

  const sourceFiles = collectSourceFiles(FRONTEND_SRC);
  const allOps = findOperationRootFields(sourceFiles);

  test('schema Query type is parseable and non-empty', () => {
    expect(schemaFields.query.size).toBeGreaterThan(0);
  });

  test('schema Mutation type is parseable and non-empty', () => {
    expect(schemaFields.mutation.size).toBeGreaterThan(0);
  });

  test('schema Subscription type is parseable and non-empty', () => {
    expect(schemaFields.subscription.size).toBeGreaterThan(0);
  });

  test('found at least one query document in frontend source', () => {
    expect(allOps.filter(o => o.kind === 'query').length).toBeGreaterThan(0);
  });

  test('found at least one mutation document in frontend source', () => {
    expect(allOps.filter(o => o.kind === 'mutation').length).toBeGreaterThan(0);
  });

  test('found at least one subscription document in frontend source', () => {
    expect(allOps.filter(o => o.kind === 'subscription').length).toBeGreaterThan(0);
  });

  test('every query root field exists in schema Query type', () => {
    const dead = allOps
      .filter(o => o.kind === 'query')
      .filter(o => !schemaFields.query.has(o.field));
    if (dead.length > 0) {
      const list = dead.map(d => `  ${d.file} → ${d.operationName} → ${d.field}`).join('\n');
      throw new Error(`Dead query root fields (not in schema Query type):\n${list}`);
    }
  });

  test('every mutation root field exists in schema Mutation type', () => {
    const dead = allOps
      .filter(o => o.kind === 'mutation')
      .filter(o => !schemaFields.mutation.has(o.field));
    if (dead.length > 0) {
      const list = dead.map(d => `  ${d.file} → ${d.operationName} → ${d.field}`).join('\n');
      throw new Error(`Dead mutation root fields (not in schema Mutation type):\n${list}`);
    }
  });

  test('every subscription root field exists in schema Subscription type', () => {
    const dead = allOps
      .filter(o => o.kind === 'subscription')
      .filter(o => !schemaFields.subscription.has(o.field));
    if (dead.length > 0) {
      const list = dead.map(d => `  ${d.file} → ${d.operationName} → ${d.field}`).join('\n');
      throw new Error(`Dead subscription root fields (not in schema Subscription type):\n${list}`);
    }
  });
});
