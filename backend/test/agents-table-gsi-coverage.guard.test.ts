/**
 * Structural guard: every stack file that constructs a hand-written
 * dynamodb:* IAM statement on `citadel-agents-${env}` MUST also grant
 * dynamodb:Query on the GSI index ARN (sourceProjectId-index).
 *
 * Without this guard, a new consumer stack that imports the agents table by
 * deterministic name (without globalIndexes) silently omits the GSI ARN,
 * and the shared findProjectAgentRecords query fails at runtime.
 *
 * Enforcement: scan backend/lib/*.ts for files that contain the agents
 * table name pattern AND a DynamoDB action grant — any such file must also
 * reference the index name constant or the index ARN pattern.
 */
import * as fs from "fs";
import * as path from "path";

const LIB_DIR = path.resolve(__dirname, "../lib");

// Files that define (not consume) the table + GSI are excluded.
const EXCLUDED = new Set(["backend-stack.ts"]);

describe("structural guard — agents table GSI grant coverage", () => {
  test("every stack that hand-grants DynamoDB actions on citadel-agents also covers the GSI index", () => {
    const files = fs
      .readdirSync(LIB_DIR)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    const violations: string[] = [];

    for (const file of files) {
      if (EXCLUDED.has(file)) continue;
      const content = fs.readFileSync(path.join(LIB_DIR, file), "utf8");

      // Does this file hand-write a DynamoDB grant on the agents table?
      const agentsTableRef = /citadel-agents-\$\{props\.environment\}/;
      const dynamoAction = /dynamodb:/;

      if (agentsTableRef.test(content) && dynamoAction.test(content)) {
        // It must also reference the GSI index ARN or the constant
        const hasGsiRef =
          content.includes("sourceProjectId-index") ||
          content.includes("AGENTS_TABLE_GSI_NAME") ||
          /citadel-agents-.*\/index\//.test(content);

        if (!hasGsiRef) {
          violations.push(file);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
