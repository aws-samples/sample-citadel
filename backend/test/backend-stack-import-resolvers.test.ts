/**
 * Agent-import AppSync resolver wiring guard (US-IMP-017 regression).
 *
 * The agent-import resolver Lambda (`agent-import-resolver.ts`) multiplexes a
 * set of Mutation/Query fields off a single `event.info.fieldName` switch. Each
 * of those fields needs an explicit `AWS::AppSync::Resolver` wired to the shared
 * `AgentImportLambdaDataSource` in BackendStack — they are wired INDIVIDUALLY,
 * not via a loop, so adding a new handler case without the matching
 * `createResolver()` call silently leaves the field unreachable from the API.
 *
 * US-IMP-017 (`probeImportReachability`) hit exactly that gap: the schema and
 * handler shipped the field, but `backend-stack.ts` was never updated. This
 * test is the regression guard — it asserts every field the import resolver
 * serves has a resolver bound to the import data source (matched by FieldName +
 * the import data source, not merely by FieldName existing somewhere).
 */

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as path from 'path';
import * as fs from 'fs';

// Asset directories required for full-stack CDK synthesis. Most stack assets
// use CWD-relative paths (resolved against backend/ when jest runs there), but
// the seed-organizations Lambda resolves its asset via
// `path.join(__dirname, "../../src/lambda/seed-organizations")`. Under ts-jest
// the stack's __dirname is the SOURCE dir (backend/lib), so that path lands at
// the repo-root "src/lambda/seed-organizations". Ensure every such dir exists
// so `Template.fromStack` can stage assets, and afterwards remove only the
// directories this test created (leaving real source dirs untouched).
const requiredAssetDirs = [
  path.resolve(__dirname, '../dist/lambda'),
  path.resolve(__dirname, '../src/schema'),
  path.resolve(__dirname, '../src/lambda/seed-admin-user'),
  path.resolve(__dirname, '../../src/lambda/seed-organizations'),
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
    // Record deepest-first so cleanup prunes leaves before parents.
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
      // Best-effort cleanup of test-created empty dirs; never fail the suite.
      console.error('import-resolver test cleanup skipped', dir, err);
    }
  }
});

import { BackendStack } from '../lib/backend-stack';

const IMPORT_DATA_SOURCE_NAME = 'AgentImportLambdaDataSource';

/**
 * The authoritative field set served by the agent-import resolver Lambda
 * (`agent-import-resolver.ts` `switch (fieldName)`), with each field's GraphQL
 * root type. Keep this in lockstep with the handler switch — any field the
 * handler routes MUST have a resolver bound to the import data source.
 */
const EXPECTED_IMPORT_RESOLVER_FIELDS: ReadonlyArray<{
  field: string;
  type: 'Mutation' | 'Query';
}> = [
  { field: 'importAgent', type: 'Mutation' },
  { field: 'discoverAgents', type: 'Query' },
  { field: 'describeAgentCandidate', type: 'Query' },
  { field: 'attestAgentImport', type: 'Mutation' },
  { field: 'testImportedAgent', type: 'Mutation' },
  { field: 'probeAgentCandidate', type: 'Mutation' },
  { field: 'probeImportReachability', type: 'Mutation' },
  { field: 'proposeAgentManifestTier3', type: 'Mutation' },
  { field: 'acceptProposedManifestTier3', type: 'Mutation' },
  { field: 'publishImportToGateway', type: 'Mutation' },
  { field: 'unpublishImportFromGateway', type: 'Mutation' },
];

interface CfnResource {
  Properties?: {
    FieldName?: unknown;
    TypeName?: unknown;
    DataSourceName?: unknown;
  };
}

describe('BackendStack — agent-import resolver wiring (US-IMP-017 guard)', () => {
  let importDataSourceCount: number;
  // fieldName -> TypeName, restricted to resolvers bound to the import data
  // source. CDK emits an L2 resolver's `DataSourceName` as the data source's
  // plain string name (e.g. "AgentImportLambdaDataSource"), so the join key is
  // a direct string match rather than a CloudFormation intrinsic.
  let importWiredFields: Map<string, string>;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, 'TestBackendStackImportResolvers', {
      environment: 'test',
      env: { account: '123456789012', region: 'us-east-1' },
    });
    const template = Template.fromStack(stack);

    const importDataSources = template.findResources('AWS::AppSync::DataSource', {
      Properties: { Name: IMPORT_DATA_SOURCE_NAME },
    });
    importDataSourceCount = Object.keys(importDataSources).length;

    importWiredFields = new Map<string, string>();
    const resolvers = template.findResources('AWS::AppSync::Resolver') as Record<
      string,
      CfnResource
    >;
    for (const resource of Object.values(resolvers)) {
      const props = resource.Properties;
      if (!props) continue;
      if (props.DataSourceName !== IMPORT_DATA_SOURCE_NAME) continue;
      if (typeof props.FieldName === 'string' && typeof props.TypeName === 'string') {
        importWiredFields.set(props.FieldName, props.TypeName);
      }
    }
  });

  test('exposes exactly one AgentImport Lambda data source', () => {
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
