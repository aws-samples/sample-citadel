/**
 * Regression tests for two registry-sync UpdateExpression bugs surfaced by
 * production DLQ evidence (dev, 2026-11-18T03:00-04:00Z, 108 DLQ messages):
 *
 * Bug 1 — "Two document paths overlap ... path one: [config], path two:
 * [config]" (DynamoDB ValidationException) for 18 tool records on
 * "Registry Record State changed to Draft" events. Root cause:
 * handleGaUpsert's main UpdateCommand unconditionally appended
 * `#config = if_not_exists(#config, :emptyConfig)` even when the fields
 * loop had already appended `#config = :config` for the same resourceId
 * (tool records always set fields.config from record.description). Two SET
 * clauses targeting the same top-level document path `config` is exactly
 * the overlap DynamoDB rejects. Already fixed on main by 81677d53
 * ("fix(registry-sync): GA upserts project sourceProjectId (and config)
 * from the Citadel descriptor", 2026-11-18T03:27:59Z — 27 minutes after the
 * incident window), which added the `if (!("config" in fields))` guard
 * around the if_not_exists fallback so the two clauses can never coexist.
 * This file adds the regression coverage that commit lacked for the
 * specific tool-record overlap shape described in the incident.
 *
 * Bug 2 — "An expression attribute value used in expression is not
 * defined" in the agent projection row write (writeProjectionRow, the
 * best-effort path inside handleGaUpsert), observed 2026-11-20T05:27Z.
 * Root cause: writeProjectionRow built its SET clause from every entry of
 * the built projection row unconditionally, including optional fields that
 * are `undefined` on the row (appId, sourceProjectId, etc. for records
 * with no source value), producing a `#p_appId = :p_appId` clause whose
 * placeholder has no corresponding ExpressionAttributeValues entry once
 * DynamoDB's client strips/rejects the undefined binding. Already fixed on
 * main by 3b4d7b3b ("fix(registry-sync): omit undefined optional fields
 * from projection UpdateExpression", 2026-11-20T11:08:15Z), which skips any
 * attribute whose value is `undefined` before adding it to the SET clause.
 * registry-sync-projection-optional-fields.test.ts already covers appId
 * and sourceProjectId directly; this file adds the general "every
 * placeholder has a value" invariant check using the real builder against
 * an agent record with several descriptor-derived optional fields absent.
 */

process.env.AGENT_CONFIG_TABLE = "test-agents-table";
process.env.TOOLS_CONFIG_TABLE = "test-tools-table";
process.env.REGISTRY_ID = "test-registry-id";
process.env.DLQ_URL = "https://sqs.us-east-1.amazonaws.com/123456789/test-dlq";

import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  UpdateCommand,
  GetCommand,
} from "@aws-sdk/lib-dynamodb";
import { SQSClient } from "@aws-sdk/client-sqs";
import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import {
  handleGaUpsert,
  writeProjectionRow,
  buildGaMergeFields,
} from "../registry-sync";
import type { RegistryRecord } from "../../services/registry-service";

jest.mock("../../services/registry-service", () => {
  const actual = jest.requireActual("../../services/registry-service");
  return { ...actual };
});

const ddbMock = mockClient(DynamoDBDocumentClient);
const sqsMock = mockClient(SQSClient);
const cwMock = mockClient(CloudWatchClient);

beforeEach(() => {
  ddbMock.reset();
  sqsMock.reset();
  cwMock.reset();
  ddbMock.on(UpdateCommand).resolves({});
  ddbMock.on(GetCommand).resolves({}); // no existing item -> not seeder-owned
  jest.spyOn(console, "log").mockImplementation();
  jest.spyOn(console, "warn").mockImplementation();
  jest.spyOn(console, "error").mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

/**
 * Asserts an UpdateExpression never contains two SET clauses targeting the
 * same top-level document path. DynamoDB's own rule: a document path (here
 * a single top-level attribute name, e.g. `config`) may appear at most once
 * across the whole SET clause list, whether via a plain `#x = :x` or an
 * `if_not_exists(#x, :y)` wrapper — both still write to path `[x]`.
 */
function assertNoOverlappingSetPaths(updateExpression: string): void {
  const setClause = updateExpression.replace(/^SET\s+/, "");
  // Split on top-level commas only — a comma inside an if_not_exists(#x, :y)
  // call is NOT a clause separator, so track paren depth while splitting.
  const clauses: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of setClause) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      clauses.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) clauses.push(current.trim());

  const paths = clauses.map((c) => {
    const match = c.match(/^(#[A-Za-z0-9_]+)/);
    if (!match) {
      throw new Error(`Could not parse document path from SET clause: ${c}`);
    }
    return match[1];
  });
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const p of paths) {
    if (seen.has(p)) dupes.push(p);
    seen.add(p);
  }
  expect({ dupes, clauses }).toEqual({ dupes: [], clauses });
}

// ---------------------------------------------------------------------------
// Bug 1 — overlapping `config` document path (tool records)
// ---------------------------------------------------------------------------

describe("handleGaUpsert — tool record does not double-SET the config path", () => {
  function toolRecord(overrides: Partial<RegistryRecord> = {}): RegistryRecord {
    return {
      recordId: "RecTool00001",
      name: "settlement-lookup",
      description: "Looks up settlement status for a ticket id",
      status: "DRAFT",
      customDescriptorContent: JSON.stringify({
        categories: ["worker"],
        icon: "",
      }),
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt: new Date("2026-11-18T03:00:00.000Z"),
      ...overrides,
    } as unknown as RegistryRecord;
  }

  test("buildGaMergeFields sets a whole-map config for a tool record (precondition for the overlap)", () => {
    const fields = buildGaMergeFields("tool", toolRecord());
    expect(fields).toHaveProperty("config");
    expect(fields.config).toBe("Looks up settlement status for a ticket id");
  });

  test("the resulting UpdateCommand's UpdateExpression sets #config exactly once, never twice", async () => {
    const record = toolRecord();

    await handleGaUpsert("test-tools-table", "tool", "RecTool00001", record);

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    const input = call.args[0].input;

    assertNoOverlappingSetPaths(input.UpdateExpression as string);

    // Exactly one #config clause, bound to the record's description — the
    // if_not_exists(#config, :emptyConfig) fallback must NOT also appear.
    const configClauseCount = (
      input.UpdateExpression!.match(/#config\b/g) ?? []
    ).length;
    expect(configClauseCount).toBe(1);
    expect(input.ExpressionAttributeNames?.["#config"]).toBe("config");
    expect(input.ExpressionAttributeValues?.[":config"]).toBe(
      "Looks up settlement status for a ticket id",
    );
    expect(input.ExpressionAttributeValues).not.toHaveProperty(":emptyConfig");
  });

  test("a tool record with no description (sparse payload) falls back to the if_not_exists config clause, still only once", async () => {
    const record = toolRecord({ description: undefined });

    await handleGaUpsert("test-tools-table", "tool", "RecTool00002", record);

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    const input = call.args[0].input;

    assertNoOverlappingSetPaths(input.UpdateExpression as string);
    expect(input.UpdateExpression).toMatch(
      /#config = if_not_exists\(#config, :emptyConfig\)/,
    );
    const configClauseCount = (
      input.UpdateExpression!.match(/#config\b/g) ?? []
    ).length;
    // if_not_exists mentions #config twice textually (both its args use the
    // same name alias) but that is ONE SET clause/document path, not two.
    expect(configClauseCount).toBe(2);
    assertNoOverlappingSetPaths(input.UpdateExpression as string);
  });
});

// ---------------------------------------------------------------------------
// Bug 2 — every ExpressionAttributeValues placeholder referenced in the
// projection UpdateExpression must actually have a bound value.
// ---------------------------------------------------------------------------

describe("writeProjectionRow — every :placeholder has a defined value (agent projection, best-effort path)", () => {
  function sparseAgentRecord(): RegistryRecord {
    return {
      recordId: "RecAgent00099",
      name: "fabricated-agent-sparse",
      description: "A fabricated agent with minimal descriptor metadata",
      status: "APPROVED",
      customDescriptorContent: JSON.stringify({
        citadelKind: "agent",
        categories: ["worker"],
        icon: "",
        state: "APPROVED",
        orgId: "org-a",
        // appId, sourceProjectId, manifest, decidedBy, decidedAt,
        // statusReason, tags all intentionally absent.
      }),
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      updatedAt: new Date("2026-11-20T05:27:00.000Z"),
    } as unknown as RegistryRecord;
  }

  test("every :p_ placeholder named in the UpdateExpression has a non-undefined ExpressionAttributeValues entry", async () => {
    const record = sparseAgentRecord();

    await writeProjectionRow(
      ddbMock as unknown as DynamoDBDocumentClient,
      "test-agents-table",
      "agent",
      "RecAgent00099",
      record,
      "2026-11-20T05:27:00Z",
    );

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    const input = call.args[0].input;

    const placeholders = [
      ...(input.UpdateExpression as string).matchAll(/:p_[A-Za-z0-9_]+/g),
    ].map((m) => m[0]);
    expect(placeholders.length).toBeGreaterThan(0);

    for (const placeholder of placeholders) {
      expect(input.ExpressionAttributeValues).toHaveProperty(placeholder);
      expect(
        input.ExpressionAttributeValues?.[placeholder],
      ).not.toBeUndefined();
    }

    // The optional, genuinely-absent fields must not appear at all —
    // neither as a name alias nor as a placeholder.
    for (const absentField of ["appId", "sourceProjectId", "manifest"]) {
      expect(input.ExpressionAttributeNames).not.toHaveProperty(
        `#p_${absentField}`,
      );
      expect(input.ExpressionAttributeValues).not.toHaveProperty(
        `:p_${absentField}`,
      );
    }
  });

  test("no ExpressionAttributeValues entry anywhere in the command is undefined", async () => {
    const record = sparseAgentRecord();

    await writeProjectionRow(
      ddbMock as unknown as DynamoDBDocumentClient,
      "test-agents-table",
      "agent",
      "RecAgent00099",
      record,
      "2026-11-20T05:27:00Z",
    );

    const call = ddbMock.commandCalls(UpdateCommand)[0];
    const input = call.args[0].input;

    for (const value of Object.values(input.ExpressionAttributeValues ?? {})) {
      expect(value).not.toBeUndefined();
    }
  });
});
