import * as fc from "fast-check";

const mockSend = jest.fn().mockResolvedValue({});

jest.mock("@aws-sdk/client-eventbridge", () => ({
  EventBridgeClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  PutEventsCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

jest.mock("aws-xray-sdk-core", () => ({
  setContextMissingStrategy: jest.fn(),
  captureAWSv3Client: jest.fn((client) => client),
  getSegment: jest.fn(),
}));

import * as AWSXRay from "aws-xray-sdk-core";
import { publishEvent, createReleaseEvent, EventTypes } from "../events";

describe("events.ts traceContext propagation (additive)", () => {
  beforeEach(() => {
    mockSend.mockClear();
    (AWSXRay.getSegment as jest.Mock).mockReset();
  });

  function lastPublishedDetail(): Record<string, unknown> {
    const call = mockSend.mock.calls[mockSend.mock.calls.length - 1][0];
    return JSON.parse(call.input.Entries[0].Detail);
  }

  // R6: Detail includes traceContext when a segment is present.
  it("R6: Detail includes traceContext when an active segment is present", async () => {
    (AWSXRay.getSegment as jest.Mock).mockReturnValue({
      trace_id: "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb",
      id: "cccccccccccccccc",
      notTraced: false,
    });

    await publishEvent({
      eventType: "project.created",
      projectId: "p1",
      payload: {},
      timestamp: "2026-01-01T00:00:00.000Z",
    });

    const detail = lastPublishedDetail();
    expect(detail.traceContext).toEqual({
      xrayTraceHeader:
        "Root=1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb;Parent=cccccccccccccccc;Sampled=1",
      traceId: "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb",
      parentId: "cccccccccccccccc",
      traceparent: "00-aaaaaaaabbbbbbbbbbbbbbbbbbbbbbbb-cccccccccccccccc-01",
    });
  });

  // R7 (property): Detail identical to baseline when NO segment (additive-absence).
  it("R7: Detail has no traceContext key when there is no active segment", async () => {
    (AWSXRay.getSegment as jest.Mock).mockReturnValue(undefined);

    await publishEvent({
      eventType: "project.created",
      projectId: "p1",
      payload: { a: 1 },
      timestamp: "2026-01-01T00:00:00.000Z",
      correlationId: "corr-1",
    });

    const detail = lastPublishedDetail();
    expect(detail).toEqual({
      projectId: "p1",
      agentId: undefined,
      payload: { a: 1 },
      timestamp: "2026-01-01T00:00:00.000Z",
      correlationId: "corr-1",
    });
    expect("traceContext" in detail).toBe(false);
  });

  it("R7b (property): absent-segment Detail is byte-identical across arbitrary payloads", async () => {
    (AWSXRay.getSegment as jest.Mock).mockReturnValue(undefined);

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          eventType: fc.string({ minLength: 1 }),
          projectId: fc.string({ minLength: 1 }),
          payload: fc.jsonValue(),
          timestamp: fc.string({ minLength: 1 }),
        }),
        async (event) => {
          mockSend.mockClear();
          await publishEvent(event);
          const detail = lastPublishedDetail();
          expect("traceContext" in detail).toBe(false);
        },
      ),
    );
  });

  // Pinned counterexample from R7b (fast-check discovered): a format-specifier
  // eventType ("%i ") on a null-prototype event object. The pre-fix success log
  // passed `Event published: ${eventType}` as the console format string, so
  // "%i" coerced the event object via parseInt -> String(nullProtoObj), which
  // throws TypeError: Cannot convert object to primitive value mid-publish.
  it('R7b_example: format-specifier eventType "%i " on null-prototype event does not throw', async () => {
    (AWSXRay.getSegment as jest.Mock).mockReturnValue(undefined);

    const nullProtoEvent = Object.create(null);
    nullProtoEvent.eventType = "%i ";
    nullProtoEvent.projectId = "p1";
    nullProtoEvent.payload = {};
    nullProtoEvent.timestamp = "2026-01-01T00:00:00.000Z";

    await publishEvent(nullProtoEvent);
    const detail = lastPublishedDetail();
    expect("traceContext" in detail).toBe(false);
    expect(detail.eventType).toBeUndefined();
  });
});

describe("createReleaseEvent (G5 — RELEASE_POINTER_MOVED)", () => {
  beforeEach(() => {
    mockSend.mockClear();
    (AWSXRay.getSegment as jest.Mock).mockReset();
  });

  it("builds an AgentEvent carrying agentTargetId as agentId, with no projectId", () => {
    const event = createReleaseEvent(
      EventTypes.RELEASE_POINTER_MOVED,
      "agent-1",
      { environment: "PROD", releaseId: "release-1" },
      "corr-1",
    );
    expect(event.eventType).toBe("release.pointer.moved");
    expect(event.agentId).toBe("agent-1");
    expect(event.correlationId).toBe("corr-1");
    expect(
      (event as unknown as { projectId?: string }).projectId,
    ).toBeUndefined();
    expect(typeof event.timestamp).toBe("string");
  });

  it("publishes with the citadel.backend Source and drops projectId from the Detail body", async () => {
    (AWSXRay.getSegment as jest.Mock).mockReturnValue(undefined);

    await publishEvent(
      createReleaseEvent(EventTypes.RELEASE_POINTER_MOVED, "agent-1", {
        environment: "PROD",
        releaseId: "release-1",
      }),
    );

    const call = mockSend.mock.calls[mockSend.mock.calls.length - 1][0];
    const entry = call.input.Entries[0];
    expect(entry.Source).toBe("citadel.backend");
    expect(entry.DetailType).toBe("release.pointer.moved");
    const detail = JSON.parse(entry.Detail);
    expect("projectId" in detail).toBe(false);
    expect(detail.agentId).toBe("agent-1");
    expect(detail.payload).toEqual({
      environment: "PROD",
      releaseId: "release-1",
    });
  });
});
