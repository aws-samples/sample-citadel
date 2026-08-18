/**
 * Environment release pointer — EnvironmentReleasePointersTable CDK
 * template assertions, shipped in the same change as the table (per the
 * lesson recorded on AgentReleasesTable's own test: "do not repeat the
 * eval-tables retrofit").
 *
 * THE INVARIANT AT RISK (why this table's test exists on its own, not
 * folded into backend-stack-agent-releases-table.test.ts): the pointer
 * table legitimately needs UpdateItem because it is mutable, and its
 * resolver's role must NEVER cause that UpdateItem capability to leak
 * onto AgentReleasesTable, which Slice 1 guarantees carries zero
 * UpdateItem/DeleteItem from any principal. A previous slice broke this
 * exact way via grantReadWriteData widening a shared role's floor — see
 * governance-stack.ts's AgentReleaseResolverFunction comment. This test
 * asserts the separation holds for the pointer's own IAM floor too:
 * PutItem/GetItem/Query allowed on the pointer table, DeleteItem never
 * granted anywhere (deleting a pointer would erase deployment history),
 * and — the specific regression this table's write floor must not
 * reintroduce — no statement that grants UpdateItem on the pointer table
 * also names AgentReleasesTable as a resource.
 *
 * Style mirrors backend-stack-agent-releases-table.test.ts: synth a real
 * BackendStack and assert via Template.fromStack(...).
 */

import * as cdk from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import * as path from "path";
import * as fs from "fs";

// Ensure asset directories exist for CDK synthesis (CI + clean-checkout safety).
const assetDirs = [
  path.resolve(__dirname, "../src/schema"),
  path.resolve(__dirname, "../dist/lambda"),
  path.resolve(__dirname, "../../src/lambda/seed-organizations"),
  path.resolve(__dirname, "../src/lambda/seed-admin-user"),
  path.resolve(__dirname, "../src/lambda/seed-organizations"),
];
for (const dir of assetDirs) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

import { BackendStack } from "../lib/backend-stack";

describe("BackendStack — EnvironmentReleasePointersTable (environment release pointer)", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, "TestBackendStackEnvReleasePointers", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    template = Template.fromStack(stack);
  });

  test("has RETAIN removal policy and DeletionProtection enabled", () => {
    template.hasResource("AWS::DynamoDB::Table", {
      Properties: Match.objectLike({
        TableName: "citadel-environment-release-pointers-test",
        DeletionProtectionEnabled: true,
      }),
      DeletionPolicy: "Retain",
      UpdateReplacePolicy: "Retain",
    });
  });

  test("has point-in-time recovery enabled", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "citadel-environment-release-pointers-test",
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });

  test("is PAY_PER_REQUEST billing with orgId HASH / agentTargetId_environment RANGE key", () => {
    template.hasResourceProperties("AWS::DynamoDB::Table", {
      TableName: "citadel-environment-release-pointers-test",
      BillingMode: "PAY_PER_REQUEST",
      KeySchema: [
        { AttributeName: "orgId", KeyType: "HASH" },
        { AttributeName: "agentTargetId_environment", KeyType: "RANGE" },
      ],
    });
  });

  describe("IAM floor — PutItem/GetItem/Query/UpdateItem allowed, DeleteItem never granted", () => {
    function policiesTargeting(tableLogicalIdFragment: string) {
      const policies = template.findResources("AWS::IAM::Policy");
      return Object.values(policies).filter((p) => {
        const stmts = p.Properties?.PolicyDocument?.Statement ?? [];
        return stmts.some((s: { Resource?: unknown }) => {
          const resources = Array.isArray(s.Resource)
            ? s.Resource
            : [s.Resource];
          return resources.some((r: unknown) =>
            JSON.stringify(r).includes(tableLogicalIdFragment),
          );
        });
      });
    }

    test("no IAM policy anywhere grants DeleteItem on EnvironmentReleasePointersTable", () => {
      const policies = policiesTargeting("EnvironmentReleasePointersTable");
      expect(policies.length).toBeGreaterThan(0);

      for (const policy of policies) {
        const stmts = policy.Properties.PolicyDocument.Statement as Array<{
          Action?: string | string[];
          Resource?: unknown;
        }>;
        for (const stmt of stmts) {
          const resources = Array.isArray(stmt.Resource)
            ? stmt.Resource
            : [stmt.Resource];
          const targetsPointerTable = resources.some((r) =>
            JSON.stringify(r).includes("EnvironmentReleasePointersTable"),
          );
          if (!targetsPointerTable) continue;

          const actions = Array.isArray(stmt.Action)
            ? stmt.Action
            : [stmt.Action];
          expect(actions).not.toContain("dynamodb:DeleteItem");
          expect(actions).not.toContain("dynamodb:Scan");
          expect(actions).not.toContain("dynamodb:BatchWriteItem");
        }
      }
    });

    test("the pointer writer role's policy grants PutItem on the pointer table (the move IS a conditional Put, not a separate UpdateItem call — see environment-release-pointer-store.ts)", () => {
      const policies = policiesTargeting("EnvironmentReleasePointersTable");
      const grantsUpdate = policies.some((policy) => {
        const stmts = policy.Properties.PolicyDocument.Statement as Array<{
          Action?: string | string[];
          Resource?: unknown;
        }>;
        return stmts.some((stmt) => {
          const resources = Array.isArray(stmt.Resource)
            ? stmt.Resource
            : [stmt.Resource];
          const targetsPointerTable = resources.some((r) =>
            JSON.stringify(r).includes("EnvironmentReleasePointersTable"),
          );
          if (!targetsPointerTable) return false;
          const actions = Array.isArray(stmt.Action)
            ? stmt.Action
            : [stmt.Action];
          return actions.includes("dynamodb:PutItem");
        });
      });
      expect(grantsUpdate).toBe(true);
    });

    // THE regression this whole slice is delicate about (see module doc
    // comment above and governance-stack.ts's AgentReleaseResolverFunction
    // comment): a prior slice broke this exact way via grantReadWriteData
    // on a shared role. Assert directly that no single IAM statement names
    // BOTH tables as a resource — the pointer's write capability must
    // never be co-granted with the releases table in the same statement,
    // which is how a shared-role grant would leak write access across
    // tables that must stay isolated.
    test("no single IAM statement grants access to both AgentReleasesTable and EnvironmentReleasePointersTable", () => {
      const policies = template.findResources("AWS::IAM::Policy");
      for (const policy of Object.values(policies)) {
        const stmts: Array<{ Action?: string | string[]; Resource?: unknown }> =
          policy.Properties?.PolicyDocument?.Statement ?? [];
        for (const stmt of stmts) {
          const resources = Array.isArray(stmt.Resource)
            ? stmt.Resource
            : [stmt.Resource];
          const asStrings = resources.map((r) => JSON.stringify(r));
          const targetsReleases = asStrings.some((s) =>
            s.includes("AgentReleasesTable"),
          );
          const targetsPointers = asStrings.some((s) =>
            s.includes("EnvironmentReleasePointersTable"),
          );
          expect(targetsReleases && targetsPointers).toBe(false);
        }
      }
    });

    // Mirrors backend-stack-agent-releases-table.test.ts's sibling
    // assertion: reconfirm Slice 1's invariant still holds after this
    // slice adds the pointer table's UpdateItem-carrying role — the
    // releases table itself must still carry zero UpdateItem/DeleteItem
    // anywhere in the synthesized template.
    test("AgentReleasesTable still has zero UpdateItem/DeleteItem grants anywhere (regression: previous slice broke this via grantReadWriteData)", () => {
      const policies = template.findResources("AWS::IAM::Policy");
      for (const policy of Object.values(policies)) {
        const stmts: Array<{ Action?: string | string[]; Resource?: unknown }> =
          policy.Properties?.PolicyDocument?.Statement ?? [];
        for (const stmt of stmts) {
          const resources = Array.isArray(stmt.Resource)
            ? stmt.Resource
            : [stmt.Resource];
          const targetsReleaseTable = resources.some((r) =>
            JSON.stringify(r).includes("AgentReleasesTable"),
          );
          if (!targetsReleaseTable) continue;

          const actions = Array.isArray(stmt.Action)
            ? stmt.Action
            : [stmt.Action];
          expect(actions).not.toContain("dynamodb:UpdateItem");
          expect(actions).not.toContain("dynamodb:DeleteItem");
        }
      }
    });
  });

  // Finding 23971f32 (fail-closed governance ledger recording, verified
  // against live AWS): the resolver Lambda's role had NO statement for
  // citadel-governance-ledger-*. Asserts the fix directly against the
  // REAL synthesized BackendStack (this file's own `template`), which is
  // where environmentReleasePointerWriterRole's policy actually lives.
  describe("environmentReleasePointerWriterRole — governance ledger PutItem grant (finding 23971f32)", () => {
    function policiesTargetingLedgerTable() {
      const policies = template.findResources("AWS::IAM::Policy");
      return Object.values(policies).filter((p) => {
        const stmts = p.Properties?.PolicyDocument?.Statement ?? [];
        return stmts.some((s: { Resource?: unknown }) => {
          const resources = Array.isArray(s.Resource)
            ? s.Resource
            : [s.Resource];
          return resources.some((r: unknown) =>
            JSON.stringify(r).includes("citadel-governance-ledger-test"),
          );
        });
      });
    }

    test("grants dynamodb:PutItem on the deterministic governance ledger table ARN (citadel-governance-ledger-test)", () => {
      const policies = policiesTargetingLedgerTable();
      expect(policies.length).toBeGreaterThan(0);

      const grantsPutItem = policies.some((policy) => {
        const stmts = policy.Properties.PolicyDocument.Statement as Array<{
          Action?: string | string[];
          Resource?: unknown;
        }>;
        return stmts.some((stmt) => {
          const resources = Array.isArray(stmt.Resource)
            ? stmt.Resource
            : [stmt.Resource];
          const targetsLedger = resources.some((r) =>
            JSON.stringify(r).includes("citadel-governance-ledger-test"),
          );
          if (!targetsLedger) return false;
          const actions = Array.isArray(stmt.Action)
            ? stmt.Action
            : [stmt.Action];
          return actions.includes("dynamodb:PutItem");
        });
      });
      expect(grantsPutItem).toBe(true);
    });

    test("no statement targeting the ledger table grants UpdateItem/DeleteItem/BatchWriteItem — PutItem-only, never grantWriteData (rejected twice in prior work)", () => {
      const policies = policiesTargetingLedgerTable();
      expect(policies.length).toBeGreaterThan(0);

      for (const policy of policies) {
        const stmts = policy.Properties.PolicyDocument.Statement as Array<{
          Action?: string | string[];
          Resource?: unknown;
        }>;
        for (const stmt of stmts) {
          const resources = Array.isArray(stmt.Resource)
            ? stmt.Resource
            : [stmt.Resource];
          const targetsLedger = resources.some((r) =>
            JSON.stringify(r).includes("citadel-governance-ledger-test"),
          );
          if (!targetsLedger) continue;

          const actions = Array.isArray(stmt.Action)
            ? stmt.Action
            : [stmt.Action];
          expect(actions).not.toContain("dynamodb:UpdateItem");
          expect(actions).not.toContain("dynamodb:DeleteItem");
          expect(actions).not.toContain("dynamodb:BatchWriteItem");
        }
      }
    });

    test("no single IAM statement grants access to both EnvironmentReleasePointersTable and the governance ledger table", () => {
      const policies = template.findResources("AWS::IAM::Policy");
      for (const policy of Object.values(policies)) {
        const stmts: Array<{
          Action?: string | string[];
          Resource?: unknown;
        }> = policy.Properties?.PolicyDocument?.Statement ?? [];
        for (const stmt of stmts) {
          const resources = Array.isArray(stmt.Resource)
            ? stmt.Resource
            : [stmt.Resource];
          const asStrings = resources.map((r) => JSON.stringify(r));
          const targetsPointers = asStrings.some((s) =>
            s.includes("EnvironmentReleasePointersTable"),
          );
          const targetsLedger = asStrings.some((s) =>
            s.includes("citadel-governance-ledger-test"),
          );
          expect(targetsPointers && targetsLedger).toBe(false);
        }
      }
    });
  });
});

describe("BackendStack — G5/G6 writer-role grants (history table + event bus)", () => {
  let template: Template;

  beforeAll(() => {
    const app = new cdk.App();
    const stack = new BackendStack(app, "TestBackendStackEnvPointerG5G6", {
      environment: "test",
      env: { account: "123456789012", region: "us-east-1" },
    });
    template = Template.fromStack(stack);
  });

  function statementsTargeting(fragment: string) {
    const policies = template.findResources("AWS::IAM::Policy");
    const out: Array<{ Action?: string | string[]; Resource?: unknown }> = [];
    for (const policy of Object.values(policies)) {
      const stmts: Array<{ Action?: string | string[]; Resource?: unknown }> =
        policy.Properties?.PolicyDocument?.Statement ?? [];
      for (const stmt of stmts) {
        const resources = Array.isArray(stmt.Resource)
          ? stmt.Resource
          : [stmt.Resource];
        if (resources.some((r) => JSON.stringify(r).includes(fragment))) {
          out.push(stmt);
        }
      }
    }
    return out;
  }

  test("G6: writer role grants PutItem/GetItem/Query on the history table (deterministic ARN), never Update/Delete", () => {
    const stmts = statementsTargeting(
      "citadel-environment-release-pointer-history-test",
    );
    expect(stmts.length).toBeGreaterThan(0);

    const actions = new Set<string>();
    for (const stmt of stmts) {
      for (const a of Array.isArray(stmt.Action)
        ? stmt.Action
        : [stmt.Action]) {
        if (typeof a === "string") actions.add(a);
      }
    }
    expect(actions.has("dynamodb:PutItem")).toBe(true);
    expect(actions.has("dynamodb:GetItem")).toBe(true);
    expect(actions.has("dynamodb:Query")).toBe(true);
    expect(actions.has("dynamodb:UpdateItem")).toBe(false);
    expect(actions.has("dynamodb:DeleteItem")).toBe(false);
    expect(actions.has("dynamodb:BatchWriteItem")).toBe(false);
  });

  test("G5: writer role is granted events:PutEvents (for the best-effort RELEASE_POINTER_MOVED emit)", () => {
    const policies = template.findResources("AWS::IAM::Policy");
    const grantsPutEvents = Object.values(policies).some((policy) => {
      const stmts: Array<{ Action?: string | string[] }> =
        policy.Properties?.PolicyDocument?.Statement ?? [];
      return stmts.some((stmt) => {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        return actions.includes("events:PutEvents");
      });
    });
    expect(grantsPutEvents).toBe(true);
  });
});
