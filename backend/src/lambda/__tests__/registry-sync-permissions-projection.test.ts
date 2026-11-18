/**
 * PR-5 Workstream 6: registry-sync projects requiredPermissions and
 * credentialMode from the descriptor config into the DDB cache row.
 */
import { buildAgentCacheRecord, coerceAgentConfig } from "../registry-sync";

describe("registry-sync permissions projection (PR-5)", () => {
  test("agent record with requiredPermissions in config is projected", () => {
    const meta = {
      config: {
        name: "test-agent",
        filename: "test.py",
        requiredPermissions: {
          models: ["model-1"],
          dataStores: [],
          integrations: [],
        },
      },
      categories: [],
      icon: "",
      state: "active",
    };
    const row = buildAgentCacheRecord("rec-1", {
      description: "Test agent",
      customDescriptorContent: JSON.stringify(meta),
    });
    expect(row.config).toBeDefined();
    expect(row.config!.requiredPermissions).toEqual({
      models: ["model-1"],
      dataStores: [],
      integrations: [],
    });
  });

  test("agent record with credentialMode: none in config is projected", () => {
    const meta = {
      config: {
        name: "echo-agent",
        filename: "echo.py",
        credentialMode: "none",
      },
      categories: [],
      icon: "",
      state: "active",
    };
    const row = buildAgentCacheRecord("rec-1", {
      description: "Echo agent",
      customDescriptorContent: JSON.stringify(meta),
    });
    expect(row.config).toBeDefined();
    expect(row.config!.credentialMode).toBe("none");
  });

  test("coerceAgentConfig preserves requiredPermissions and credentialMode", () => {
    const rawConfig = {
      name: "test",
      requiredPermissions: { models: ["m1"] },
      credentialMode: "scoped",
    };
    const result = coerceAgentConfig("rec-1", rawConfig);
    expect(result).toBeDefined();
    expect(result!.requiredPermissions).toEqual({ models: ["m1"] });
    expect(result!.credentialMode).toBe("scoped");
  });
});
