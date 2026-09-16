/**
 * Tests for task-runner-resolver Lambda
 *
 * Tenancy fix (finding 87a171ad, high): submitTask previously destructured
 * only `info`/`arguments` and NEVER read `event.identity` — any
 * authenticated Cognito caller of ANY organisation could trigger Supervisor
 * orchestration with no tenancy anywhere on the emitted `task.request`
 * detail. The fix derives the organisation SERVER-SIDE from the caller via
 * `requireEffectiveOrgId` (reused from datastore-resolver.ts /
 * integration-resolver.ts — see the resolver's own comment for why this
 * was chosen over `resolveOrgId`) and stamps it on the detail. Never
 * accepted from client input — `SubmitTaskInput` has no `orgId` field to
 * begin with (schema.graphql), so there is nothing to strip; this suite
 * proves the org is derived purely from `event.identity`.
 */
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { mockClient } from "aws-sdk-client-mock";

const eventBridgeMock = mockClient(EventBridgeClient);

// Set env before import
process.env.AGENT_EVENT_BUS_NAME = "test-event-bus";

jest.mock("../../utils/auth-event", () => ({
  extractOrgFromEvent: jest.fn(),
}));

import { handler } from "../task-runner-resolver";
import { extractOrgFromEvent } from "../../utils/auth-event";

const mockExtractOrgFromEvent = extractOrgFromEvent as jest.MockedFunction<
  typeof extractOrgFromEvent
>;

describe("task-runner-resolver", () => {
  beforeEach(() => {
    eventBridgeMock.reset();
    mockExtractOrgFromEvent.mockReset();
  });

  const makeEvent = (
    fieldName: string,
    args: Record<string, unknown>,
    identity: Record<string, unknown> | null = { sub: "user-1" },
  ) => ({
    info: { fieldName },
    arguments: args,
    identity,
  });

  describe("submitTask", () => {
    test("publishes event to EventBridge and returns orchestrationId", async () => {
      mockExtractOrgFromEvent.mockResolvedValue("org-alpha");
      eventBridgeMock.on(PutEventsCommand).resolves({});

      const result = await handler(
        makeEvent("submitTask", {
          input: { taskDetails: "Build a new feature" },
        }),
      );

      expect(result.success).toBe(true);
      expect(result.orchestrationId).toBeDefined();
      expect(result.message).toContain("successfully");

      const calls = eventBridgeMock.commandCalls(PutEventsCommand);
      expect(calls).toHaveLength(1);
      const entry = calls[0].args[0].input.Entries![0];
      expect(entry.Source).toBe("task.request");
      expect(entry.EventBusName).toBe("test-event-bus");
      const detail = JSON.parse(entry.Detail!);
      expect(detail.task).toBe("Build a new feature");
    });

    test("includes callback in event detail when provided", async () => {
      mockExtractOrgFromEvent.mockResolvedValue("org-alpha");
      eventBridgeMock.on(PutEventsCommand).resolves({});

      const result = await handler(
        makeEvent("submitTask", {
          input: {
            taskDetails: "Task with callback",
            callback: { type: "eventbridge", source: "test" },
          },
        }),
      );

      expect(result.success).toBe(true);
      const detail = JSON.parse(
        eventBridgeMock.commandCalls(PutEventsCommand)[0].args[0].input
          .Entries![0].Detail!,
      );
      expect(detail.callback).toEqual({ type: "eventbridge", source: "test" });
    });

    test("throws when EventBridge fails", async () => {
      mockExtractOrgFromEvent.mockResolvedValue("org-alpha");
      eventBridgeMock.on(PutEventsCommand).rejects(new Error("EB down"));

      await expect(
        handler(makeEvent("submitTask", { input: { taskDetails: "fail" } })),
      ).rejects.toThrow("Failed to submit task");
    });

    describe("tenancy (finding 87a171ad)", () => {
      test("stamps detail.orgId with the SERVER-DERIVED organisation from event.identity", async () => {
        mockExtractOrgFromEvent.mockResolvedValue("org-derived-from-caller");
        eventBridgeMock.on(PutEventsCommand).resolves({});

        await handler(
          makeEvent("submitTask", {
            input: { taskDetails: "tenant scoped task" },
          }),
        );

        expect(mockExtractOrgFromEvent).toHaveBeenCalledTimes(1);
        const [calledWithEvent] = mockExtractOrgFromEvent.mock.calls[0];
        expect((calledWithEvent as { identity: unknown }).identity).toEqual({
          sub: "user-1",
        });

        const detail = JSON.parse(
          eventBridgeMock.commandCalls(PutEventsCommand)[0].args[0].input
            .Entries![0].Detail!,
        );
        expect(detail.orgId).toBe("org-derived-from-caller");
      });

      test("fails closed (throws, no EventBridge publish) when no organisation resolves", async () => {
        mockExtractOrgFromEvent.mockResolvedValue(null);

        await expect(
          handler(
            makeEvent("submitTask", { input: { taskDetails: "orphan task" } }),
          ),
        ).rejects.toThrow();

        expect(eventBridgeMock.commandCalls(PutEventsCommand)).toHaveLength(0);
      });

      test("never reads an orgId from client input — SubmitTaskInput has no such field, and any extra key on a wider payload is ignored in favor of the server-derived value", async () => {
        mockExtractOrgFromEvent.mockResolvedValue("org-server-side");
        eventBridgeMock.on(PutEventsCommand).resolves({});

        await handler(
          makeEvent("submitTask", {
            // Simulates a client attempting to smuggle an orgId in a wider
            // payload shape than SubmitTaskInput declares.
            input: {
              taskDetails: "spoof attempt",
              orgId: "org-attacker-supplied",
            },
          }),
        );

        const detail = JSON.parse(
          eventBridgeMock.commandCalls(PutEventsCommand)[0].args[0].input
            .Entries![0].Detail!,
        );
        expect(detail.orgId).toBe("org-server-side");
      });
    });
  });

  test("throws on unknown field", async () => {
    await expect(handler(makeEvent("unknownField", {}))).rejects.toThrow(
      "Unknown field",
    );
  });
});
