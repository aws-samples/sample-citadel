/**
 * Guard test: every `subscription { <field> }` document in frontend/src must
 * name a field that actually exists in `type Subscription` of the backend
 * GraphQL schema.  Catches dead subscriptions at CI time instead of at runtime
 * (AppSync FieldUndefined errors in the browser console).
 *
 * CIT-278 — the two fields that motivated this guard were onCreateProject and
 * onUpdateProject, both absent from the schema.
 */
import * as fs from 'fs';
import * as path from 'path';

const FRONTEND_SRC = path.resolve(__dirname, '..', '..');
const SCHEMA_PATH = path.resolve(FRONTEND_SRC, '..', '..', 'backend', 'src', 'schema', 'schema.graphql');

/** Extract field names from a top-level GraphQL type block. */
function extractTypeFields(schema: string, typeName: string): Set<string> {
  const re = new RegExp(`type\\s+${typeName}\\s*\\{([^}]+)\\}`, 's');
  const match = schema.match(re);
  if (!match) return new Set();
  const block = match[1];
  const fields = new Set<string>();
  for (const line of block.split('\n')) {
    const m = line.match(/^\s*(\w+)\s*[(:]/);
    if (m) fields.add(m[1]);
  }
  return fields;
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

/**
 * Detect whether a template literal body is a GraphQL document.
 *
 * A real GraphQL document contains an operation keyword (`query`, `mutation`,
 * or `subscription`) followed by an operation name, optional variables, and a
 * selection set.  Log messages like `"Backend subscription for ${eventType}"`
 * do NOT contain a selection set (opening `{` followed by a plain identifier
 * on a subsequent line or after whitespace).
 *
 * We require the root field to be a plain identifier (no `$` prefix, which
 * would indicate a JS template expression like `${eventType}`).
 */
function findSubscriptionRootFields(
  files: string[],
): Array<{ file: string; field: string }> {
  const results: Array<{ file: string; field: string }> = [];

  // Match: subscription <Name>(<vars>) { \n <rootField>
  // The root field must:
  //   - follow a `{` + optional whitespace/newline
  //   - start with a letter (not $ which indicates a JS interpolation)
  //   - be a plain word (the GraphQL field name)
  const opRe =
    /subscription\s+[A-Z]\w*\s*(?:\([^)]*\))?\s*\{\s*\n\s*([a-zA-Z]\w*)/g;

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const templateLiteralRe = /`([^`]*)`/gs;
    let tlMatch: RegExpExecArray | null;
    while ((tlMatch = templateLiteralRe.exec(content)) !== null) {
      const body = tlMatch[1];
      opRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = opRe.exec(body)) !== null) {
        results.push({ file: path.relative(FRONTEND_SRC, file), field: m[1] });
      }
    }
  }
  return results;
}

describe('GraphQL operation guard — subscription fields match schema', () => {
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  const subscriptionFields = extractTypeFields(schema, 'Subscription');
  const sourceFiles = collectSourceFiles(FRONTEND_SRC);
  const usedSubscriptions = findSubscriptionRootFields(sourceFiles);

  test('schema Subscription type is parseable and non-empty', () => {
    expect(subscriptionFields.size).toBeGreaterThan(0);
  });

  test('found at least one subscription document in frontend source', () => {
    // Sanity check — if zero documents are found the guard is vacuously true
    // and therefore useless.
    expect(usedSubscriptions.length).toBeGreaterThan(0);
  });

  test('every subscription document names a field present in the schema', () => {
    const dead: Array<{ file: string; field: string }> = [];
    for (const { file, field } of usedSubscriptions) {
      if (!subscriptionFields.has(field)) {
        dead.push({ file, field });
      }
    }
    expect(dead).toEqual([]);
  });
});
