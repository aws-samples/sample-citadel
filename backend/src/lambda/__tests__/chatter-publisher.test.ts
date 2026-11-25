/**
 * Tests for the chatter-publisher Lambda.
 *
 * Finding: chatter-publisher.ts refused (ERROR level, no metric) any
 * EventBridge event lacking detail.orgId, and — because the ChatterRule is
 * a bus-wide catch-all and the producers didn't stamp orgId — every live
 * chatter event except workflow.created was refused, so ERROR logs piled
 * up with no way to alarm on the refusal rate. Fix: downgrade to WARN and
 * emit a counter metric via the existing EMF utility.
 */
import { EventBridgeEvent } from "aws-lambda";

jest.mock("@aws-sdk/credential-provider-node", () => ({
  defaultProvider: () => async () => ({
    accessKeyId: "test",
    secretAccessKey: "test",
  }),
}));

const emitMetricsMock = jest.fn();
jest.mock("../../utils/emf", () => ({
  emitMetrics: (...args: unknown[]) => emitMetricsMock(...args),
}));

const signMock = jest.fn().mockResolvedValue({
  headers: { "content-type": "application/json" },
  body: "{}",
});
jest.mock("@smithy/signature-v4", () => ({
  SignatureV4: jest.fn().mockImplementation(() => ({ sign: signMock })),
}));

// Module-scope `const APPSYNC_ENDPOINT = process.env.APPSYNC_ENDPOINT!` in
// chatter-publisher.ts reads the env var at import time, so it must be set
// BEFORE the import, not in beforeEach.
process.env.APPSYNC_ENDPOINT = "https://example.appsync-api.test/graphql";

import { handler } from "../chatter-publisher";
import { METRIC_CHATTER_ORG_ID_MISSING } from "../../utils/metrics-constants";

describe("chatter-publisher", () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    emitMetricsMock.mockReset();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(global, "fetch").mockResolvedValue({
      json: async () => ({ data: { publishChatter: {} } }),
    } as unknown as Response);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const makeEvent = (
    detail: Record<string, unknown>,
  ): EventBridgeEvent<string, unknown> =>
    ({
      id: "evt-1",
      time: "2025-01-01T00:00:00Z",
      source: "citadel.workflows",
      "detail-type": "workflow.node.started",
      detail,
    }) as unknown as EventBridgeEvent<string, unknown>;

  test("refusing an event with no orgId logs at WARN, not ERROR", async () => {
    await handler(makeEvent({}));

    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Refusing to publish chatter"),
      expect.anything(),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Refusing to publish chatter"),
      expect.anything(),
    );
  });

  test("refusing an event with no orgId emits a ChatterOrgIdMissing counter metric", async () => {
    await handler(makeEvent({}));

    expect(emitMetricsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metrics: expect.arrayContaining([
          expect.objectContaining({
            name: METRIC_CHATTER_ORG_ID_MISSING,
            value: 1,
          }),
        ]),
      }),
    );
  });

  test("an event carrying orgId does not emit the refusal metric", async () => {
    await handler(makeEvent({ orgId: "org-1" }));

    expect(emitMetricsMock).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
