/**
 * Tests for chatter-resolver's orgId passthrough (wave-2a tenancy fix,
 * finding 87a171ad section A).
 *
 * chatter-resolver.ts is the `publishChatter` mutation resolver — it must
 * include `orgId` on the returned `AgentChatterMessage` (required for
 * AppSync's implicit `onChatter(orgId: ID!)` subscription filter to have
 * anything to filter on) and must refuse to publish when the input lacks
 * orgId — fail closed, never emit chatter without orgId.
 */
import { AppSyncResolverEvent } from "aws-lambda";
import { handler, AgentChatterInput } from "../chatter-resolver";

function baseInput(
  overrides: Partial<AgentChatterInput> = {},
): AgentChatterInput {
  return {
    id: "evt-1",
    timestamp: "2024-01-01T00:00:00Z",
    source: "supervisor",
    detailType: "chatter",
    detail: { foo: "bar" },
    orgId: "org-alpha",
    ...overrides,
  };
}

describe("chatter-resolver", () => {
  it("passes orgId through onto the returned message", async () => {
    const event = {
      arguments: { input: baseInput() },
    } as AppSyncResolverEvent<{ input: AgentChatterInput }>;

    const result = await handler(event);

    expect(result.orgId).toBe("org-alpha");
  });

  it("refuses to publish (throws) when orgId is missing from the input", async () => {
    const input = baseInput();
    delete (input as Partial<AgentChatterInput>).orgId;
    const event = {
      arguments: { input },
    } as AppSyncResolverEvent<{ input: AgentChatterInput }>;

    await expect(handler(event)).rejects.toThrow();
  });

  it("refuses to publish (throws) when orgId is an empty string", async () => {
    const event = {
      arguments: { input: baseInput({ orgId: "" }) },
    } as AppSyncResolverEvent<{ input: AgentChatterInput }>;

    await expect(handler(event)).rejects.toThrow();
  });
});
