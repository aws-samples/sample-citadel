/**
 * Tests for agent-code-key.ts — CIT-254 SH-4.
 *
 * Table-driven vectors: valid filenames, path traversal, control chars,
 * percent-encoding tricks, leading/trailing slashes, empty inputs.
 * Covers both the legacy resolveAgentCodeKey and the new
 * resolveRecordScopedAgentCodeKey.
 */

import {
  resolveAgentCodeKey,
  resolveRecordScopedAgentCodeKey,
  AgentCodeKeyError,
} from "../agent-code-key";

describe("resolveAgentCodeKey", () => {
  const AGENT_ID = "fatigue_risk_scoring_agent";

  // ---------------------------------------------------------------------------
  // Accepts
  // ---------------------------------------------------------------------------

  const accepts: Array<{
    label: string;
    agentId: string;
    filename?: string;
    expected: string;
  }> = [
    {
      label: "simple Python file",
      agentId: AGENT_ID,
      filename: "my_agent.py",
      expected: "agents/my_agent.py",
    },
    {
      label: "subdirectory/file",
      agentId: AGENT_ID,
      filename: "arbiter-agent/arbiter_agent.py",
      expected: "agents/arbiter-agent/arbiter_agent.py",
    },
    {
      label: "versioned file",
      agentId: AGENT_ID,
      filename: "my_agent_v1.py",
      expected: "agents/my_agent_v1.py",
    },
    {
      label: "undefined filename defaults to agentId.py",
      agentId: AGENT_ID,
      filename: undefined,
      expected: `agents/${AGENT_ID}.py`,
    },
    {
      label: "empty string filename defaults to agentId.py",
      agentId: AGENT_ID,
      filename: "",
      expected: `agents/${AGENT_ID}.py`,
    },
  ];

  it.each(accepts)("accepts: $label", ({ agentId, filename, expected }) => {
    expect(resolveAgentCodeKey(agentId, filename)).toBe(expected);
  });

  // ---------------------------------------------------------------------------
  // Rejects
  // ---------------------------------------------------------------------------

  const rejections: Array<{
    label: string;
    agentId: string;
    filename: string;
  }> = [
    {
      label: "path traversal ../../etc/passwd",
      agentId: AGENT_ID,
      filename: "../../etc/passwd",
    },
    {
      label: "path traversal ../tools/secret.py",
      agentId: AGENT_ID,
      filename: "../tools/secret.py",
    },
    {
      label: "leading slash",
      agentId: AGENT_ID,
      filename: "/etc/passwd",
    },
    {
      label: "double slash",
      agentId: AGENT_ID,
      filename: "foo//bar.py",
    },
    {
      label: "trailing slash",
      agentId: AGENT_ID,
      filename: "my_agent/",
    },
    {
      label: "control character (null byte)",
      agentId: AGENT_ID,
      filename: "my_agent\x00.py",
    },
    {
      label: "percent-encoded traversal",
      agentId: AGENT_ID,
      filename: "%2e%2e/tools/secret.py",
    },
    {
      label: "percent-encoded null",
      agentId: AGENT_ID,
      filename: "agent%00.py",
    },
  ];

  it.each(rejections)("rejects: $label", ({ agentId, filename }) => {
    expect(() => resolveAgentCodeKey(agentId, filename)).toThrow(
      AgentCodeKeyError,
    );
  });

  it("rejects empty agentId", () => {
    expect(() => resolveAgentCodeKey("", "file.py")).toThrow(AgentCodeKeyError);
  });

  it("resulting key always starts with agents/", () => {
    const key = resolveAgentCodeKey(AGENT_ID, "sub/file.py");
    expect(key.startsWith("agents/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveRecordScopedAgentCodeKey
// ---------------------------------------------------------------------------

describe("resolveRecordScopedAgentCodeKey", () => {
  const RECORD_ID = "rec-abc-123";

  // ---------------------------------------------------------------------------
  // Accepts
  // ---------------------------------------------------------------------------

  const accepts: Array<{
    label: string;
    recordId: string;
    filename?: string;
    expectedScoped: string;
    expectedLegacy: string;
    expectedBasename: string;
  }> = [
    {
      label: "simple Python file",
      recordId: RECORD_ID,
      filename: "my_agent.py",
      expectedScoped: `agents/${RECORD_ID}/my_agent.py`,
      expectedLegacy: "agents/my_agent.py",
      expectedBasename: "my_agent.py",
    },
    {
      label: "subdirectory/file extracts basename only",
      recordId: RECORD_ID,
      filename: "arbiter-agent/arbiter_agent.py",
      expectedScoped: `agents/${RECORD_ID}/arbiter_agent.py`,
      expectedLegacy: "agents/arbiter_agent.py",
      expectedBasename: "arbiter_agent.py",
    },
    {
      label: "versioned file",
      recordId: RECORD_ID,
      filename: "my_agent_v1.py",
      expectedScoped: `agents/${RECORD_ID}/my_agent_v1.py`,
      expectedLegacy: "agents/my_agent_v1.py",
      expectedBasename: "my_agent_v1.py",
    },
    {
      label: "undefined filename defaults to recordId.py",
      recordId: RECORD_ID,
      filename: undefined,
      expectedScoped: `agents/${RECORD_ID}/${RECORD_ID}.py`,
      expectedLegacy: `agents/${RECORD_ID}.py`,
      expectedBasename: `${RECORD_ID}.py`,
    },
    {
      label: "empty string filename defaults to recordId.py",
      recordId: RECORD_ID,
      filename: "",
      expectedScoped: `agents/${RECORD_ID}/${RECORD_ID}.py`,
      expectedLegacy: `agents/${RECORD_ID}.py`,
      expectedBasename: `${RECORD_ID}.py`,
    },
  ];

  it.each(accepts)(
    "accepts: $label",
    ({
      recordId,
      filename,
      expectedScoped,
      expectedLegacy,
      expectedBasename,
    }) => {
      const result = resolveRecordScopedAgentCodeKey(recordId, filename);
      expect(result.scopedKey).toBe(expectedScoped);
      expect(result.legacyKey).toBe(expectedLegacy);
      expect(result.basename).toBe(expectedBasename);
    },
  );

  // ---------------------------------------------------------------------------
  // Rejects — traversal and control chars
  // ---------------------------------------------------------------------------

  const rejections: Array<{
    label: string;
    recordId: string;
    filename: string;
  }> = [
    {
      label: "path traversal ../../etc/passwd",
      recordId: RECORD_ID,
      filename: "../../etc/passwd",
    },
    {
      label: "path traversal ../tools/secret.py",
      recordId: RECORD_ID,
      filename: "../tools/secret.py",
    },
    {
      label: "leading slash",
      recordId: RECORD_ID,
      filename: "/etc/passwd",
    },
    {
      label: "double slash",
      recordId: RECORD_ID,
      filename: "foo//bar.py",
    },
    {
      label: "trailing slash",
      recordId: RECORD_ID,
      filename: "my_agent/",
    },
    {
      label: "control character (null byte)",
      recordId: RECORD_ID,
      filename: "my_agent\x00.py",
    },
    {
      label: "percent-encoded traversal",
      recordId: RECORD_ID,
      filename: "%2e%2e/tools/secret.py",
    },
    {
      label: "percent-encoded null",
      recordId: RECORD_ID,
      filename: "agent%00.py",
    },
  ];

  it.each(rejections)("rejects: $label", ({ recordId, filename }) => {
    expect(() => resolveRecordScopedAgentCodeKey(recordId, filename)).toThrow(
      AgentCodeKeyError,
    );
  });

  // ---------------------------------------------------------------------------
  // Rejects — recordId validation
  // ---------------------------------------------------------------------------

  it("rejects empty recordId", () => {
    expect(() => resolveRecordScopedAgentCodeKey("", "file.py")).toThrow(
      AgentCodeKeyError,
    );
  });

  it("rejects recordId with path traversal", () => {
    expect(() =>
      resolveRecordScopedAgentCodeKey("../other", "file.py"),
    ).toThrow(AgentCodeKeyError);
  });

  it("rejects recordId with slash", () => {
    expect(() =>
      resolveRecordScopedAgentCodeKey("other/sub", "file.py"),
    ).toThrow(AgentCodeKeyError);
  });

  it("rejects recordId with control characters", () => {
    expect(() =>
      resolveRecordScopedAgentCodeKey("rec\x00id", "file.py"),
    ).toThrow(AgentCodeKeyError);
  });

  // ---------------------------------------------------------------------------
  // Sibling-record isolation
  // ---------------------------------------------------------------------------

  it("sibling-record filename is stripped to basename and scoped to caller's record", () => {
    // If config.filename is "other-record/agent.py", the basename "agent.py"
    // is extracted and scoped under the calling record's prefix.
    const result = resolveRecordScopedAgentCodeKey(
      "my-record",
      "other-record/agent.py",
    );
    expect(result.scopedKey).toBe("agents/my-record/agent.py");
    expect(result.legacyKey).toBe("agents/agent.py");
    expect(result.basename).toBe("agent.py");
  });

  // ---------------------------------------------------------------------------
  // Key structure invariants
  // ---------------------------------------------------------------------------

  it("scoped key always starts with agents/{recordId}/", () => {
    const result = resolveRecordScopedAgentCodeKey(RECORD_ID, "file.py");
    expect(result.scopedKey.startsWith(`agents/${RECORD_ID}/`)).toBe(true);
  });

  it("legacy key always starts with agents/", () => {
    const result = resolveRecordScopedAgentCodeKey(RECORD_ID, "file.py");
    expect(result.legacyKey.startsWith("agents/")).toBe(true);
  });

  it("legacy key never contains the recordId as a path component", () => {
    const result = resolveRecordScopedAgentCodeKey(RECORD_ID, "file.py");
    expect(result.legacyKey).toBe("agents/file.py");
    expect(result.legacyKey).not.toContain(RECORD_ID);
  });
});
