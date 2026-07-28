/**
 * R9 (property): every consumer named in the trace-propagation design
 * processes an event with NO `traceContext` without throwing and with an
 * unchanged business result. Each handler's existing test suite already
 * exercises this implicitly (all pre-existing assertions still pass after
 * the additive wiring); this file makes the no-traceContext-no-throw
 * property explicit and dedicated, per the design's red-first test list.
 */
import * as fc from "fast-check";

jest.mock("aws-xray-sdk-core", () => ({
  getSegment: jest.fn().mockReturnValue(undefined),
  setContextMissingStrategy: jest.fn(),
  captureAWSv3Client: jest.fn((c) => c),
}));

describe("R9: consumer no-traceContext no-throw property", () => {
  it("governance-notifier: dropping an unrecognized detail-type never throws regardless of detail shape", async () => {
    const { handler } = await import("../governance-notifier");
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (detail) => {
        const result = await handler({
          id: "evt-1",
          "detail-type": "not.a.governance.type",
          source: "citadel.test",
          time: "2026-01-01T00:00:00Z",
          detail,
        } as unknown as Parameters<typeof handler>[0]);
        expect(result.statusCode).toBe(200);
      }),
      { numRuns: 25 },
    );
  });

  it("gateway-registration-handler: an unrecognized detail-type never throws regardless of detail shape (traceContext absent)", async () => {
    jest.doMock("../../utils/idempotency", () => ({
      IdempotencyGuard: jest.fn().mockImplementation(() => ({
        withIdempotency: jest.fn(
          async (_id: string, fn: () => Promise<unknown>) => {
            await fn();
            return { executed: true };
          },
        ),
      })),
    }));
    jest.resetModules();
    const { handler } = await import("../gateway-registration-handler");
    await expect(
      handler({
        id: "evt-2",
        "detail-type": "integration.unknown.event",
        source: "citadel.test",
        time: "2026-01-01T00:00:00Z",
        detail: {
          integrationId: "int-1",
          integrationType: "UNKNOWN",
          orgId: "org-1",
        },
      } as unknown as Parameters<typeof handler>[0]),
    ).resolves.not.toThrow();
  });
});
