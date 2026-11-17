/**
 * Guard: every GraphQL document in deployed-smoke.mjs must validate
 * against the canonical schema.graphql (no unknown fields, arguments,
 * or types).
 *
 * Written RED-first against the broken testTool document that sends
 * `orgId` (removed from the schema by #554).
 */
import * as fs from "fs";
import * as path from "path";
import { buildSchema, parse, validate } from "graphql";

const SCHEMA_PATH = path.resolve(
  __dirname,
  "../src/schema/schema.graphql",
);

const SMOKE_PATH = path.resolve(
  __dirname,
  "../scripts/smoke/deployed-smoke.mjs",
);

/**
 * Extract the DOCUMENTS map from the smoke script source text.
 *
 * Matches the exported `DOCUMENTS = { key: \`...\`, ... }` block and
 * evaluates it in isolation (no network/AWS imports needed).
 */
function extractDocuments(): Record<string, string> {
  const src = fs.readFileSync(SMOKE_PATH, "utf-8");
  // Capture from "export const DOCUMENTS = {" to the closing "};"
  const match = src.match(
    /export\s+const\s+DOCUMENTS\s*=\s*(\{[\s\S]*?\n\});/,
  );
  if (!match) {
    throw new Error(
      "Could not find exported DOCUMENTS map in deployed-smoke.mjs",
    );
  }
  // Evaluate the object literal (pure data, no side effects)
  // eslint-disable-next-line no-eval
  const docs: Record<string, string> = eval(`(${match[1]})`);
  return docs;
}

let DOCUMENTS: Record<string, string>;
let schema: ReturnType<typeof buildSchema>;

beforeAll(() => {
  DOCUMENTS = extractDocuments();
  let sdl = fs.readFileSync(SCHEMA_PATH, "utf-8");

  // AppSync scalars + directives not known to graphql-js — stub them so
  // buildSchema succeeds while the document-level validation still catches
  // unknown fields/arguments.
  const appsyncPreamble = `
scalar AWSDateTime
scalar AWSJSON
directive @aws_iam on FIELD_DEFINITION | OBJECT
directive @aws_cognito_user_pools(cognito_groups: [String!]) on FIELD_DEFINITION | OBJECT
directive @aws_subscribe(mutations: [String!]!) on FIELD_DEFINITION
`;
  sdl = appsyncPreamble + sdl;
  schema = buildSchema(sdl);
});

describe("smoke documents match schema.graphql", () => {
  it("DOCUMENTS map is non-empty", () => {
    expect(Object.keys(DOCUMENTS).length).toBeGreaterThan(0);
  });

  it.each([
    "subNegative",
    "subPositive",
    "sendMessage",
    "testTool",
    "startExecution",
    "subWorkflowProgress",
    "getExecution",
    "listBlueprints",
  ])("%s validates against the schema", (key) => {
    const doc = DOCUMENTS[key];
    expect(doc).toBeDefined();
    const parsed = parse(doc);
    const errors = validate(schema, parsed);
    expect(errors).toEqual([]);
  });
});
