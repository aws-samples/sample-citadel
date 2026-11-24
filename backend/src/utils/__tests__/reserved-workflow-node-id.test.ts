/**
 * Unit tests for isReservedWorkflowNodeId / RESERVED_WORKFLOW_NODE_IDS
 * (finding 679abf74).
 *
 * This set is a second, independent copy of
 * arbiter/supervisor/index.py's RESERVED_WORKFLOW_TRACKING_KEYS — there is
 * no module shared between the TypeScript backend and the Python arbiter —
 * so these tests pin the exact two literal strings the Python side also
 * pins, to catch the two sides drifting out of sync.
 */

import {
  isReservedWorkflowNodeId,
  RESERVED_WORKFLOW_NODE_IDS,
} from "../validation";

describe("RESERVED_WORKFLOW_NODE_IDS", () => {
  test("is exactly the two keys the arbiter supervisor reserves", () => {
    expect([...RESERVED_WORKFLOW_NODE_IDS].sort()).toEqual(
      ["data", "requestId"].sort(),
    );
  });
});

describe("isReservedWorkflowNodeId", () => {
  test.each(RESERVED_WORKFLOW_NODE_IDS)(
    "returns true for reserved key %p",
    (reserved) => {
      expect(isReservedWorkflowNodeId(reserved)).toBe(true);
    },
  );

  test("returns false for an ordinary agent name", () => {
    expect(isReservedWorkflowNodeId("my-agent")).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isReservedWorkflowNodeId(undefined)).toBe(false);
  });

  test("returns false for an empty string", () => {
    expect(isReservedWorkflowNodeId("")).toBe(false);
  });

  test("is case-sensitive: 'Data' and 'REQUESTID' are not reserved", () => {
    expect(isReservedWorkflowNodeId("Data")).toBe(false);
    expect(isReservedWorkflowNodeId("REQUESTID")).toBe(false);
  });

  test("returns false for a superstring of a reserved key", () => {
    expect(isReservedWorkflowNodeId("metadata")).toBe(false);
    expect(isReservedWorkflowNodeId("requestId2")).toBe(false);
  });
});
