/**
 * Agent-import AppSync resolver wiring guard (US-IMP-017 regression).
 *
 * The agent-import resolver Lambda (`agent-import-resolver.ts`) multiplexes a
 * set of Mutation/Query fields off a single `event.info.fieldName` switch. Each
 * of those fields needs an explicit `AWS::AppSync::Resolver` wired to the shared
 * `AgentImportLambdaDataSource` in CitadelRegistryStack (moved here from
 * BackendStack in backend-stack-split phase 2, decision 30e6d067) — they are
 * wired INDIVIDUALLY, not via a loop, so adding a new handler case without the
 * matching resolver call silently leaves the field unreachable from the API.
 *
 * US-IMP-017 (`probeImportReachability`) hit exactly that gap: the schema and
 * handler shipped the field, but the stack was never updated. This test is the
 * regression guard — it asserts every field the import resolver serves has a
 * resolver bound to the import data source (matched by FieldName + the import
 * data source, not merely by FieldName existing somewhere).
 */

import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as path from "path";
import * as fs from "fs";

const requiredAssetDirs = [
  path.resolve(__dirname, "../dist/lambda"),
  path.resolve(__dirname, "../src/schema"),
  path.resolve(__dirname, "../src/lambda/seed-admin-user"),
  path.resolve(__dirname, "../../src/lambda/seed-organizations"),
];

const dirsCreatedByThisTest: string[] = [];

function ensureDirExists(dir: string): void {
  const missing: string[] = [];
  let current = dir;
  while (!fs.existsSync(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (missing.length > 0) {
    fs.mkdirSync(dir, { recursive: true });
    dirsCreatedByThisTest.push(...missing);
  }
}

for (const dir of requiredAssetDirs) {
  ensureDirExists(dir);
}

afterAll(() => {
  for (const dir of dirsCreatedByThisTest) {
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
      }
    } catch (err) {
      console.error("import-resolver test cleanup skipped", dir, err);
    }
  }
});

import { BackendStack } from "../lib/backend-stack";
import { RegistryStack } from "../lib/registry-stack";

const IMPORT_DATA_SOURCE_NAME = "AgentImportLambdaDataSource";

const EXPECTED_IMPORT_RESOLVER_FIELDS: ReadonlyArray<{
  field: string;
  type: "Mutation" | "Query";
}> = [
  { field: "importAgent", type: "Mutation" },
  { field: "discoverAgents", type: "Query" },
  { field: "describeAgentCandidate", type: "Query" },
  { field: "attestAgentImport", type: "Mutation" },
  { field: "testImportedAgent", type: "Mutation" },
  { field: "probeAgentCandidate", type: "Mutation" },
  { field: "probeImportReachability", type: "Mutation" },
  { field: "proposeAgentManifestTier3", type: "Mutation" },
  { field: "acceptProposedManifestTier3", type: "Mutation" },
  { field: "publishImportToGateway", type: "Mutation" },
  { field: "unpublishImportFromGateway", type: "Mutation" },
];

interface CfnResource {
  Properties?: {
    FieldName?: unknown;
    TypeName?: unknown;
    DataSourceName?: unknown;
  };
}

/**
 * L1 CfnResolver (used by RegistryStack's cross-stack attach pattern) renders
 * `DataSourceName` as `{ "Fn::GetAtt": ["<DataSourceLogicalId>", "Name"] }`,
 * not a plain string (that's the L2 `createResolver` default). Match on the
 * GetAtt target's logical ID instead of a direct string comparison.
 */
function resolverTargetsDataSource(
  dataSourceName: unknown,
  dataSourceLogicalId: string,
): boolean {
  if (typeof dataSourceName === "string") {
    return dataSourceName === dataSourceLogicalId;
  }
  const getAtt = (dataSourceName as { ["Fn::GetAtt"]?: unknown[] })?.[
    "Fn::GetAtt"
  ];
  return Array.isArray(getAtt) && getAtt[0] === dataSourceLogicalId;
}

describe("CitadelRegistryStack — agent-import resolver wiring (US-IMP-017 guard)", () => {
  let importDataSourceCount: number;
  let importWiredFields: Map<string, string>;

  beforeAll(() => {
    const app = new cdk.App();
    const backendStack = new BackendStack(
      app,
      "TestBackendStackImportResolvers",
      {
        environment: "test",
        env: { account: "123456789012", region: "us-east-1" },
      },
    );
    const stack = new RegistryStack(app, "TestRegistryStackImportResolvers", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
      appSyncApi: backendStack.appSyncApi,
      agentEventBus: backendStack.agentEventBus,
      appsTable: backendStack.appsTable,
      workflowsTable: backendStack.workflowsTable,
      agentConfigTable: backendStack.agentConfigTable,
      modelCatalogTable: backendStack.modelCatalogTable,
      idempotencyTable: backendStack.idempotencyTable,
      userPool: backendStack.userPool,
      registryArn: backendStack.registryArn,
      registryId: backendStack.registryId,
      adrsTable: backendStack.adrsTable,
    });
    const template = Template.fromStack(stack);

    // L1 CfnDataSource: find by logical ID suffix "LambdaDataSource" whose
    // Name property equals the expected literal (RegistryStack's
    // makeLambdaDataSource sets `name: ${logicalPrefix}LambdaDataSource`).
    const importDataSources = template.findResources(
      "AWS::AppSync::DataSource",
      {
        Properties: { Name: IMPORT_DATA_SOURCE_NAME },
      },
    );
    const importDataSourceLogicalIds = Object.keys(importDataSources);
    importDataSourceCount = importDataSourceLogicalIds.length;
    const importDataSourceLogicalId = importDataSourceLogicalIds[0];

    importWiredFields = new Map<string, string>();
    const resolvers = template.findResources(
      "AWS::AppSync::Resolver",
    ) as Record<string, CfnResource>;
    for (const resource of Object.values(resolvers)) {
      const props = resource.Properties;
      if (!props) continue;
      if (
        !importDataSourceLogicalId ||
        !resolverTargetsDataSource(
          props.DataSourceName,
          importDataSourceLogicalId,
        )
      ) {
        continue;
      }
      if (
        typeof props.FieldName === "string" &&
        typeof props.TypeName === "string"
      ) {
        importWiredFields.set(props.FieldName, props.TypeName);
      }
    }
  });

  test("exposes exactly one AgentImport Lambda data source", () => {
    expect(importDataSourceCount).toBe(1);
  });

  test.each(EXPECTED_IMPORT_RESOLVER_FIELDS)(
    'wires an AppSync $type resolver for "$field" to the AgentImport data source',
    ({ field, type }) => {
      expect(importWiredFields.has(field)).toBe(true);
      expect(importWiredFields.get(field)).toBe(type);
    },
  );
});
