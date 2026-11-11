/**
 * CIT-295/H17: binding ownership validation in tool-config-resolver.
 *
 * Before this fix, validateIntegrationBindings / validateDataStoreBindings
 * checked format only — a caller could reference integrations/datastores
 * belonging to a foreign org. The fix adds assertIntegrationBindingOwnership
 * and assertDataStoreBindingOwnership that verify each referenced id exists
 * and belongs to the caller's org (or "All Organizations").
 */

// Env vars MUST be set BEFORE importing the resolver module — the resolver
// captures table names at module-load time.
process.env.INTEGRATIONS_TABLE = "citadel-integrations-test";
process.env.DATASTORES_TABLE = "citadel-datastores-test";
process.env.TOOLS_CONFIG_TABLE = "citadel-tools-test";

import {
  DynamoDBDocumentClient,
  QueryCommand,
  BatchGetCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";

const ddbMock = mockClient(DynamoDBDocumentClient);

import {
  assertIntegrationBindingOwnership,
  assertDataStoreBindingOwnership,
} from "../tool-config-resolver";

beforeEach(() => {
  ddbMock.reset();
});

describe("CIT-295/H17: assertIntegrationBindingOwnership", () => {
  test("allows bindings that belong to the caller's org", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ integrationId: "int-1", orgId: "org-1" }],
    });
    await expect(
      assertIntegrationBindingOwnership(["int-1"], "org-1"),
    ).resolves.toBeUndefined();
  });

  test('allows bindings with orgId "All Organizations"', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ integrationId: "int-shared", orgId: "All Organizations" }],
    });
    await expect(
      assertIntegrationBindingOwnership(["int-shared"], "org-1"),
    ).resolves.toBeUndefined();
  });

  test("rejects missing integration (opaque error)", async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await expect(
      assertIntegrationBindingOwnership(["int-missing"], "org-1"),
    ).rejects.toThrow(/invalid or inaccessible integration/);
  });

  test("rejects foreign-org integration (opaque error, same message as missing)", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ integrationId: "int-foreign", orgId: "org-EVIL" }],
    });
    const err = await assertIntegrationBindingOwnership(
      ["int-foreign"],
      "org-1",
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      /invalid or inaccessible integration/,
    );
    // Must NOT leak the foreign org id
    expect((err as Error).message).not.toContain("org-EVIL");
    expect((err as Error).message).not.toContain("int-foreign");
  });

  test("deduplicates ids — queries each unique id once", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ integrationId: "int-1", orgId: "org-1" }],
    });
    await assertIntegrationBindingOwnership(
      ["int-1", "int-1", "int-1"],
      "org-1",
    );
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
  });

  test("no-ops on empty list", async () => {
    await expect(
      assertIntegrationBindingOwnership([], "org-1"),
    ).resolves.toBeUndefined();
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });
});

describe("CIT-295/H17: assertDataStoreBindingOwnership", () => {
  test("allows datastores that belong to the caller's org", async () => {
    ddbMock.on(BatchGetCommand).resolves({
      Responses: {
        "citadel-datastores-test": [{ dataStoreId: "ds-1", orgId: "org-1" }],
      },
    });
    await expect(
      assertDataStoreBindingOwnership(["ds-1"], "org-1"),
    ).resolves.toBeUndefined();
  });

  test('allows datastores with orgId "All Organizations"', async () => {
    ddbMock.on(BatchGetCommand).resolves({
      Responses: {
        "citadel-datastores-test": [
          { dataStoreId: "ds-shared", orgId: "All Organizations" },
        ],
      },
    });
    await expect(
      assertDataStoreBindingOwnership(["ds-shared"], "org-1"),
    ).resolves.toBeUndefined();
  });

  test("rejects missing datastore (opaque error)", async () => {
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { "citadel-datastores-test": [] },
    });
    await expect(
      assertDataStoreBindingOwnership(["ds-missing"], "org-1"),
    ).rejects.toThrow(/invalid or inaccessible data store/);
  });

  test("rejects foreign-org datastore (opaque error, same message as missing)", async () => {
    ddbMock.on(BatchGetCommand).resolves({
      Responses: {
        "citadel-datastores-test": [
          { dataStoreId: "ds-foreign", orgId: "org-OTHER" },
        ],
      },
    });
    const err = await assertDataStoreBindingOwnership(
      ["ds-foreign"],
      "org-1",
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      /invalid or inaccessible data store/,
    );
    expect((err as Error).message).not.toContain("org-OTHER");
    expect((err as Error).message).not.toContain("ds-foreign");
  });

  test("no-ops on empty list", async () => {
    await expect(
      assertDataStoreBindingOwnership([], "org-1"),
    ).resolves.toBeUndefined();
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(0);
  });
});
