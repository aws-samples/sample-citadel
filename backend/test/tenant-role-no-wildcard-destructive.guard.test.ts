/**
 * Citadel PR-2 (Continuum C3, CRITICAL): machine-enforced invariant.
 *
 * A policy minted onto a tenant-assumable `citadel-ds-<id>` role (i.e. the
 * `.connect` policy returned by an adapter's `requiredPolicies`, since the
 * resolver mints ONLY `.connect` onto that role — see
 * datastore-resolver.ts) must contain:
 *   - no Delete-/Create- action (control-plane destroy/provision verbs);
 *   - no statement whose `resources` includes the bare wildcard `"*"`.
 *
 * `aoss:APIAccessAll` is intentionally NOT treated as disqualifying on its
 * own: OpenSearch Serverless has no finer-grained read/write action split,
 * so it is the adapter's only data-plane verb — the invariant that matters
 * for it is the resource bound (a concrete `collection/<id>` ARN, never
 * `"*"`), asserted separately below.
 *
 * Before PR-2, DynamoDB/RDS adapters minted `.provision` (not `.connect`)
 * onto this role, which contained Delete actions on Resource "*" —
 * exactly the Continuum C3 finding. This guard scans every adapter's
 * `.connect` output (the only policy ever minted onto a tenant role) so a
 * future adapter cannot reintroduce the same shape.
 */

import { DynamoDBAdapter } from "../src/lambda/adapters/dynamodb-adapter";
import { RdsAdapter } from "../src/lambda/adapters/rds-adapter";
import { KnowledgeBaseAdapter } from "../src/lambda/adapters/knowledge-base-adapter";
import { S3Adapter } from "../src/lambda/adapters/s3-adapter";
import type { ConnectorAdapter, PolicyStatement } from "../src/adapters/base";

const ACCOUNT_ID = "123456789012";
const REGION = "us-east-1";

const DESTRUCTIVE_ACTION_PATTERN = /(:Delete|:Create)/i;

interface AdapterCase {
  name: string;
  adapter: ConnectorAdapter;
  sampleConfig: Record<string, unknown>;
}

const CASES: AdapterCase[] = [
  {
    name: "DynamoDBAdapter",
    adapter: new DynamoDBAdapter(),
    sampleConfig: { tableName: "citadel-sample-table" },
  },
  {
    name: "RdsAdapter(postgres)",
    adapter: new RdsAdapter("postgres"),
    sampleConfig: { dbInstanceIdentifier: "citadel-sample-db" },
  },
  {
    name: "KnowledgeBaseAdapter",
    adapter: new KnowledgeBaseAdapter(),
    sampleConfig: {
      dataStoreId: "ds-sample",
      orgId: "org-sample",
      knowledgeBaseId: "kb-sample",
      collectionId: "coll-sample",
    },
  },
  {
    name: "S3Adapter",
    adapter: new S3Adapter(),
    sampleConfig: { bucketName: "citadel-sample-bucket" },
  },
];

function assertNoWildcardDestructive(
  statements: PolicyStatement[],
  label: string,
): void {
  for (const stmt of statements) {
    for (const action of stmt.actions) {
      if (DESTRUCTIVE_ACTION_PATTERN.test(action)) {
        throw new Error(
          `${label}: connect policy contains destructive action "${action}"`,
        );
      }
    }
    if (stmt.resources.includes("*")) {
      throw new Error(
        `${label}: connect policy statement has a "*" resource: ${JSON.stringify(stmt)}`,
      );
    }
  }
}

describe("tenant-assumable role invariant (Continuum C3)", () => {
  for (const { name, adapter, sampleConfig } of CASES) {
    it(`${name}.requiredPolicies().connect has no Delete*/Create* action and no "*" resource`, () => {
      const policies = adapter.requiredPolicies(
        sampleConfig,
        ACCOUNT_ID,
        REGION,
      );
      assertNoWildcardDestructive(policies.connect, name);
    });
  }

  it("DynamoDBAdapter connect resources are concrete table ARNs, not wildcards", () => {
    const adapter = new DynamoDBAdapter();
    const policies = adapter.requiredPolicies(
      { tableName: "citadel-sample-table" },
      ACCOUNT_ID,
      REGION,
    );
    for (const stmt of policies.connect) {
      for (const resource of stmt.resources) {
        expect(resource).toContain("citadel-sample-table");
        expect(resource).not.toBe("*");
      }
    }
  });

  it("RdsAdapter connect resources are concrete db ARNs, not wildcards", () => {
    const adapter = new RdsAdapter("postgres");
    const policies = adapter.requiredPolicies(
      { dbInstanceIdentifier: "citadel-sample-db" },
      ACCOUNT_ID,
      REGION,
    );
    for (const stmt of policies.connect) {
      for (const resource of stmt.resources) {
        expect(resource).toContain("citadel-sample-db");
        expect(resource).not.toBe("*");
      }
    }
  });

  it("KnowledgeBaseAdapter connect resources are concrete KB/collection ARNs, not wildcards", () => {
    const adapter = new KnowledgeBaseAdapter();
    const policies = adapter.requiredPolicies(
      {
        dataStoreId: "ds-sample",
        orgId: "org-sample",
        knowledgeBaseId: "kb-sample",
        collectionId: "coll-sample",
      },
      ACCOUNT_ID,
      REGION,
    );
    for (const stmt of policies.connect) {
      for (const resource of stmt.resources) {
        expect(resource).not.toBe("*");
      }
    }
    const kbStmt = policies.connect.find((s) =>
      s.actions.includes("bedrock:GetKnowledgeBase"),
    );
    expect(kbStmt?.resources[0]).toContain("kb-sample");
    const collStmt = policies.connect.find((s) =>
      s.actions.includes("aoss:APIAccessAll"),
    );
    expect(collStmt?.resources[0]).toContain("coll-sample");
  });
});
