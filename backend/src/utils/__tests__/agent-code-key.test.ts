/**
 * Tests for agent-code-key.ts — CIT-254 SH-4.
 *
 * Table-driven vectors: valid filenames, path traversal, control chars,
 * percent-encoding tricks, leading/trailing slashes, empty inputs.
 */

import { resolveAgentCodeKey, AgentCodeKeyError } from "../agent-code-key";

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
