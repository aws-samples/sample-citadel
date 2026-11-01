/**
 * TDD Tests for adapter provision policy correctness.
 *
 * Verifies that:
 * 1. Provision policies use correct resource ARNs for create operations
 *    (some services require '*' for create actions)
 * 2. Provision policies include delete actions needed for deprovision
 *    (so the same scoped role can clean up on delete)
 */
import { getAdapter } from "../registry";

describe("Knowledge Base adapter provision policies", () => {
  const adapter = getAdapter("KNOWLEDGE_BASE");

  test("provision policies are empty (KB adapter manages its own IAM)", () => {
    const policies = adapter.requiredPolicies(
      { name: "test-kb" },
      "123456789012",
      "us-west-2",
    );

    // KB adapter returns empty provision policies — it creates its own
    // Bedrock service role and uses the Lambda's credentials directly
    expect(policies.provision).toEqual([]);
  });
});

describe("DynamoDB adapter provision policies include delete for deprovision", () => {
  const adapter = getAdapter("DYNAMODB");

  test("provision policies include dynamodb:DeleteTable", () => {
    const policies = adapter.requiredPolicies(
      { tableName: "test-table" },
      "123456789012",
      "us-west-2",
    );

    const allActions = policies.provision.flatMap((p) => p.actions);
    expect(allActions).toContain("dynamodb:DeleteTable");
  });
});

describe("RDS adapter provision policies include delete for deprovision", () => {
  const adapter = getAdapter("RDS_POSTGRESQL");

  test("provision policies include rds:DeleteDBInstance", () => {
    const policies = adapter.requiredPolicies(
      { dbInstanceIdentifier: "test-instance" },
      "123456789012",
      "us-west-2",
    );

    const allActions = policies.provision.flatMap((p) => p.actions);
    expect(allActions).toContain("rds:DeleteDBInstance");
  });
});

describe("Aurora adapter provision policies include delete for deprovision", () => {
  const adapter = getAdapter("AURORA_POSTGRESQL");

  test("provision policies include rds:DeleteDBCluster", () => {
    const policies = adapter.requiredPolicies(
      { dbClusterIdentifier: "test-cluster" },
      "123456789012",
      "us-west-2",
    );

    const allActions = policies.provision.flatMap((p) => p.actions);
    expect(allActions).toContain("rds:DeleteDBCluster");
  });
});

describe("Redshift adapter provision policies include delete for deprovision", () => {
  const adapter = getAdapter("REDSHIFT");

  test("provision policies include redshift:DeleteCluster", () => {
    const policies = adapter.requiredPolicies(
      { clusterIdentifier: "test-cluster" },
      "123456789012",
      "us-west-2",
    );

    const allActions = policies.provision.flatMap((p) => p.actions);
    expect(allActions).toContain("redshift:DeleteCluster");
  });
});

describe("OpenSearch adapter provision policies include delete for deprovision", () => {
  const adapter = getAdapter("OPENSEARCH");

  test("provision policies include aoss:DeleteCollection", () => {
    const policies = adapter.requiredPolicies(
      { collectionName: "test-col" },
      "123456789012",
      "us-west-2",
    );

    const allActions = policies.provision.flatMap((p) => p.actions);
    expect(allActions).toContain("aoss:DeleteCollection");
  });
});

describe("Neptune adapter provision policies include delete for deprovision", () => {
  const adapter = getAdapter("NEPTUNE");

  test("provision policies include rds:DeleteDBCluster", () => {
    const policies = adapter.requiredPolicies(
      { dbClusterIdentifier: "test-cluster" },
      "123456789012",
      "us-west-2",
    );

    const allActions = policies.provision.flatMap((p) => p.actions);
    expect(allActions).toContain("rds:DeleteDBCluster");
  });
});

describe("Timestream adapter provision policies include delete for deprovision", () => {
  const adapter = getAdapter("TIMESTREAM");

  test("provision policies include timestream:DeleteDatabase", () => {
    const policies = adapter.requiredPolicies(
      { databaseName: "test-db" },
      "123456789012",
      "us-west-2",
    );

    const allActions = policies.provision.flatMap((p) => p.actions);
    expect(allActions).toContain("timestream:DeleteDatabase");
  });
});

describe("ElastiCache adapter provision policies include delete for deprovision", () => {
  const adapter = getAdapter("ELASTICACHE_REDIS");

  test("provision policies include elasticache:DeleteCacheCluster", () => {
    const policies = adapter.requiredPolicies(
      { cacheClusterId: "test-cluster" },
      "123456789012",
      "us-west-2",
    );

    const allActions = policies.provision.flatMap((p) => p.actions);
    expect(allActions).toContain("elasticache:DeleteCacheCluster");
  });
});

describe("Keyspaces adapter provision policies include delete for deprovision", () => {
  const adapter = getAdapter("KEYSPACES");

  test("provision policies include cassandra:Drop", () => {
    const policies = adapter.requiredPolicies(
      { keyspaceName: "test-ks" },
      "123456789012",
      "us-west-2",
    );

    const allActions = policies.provision.flatMap((p) => p.actions);
    expect(allActions).toContain("cassandra:Drop");
  });
});

describe("DocumentDB adapter provision policies include delete for deprovision", () => {
  const adapter = getAdapter("DOCUMENTDB");

  test("provision policies include rds:DeleteDBCluster", () => {
    const policies = adapter.requiredPolicies(
      { dbClusterIdentifier: "test-cluster" },
      "123456789012",
      "us-west-2",
    );

    const allActions = policies.provision.flatMap((p) => p.actions);
    expect(allActions).toContain("rds:DeleteDBCluster");
  });
});

describe("S3 adapter provision policies are bucket-scoped (no wildcard Delete)", () => {
  const adapter = getAdapter("S3");

  test("provision policies scope DeleteBucket to the bucket ARN", () => {
    const policies = adapter.requiredPolicies(
      { bucketName: "citadel-test-bucket" },
      "123456789012",
      "us-east-1",
    );

    const deleteStmt = policies.provision.find((p) =>
      p.actions.includes("s3:DeleteBucket"),
    );
    expect(deleteStmt).toBeDefined();
    expect(deleteStmt!.resources).toEqual(["arn:aws:s3:::citadel-test-bucket"]);
    expect(deleteStmt!.resources).not.toContain("*");
  });

  test("provision policies scope DeleteObject to bucket objects", () => {
    const policies = adapter.requiredPolicies(
      { bucketName: "citadel-test-bucket" },
      "123456789012",
      "us-east-1",
    );

    const deleteObjStmt = policies.provision.find((p) =>
      p.actions.includes("s3:DeleteObject"),
    );
    expect(deleteObjStmt).toBeDefined();
    expect(deleteObjStmt!.resources).toEqual([
      "arn:aws:s3:::citadel-test-bucket/*",
    ]);
  });

  test("CreateBucket is scoped to citadel- prefix, not wildcard *", () => {
    const policies = adapter.requiredPolicies(
      { bucketName: "citadel-test-bucket" },
      "123456789012",
      "us-east-1",
    );

    const createStmt = policies.provision.find((p) =>
      p.actions.includes("s3:CreateBucket"),
    );
    expect(createStmt).toBeDefined();
    expect(createStmt!.resources).toEqual(["arn:aws:s3:::citadel-*"]);
    expect(createStmt!.resources).not.toContain("*");
  });
});
