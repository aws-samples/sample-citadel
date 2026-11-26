/**
 * Board task 663c0271: schema hygiene assertions.
 *
 * 1. Mutation.testTool must NOT take an orgId argument (server-authoritative).
 * 2. Query.getDashboardMetrics and Query.getRecentActivity must not exist
 *    (dead fields — no resolver wired).
 *
 * Written RED-first against main where all three conditions are violated.
 */
import * as fs from "fs";
import * as path from "path";

const SCHEMA_PATH = path.resolve(__dirname, "../src/schema/schema.graphql");

let schema: string;
beforeAll(() => {
  schema = fs.readFileSync(SCHEMA_PATH, "utf-8");
});

describe("schema — board task 663c0271", () => {
  it("Mutation.testTool has no orgId argument", () => {
    // Match the testTool field declaration in the Mutation type
    const testToolMatch = schema.match(/testTool\s*\([^)]*\)/);
    expect(testToolMatch).not.toBeNull();
    const argList = testToolMatch![0];
    expect(argList).not.toMatch(/orgId/);
  });

  it("Query type does not declare getDashboardMetrics", () => {
    // The field should not appear as a Query field at all
    expect(schema).not.toMatch(/getDashboardMetrics\s*\(/);
  });

  it("Query type does not declare getRecentActivity", () => {
    expect(schema).not.toMatch(/getRecentActivity\s*\(/);
  });
});
