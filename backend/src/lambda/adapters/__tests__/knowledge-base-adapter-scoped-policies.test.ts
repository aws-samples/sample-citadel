/**
 * CIT-299: Knowledge-base-adapter connect policies must be scoped to the
 * datastore's own knowledge base and collection — no `/*` wildcards.
 * Also validates that connect rejects when IDs are missing.
 */
import { KnowledgeBaseAdapter } from "../knowledge-base-adapter";
import { ConnectionError } from "../errors";
import { getAdapter } from "../registry";

describe("KnowledgeBaseAdapter — CIT-299 scoped connect policies", () => {
  const adapter = new KnowledgeBaseAdapter();

  it("requiredPolicies scopes bedrock to specific knowledgeBaseId", () => {
    const policies = adapter.requiredPolicies(
      { knowledgeBaseId: "KB12345", collectionId: "col-abc" },
      "123456789012",
      "us-east-1",
    );

    const bedrockStmt = policies.connect.find((s) =>
      s.actions.some((a) => a.startsWith("bedrock:")),
    );
    expect(bedrockStmt).toBeDefined();
    expect(bedrockStmt!.resources).toEqual([
      "arn:aws:bedrock:us-east-1:123456789012:knowledge-base/KB12345",
    ]);
    // No wildcard in any resource
    for (const r of bedrockStmt!.resources) {
      expect(r).not.toContain("/*");
      expect(r).not.toBe("*");
    }
  });

  it("requiredPolicies scopes aoss to specific collectionId", () => {
    const policies = adapter.requiredPolicies(
      { knowledgeBaseId: "KB12345", collectionId: "col-abc" },
      "123456789012",
      "us-east-1",
    );

    const aossStmt = policies.connect.find((s) =>
      s.actions.some((a) => a.startsWith("aoss:")),
    );
    expect(aossStmt).toBeDefined();
    expect(aossStmt!.resources).toEqual([
      "arn:aws:aoss:us-east-1:123456789012:collection/col-abc",
    ]);
    for (const r of aossStmt!.resources) {
      expect(r).not.toContain("/*");
      expect(r).not.toBe("*");
    }
  });

  it("requiredPolicies returns empty connect when knowledgeBaseId is missing", () => {
    const policies = adapter.requiredPolicies(
      { collectionId: "col-abc" },
      "123456789012",
      "us-east-1",
    );
    expect(policies.connect).toEqual([]);
  });

  it("requiredPolicies returns empty connect when collectionId is missing", () => {
    const policies = adapter.requiredPolicies(
      { knowledgeBaseId: "KB12345" },
      "123456789012",
      "us-east-1",
    );
    expect(policies.connect).toEqual([]);
  });

  it("connect rejects when collectionId is missing in config", async () => {
    await expect(
      adapter.connect({ knowledgeBaseId: "KB12345" }),
    ).rejects.toThrow(ConnectionError);
    await expect(
      adapter.connect({ knowledgeBaseId: "KB12345" }),
    ).rejects.toThrow(/requires both knowledgeBaseId and collectionId/);
  });

  it("connect rejects when knowledgeBaseId is missing in config", async () => {
    await expect(adapter.connect({ collectionId: "col-abc" })).rejects.toThrow(
      ConnectionError,
    );
  });
});

describe("no-wildcard guard — bedrock/aoss resource ARNs", () => {
  const SCOPED_ADAPTERS: Array<{
    type: string;
    config: Record<string, unknown>;
  }> = [
    {
      type: "KNOWLEDGE_BASE",
      config: { knowledgeBaseId: "KB12345", collectionId: "col-abc" },
    },
  ];

  for (const { type, config } of SCOPED_ADAPTERS) {
    it(`${type} adapter does not grant bedrock/aoss actions on bare '*' or '/*' resource`, () => {
      const a = getAdapter(type);
      const policies = a.requiredPolicies(config, "123456789012", "us-east-1");
      const allStatements = [...policies.provision, ...policies.connect];

      for (const stmt of allStatements) {
        const hasBedrock = stmt.actions.some(
          (a) => /^bedrock:/i.test(a) || /^aoss:/i.test(a),
        );
        if (hasBedrock) {
          for (const r of stmt.resources) {
            expect(r).not.toBe("*");
            expect(r).not.toMatch(/\/\*$/);
          }
        }
      }
    });
  }
});
