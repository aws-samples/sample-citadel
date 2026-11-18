/**
 * Citadel PR-1 — H4 (§3d): KnowledgeBaseAdapter.requiredPolicies must
 * return a NON-EMPTY `provision` policy list so the resolver always mints
 * and vends a scoped role on the KB create path. Before this fix,
 * `provision: []` meant `scopedCredentials` stayed `undefined` in
 * datastore-resolver.ts, and `dispatchCreds` (or, before that, the removed
 * `scopedCredentials || credentials` fallback) would otherwise have no
 * scoped credential to dispatch for an IAM_ROLE adapter.
 *
 * Scope boundary (explicitly NOT addressed here, tracked as C3): the
 * create-verb `bedrock:CreateKnowledgeBase` grant is necessarily `*` —
 * the resource doesn't exist yet — identical in shape to the already
 * accepted `s3:CreateBucket` wildcard in S3Adapter.
 */
import { KnowledgeBaseAdapter } from "../knowledge-base-adapter";

describe("KnowledgeBaseAdapter.requiredPolicies — non-empty provision policy (H4 §3d)", () => {
  const adapter = new KnowledgeBaseAdapter();

  it("provision policies are non-empty when dataStoreId/orgId are present in config", () => {
    const policies = adapter.requiredPolicies(
      { dataStoreId: "ds-1", orgId: "org-1" },
      "123456789012",
      "us-east-1",
    );
    expect(policies.provision.length).toBeGreaterThan(0);
  });

  it("includes a create-verb bedrock:CreateKnowledgeBase statement (necessarily wildcard-scoped — C3 follow-up)", () => {
    const policies = adapter.requiredPolicies(
      { dataStoreId: "ds-1", orgId: "org-1" },
      "123456789012",
      "us-east-1",
    );
    const createStmt = policies.provision.find((s) =>
      s.actions.includes("bedrock:CreateKnowledgeBase"),
    );
    expect(createStmt).toBeDefined();
  });

  it("includes iam:PassRole scoped to the id-derived service role ARN", () => {
    const policies = adapter.requiredPolicies(
      { dataStoreId: "ds-1", orgId: "org-1" },
      "123456789012",
      "us-east-1",
    );
    const passRoleStmt = policies.provision.find((s) =>
      s.actions.includes("iam:PassRole"),
    );
    expect(passRoleStmt).toBeDefined();
    expect(passRoleStmt!.resources).toEqual([
      "arn:aws:iam::123456789012:role/citadel-ds-kb-svc-ds-1",
    ]);
  });

  it("includes aoss:APIAccessAll scoped to the id-derived collection ARN", () => {
    const policies = adapter.requiredPolicies(
      { dataStoreId: "ds-1", orgId: "org-1" },
      "123456789012",
      "us-east-1",
    );
    const aossStmt = policies.provision.find((s) =>
      s.actions.includes("aoss:APIAccessAll"),
    );
    expect(aossStmt).toBeDefined();
    expect(aossStmt!.resources[0]).toMatch(
      /^arn:aws:aoss:us-east-1:123456789012:collection\/aifkb-/,
    );
  });

  it("two different dataStoreIds derive different PassRole/collection ARNs (no cross-tenant collision)", () => {
    const policiesA = adapter.requiredPolicies(
      { dataStoreId: "ds-aaaa", orgId: "org-1" },
      "123456789012",
      "us-east-1",
    );
    const policiesB = adapter.requiredPolicies(
      { dataStoreId: "ds-bbbb", orgId: "org-1" },
      "123456789012",
      "us-east-1",
    );
    const passRoleA = policiesA.provision.find((s) =>
      s.actions.includes("iam:PassRole"),
    )!.resources[0];
    const passRoleB = policiesB.provision.find((s) =>
      s.actions.includes("iam:PassRole"),
    )!.resources[0];
    expect(passRoleA).not.toBe(passRoleB);
  });

  it("falls back to empty provision policies when dataStoreId/orgId are absent (nothing safe to scope yet)", () => {
    const policies = adapter.requiredPolicies({}, "123456789012", "us-east-1");
    expect(policies.provision).toEqual([]);
  });
});
