jest.mock("aws-xray-sdk-core", () => ({
  getSegment: jest.fn(),
}));

import * as AWSXRay from "aws-xray-sdk-core";
import { logger } from "../logger";

describe("logger.ts trace_id injection (additive, no-op-safe)", () => {
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    (AWSXRay.getSegment as jest.Mock).mockReset();
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  function lastLoggedEntry(): Record<string, unknown> {
    const raw = infoSpy.mock.calls[infoSpy.mock.calls.length - 1][0];
    return JSON.parse(raw);
  }

  // R8: every emitted line has trace_id when a segment is present.
  it("R8: log entry includes trace_id when an active segment is present", () => {
    (AWSXRay.getSegment as jest.Mock).mockReturnValue({
      trace_id: "1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb",
      id: "cccccccccccccccc",
      notTraced: false,
    });

    logger.info("hello", { correlationId: "corr-1" });

    const entry = lastLoggedEntry();
    expect(entry.trace_id).toBe("1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb");
    expect(entry.correlationId).toBe("corr-1");
  });

  // R8b: absent-safe otherwise.
  it("R8b: log entry omits trace_id when there is no active segment (no throw)", () => {
    (AWSXRay.getSegment as jest.Mock).mockReturnValue(undefined);

    expect(() =>
      logger.info("hello", { correlationId: "corr-1" }),
    ).not.toThrow();

    const entry = lastLoggedEntry();
    expect("trace_id" in entry).toBe(false);
    expect(entry.correlationId).toBe("corr-1");
  });

  it("R8c: log entry omits trace_id when getSegment itself throws", () => {
    (AWSXRay.getSegment as jest.Mock).mockImplementation(() => {
      throw new Error("no context");
    });

    expect(() => logger.info("hello")).not.toThrow();
    const entry = lastLoggedEntry();
    expect("trace_id" in entry).toBe(false);
  });
});
