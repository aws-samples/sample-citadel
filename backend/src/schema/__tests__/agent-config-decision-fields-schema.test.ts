/**
 * Schema contract for AgentConfig approval-decision fields (additive, READ-only).
 *
 * Mirrors the decidedBy / decidedAt / statusReason triple already present on
 * ToolConfig — surfaced so the catalog can display who approved/rejected an
 * agent record and why.
 */
import { readFileSync } from "fs";
import { join } from "path";

/** Extract the `type AgentConfig { ... }` block (no nested braces). */
function agentConfigBlock(): string {
  const schema = readFileSync(join(__dirname, "..", "schema.graphql"), "utf8");
  const match = schema.match(/type AgentConfig \{[^}]*\}/);
  if (!match) {
    throw new Error("type AgentConfig not found in schema.graphql");
  }
  return match[0];
}

describe("schema.graphql AgentConfig decision fields", () => {
  it("exposes decidedBy: String", () => {
    expect(agentConfigBlock()).toMatch(/\bdecidedBy:\s*String\b/);
  });

  it("exposes decidedAt: AWSDateTime", () => {
    expect(agentConfigBlock()).toMatch(/\bdecidedAt:\s*AWSDateTime\b/);
  });

  it("exposes statusReason: String", () => {
    expect(agentConfigBlock()).toMatch(/\bstatusReason:\s*String\b/);
  });
});
