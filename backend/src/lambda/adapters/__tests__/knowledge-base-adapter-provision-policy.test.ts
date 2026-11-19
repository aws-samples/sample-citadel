/**
 * Continuum C3 (PR-2) supersedes the H4 §3d contract this file originally
 * tested: `.provision` is no longer minted onto any tenant-assumable role
 * (the resolver mints ONLY `.connect`, post-provision, from concrete
 * ARNs — see datastore-resolver.ts and the tenant-role-no-wildcard-
 * destructive.guard.test.ts invariant). `.provision` is retained purely as
 * CDK-mirrored documentation of the platform Lambda's own control-plane
 * grant shape (backend-stack.ts) — it is never passed to
 * PolicyManager.ensureRole.
 *
 * What changed from the pre-PR-2 contract:
 *   - bedrock:CreateKnowledgeBase now ACTUALLY RUNS under
 *     platformBedrockProvisionClient() (ambient Lambda credentials),
 *     constrained by the resolver Lambda's own IAM policy — `.provision`
 *     still documents the statement shape (CDK-mirrored), but it is never
 *     minted onto a tenant role, so the statement's practical effect is
 *     gone even though it remains in the returned array.
 *   - aoss:APIAccessAll was removed from `.provision` (it was there only
 *     to support the no-longer-existing provision-time role vend; the
 *     real aoss:APIAccessAll grant lives in `.connect`, scoped to the
 *     concrete collection ARN, which IS minted onto the tenant role).
 *   - iam:PassRole for the KB service role remains, documenting the
 *     platform Lambda's CreateKnowledgeBase call, which still needs to
 *     pass that role to Bedrock.
 */
import { KnowledgeBaseAdapter } from "../knowledge-base-adapter";

describe("KnowledgeBaseAdapter.requiredPolicies — provision is documentation-only (Continuum C3)", () => {
  const adapter = new KnowledgeBaseAdapter();

  it("still documents bedrock:CreateKnowledgeBase in provision (platform-grant shape, never minted onto citadel-ds-<id>)", () => {
    const policies = adapter.requiredPolicies(
      { dataStoreId: "ds-1", orgId: "org-1" },
      "123456789012",
      "us-east-1",
    );
    const createStmt = policies.provision.find((s) =>
      s.actions.includes("bedrock:CreateKnowledgeBase"),
    );
    // `.provision` is CDK-mirrored documentation of the platform Lambda's
    // own grant (backend-stack.ts) — it still lists the create-verb, but
    // the resolver (datastore-resolver.ts) never mints `.provision` onto
    // any role; only `.connect` is ever passed to PolicyManager.ensureRole.
    expect(createStmt).toBeDefined();
  });

  it("does NOT include aoss:APIAccessAll in provision (only connect carries it, scoped to a concrete collection)", () => {
    const policies = adapter.requiredPolicies(
      { dataStoreId: "ds-1", orgId: "org-1" },
      "123456789012",
      "us-east-1",
    );
    const aossStmt = policies.provision.find((s) =>
      s.actions.includes("aoss:APIAccessAll"),
    );
    expect(aossStmt).toBeUndefined();
  });

  it("includes iam:PassRole scoped to the id-derived service role ARN (documentation of the platform call)", () => {
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

  it("falls back to empty provision policies when dataStoreId is absent", () => {
    const policies = adapter.requiredPolicies({}, "123456789012", "us-east-1");
    expect(policies.provision).toEqual([]);
  });

  it("provision policies are never passed to PolicyManager.ensureRole (invariant enforced separately)", () => {
    // See test/tenant-role-no-wildcard-destructive.guard.test.ts and
    // src/lambda/__tests__/datastore-resolver-provision-platform-path.test.ts
    // for the machine-enforced versions of this invariant.
    const policies = adapter.requiredPolicies(
      { dataStoreId: "ds-1", orgId: "org-1" },
      "123456789012",
      "us-east-1",
    );
    expect(policies.connect).toBeDefined();
  });
});
