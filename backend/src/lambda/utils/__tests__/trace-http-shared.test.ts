/**
 * Tests for trace-http-shared.ts — ownership resolution for the two
 * entry-key routes (design §1 "Resolution order"):
 *   - resolveExecutionOwnership: executions.orgId (direct GetItem)
 *   - resolveConversationOwnership: conversation(projectId) -> projects.orgId
 *
 * Invariant 1 (binding): callers use these BEFORE issuing any X-Ray call.
 * These tests assert the ownership resolvers themselves never touch X-Ray
 * (they have no X-Ray import at all) and return the correct
 * ok/status shape for every branch the design's authorization matrix lists.
 */
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

import {
  resolveExecutionOwnership,
  resolveConversationOwnership,
} from "../trace-http-shared";

describe("resolveExecutionOwnership", () => {
  test("known execution -> ok:true with orgId and correlationId (== executionId)", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { executionId: "exec-1", orgId: "org-1", workflowId: "wf-1" },
    });

    const result = await resolveExecutionOwnership("exec-1");
    expect(result).toEqual({
      ok: true,
      orgId: "org-1",
      correlationId: "exec-1",
    });
  });

  test("unknown execution -> ok:false status:404", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await resolveExecutionOwnership("nope");
    expect(result).toEqual({ ok: false, status: 404 });
  });

  test("issues exactly one GetCommand keyed by executionId (no Scan, no Query)", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { executionId: "exec-2", orgId: "org-2" },
    });

    await resolveExecutionOwnership("exec-2");

    expect(ddbMock.calls()).toHaveLength(1);
    const call = ddbMock.calls()[0];
    expect(call.args[0].input).toMatchObject({
      Key: { executionId: "exec-2" },
    });
  });
});

describe("resolveConversationOwnership", () => {
  test("known project -> ok:true with orgId and correlationId (== projectId)", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { id: "proj-1", orgId: "org-9" },
    });

    const result = await resolveConversationOwnership("proj-1");
    expect(result).toEqual({
      ok: true,
      orgId: "org-9",
      correlationId: "proj-1",
    });
  });

  test("unknown project -> ok:false status:404", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await resolveConversationOwnership("nope");
    expect(result).toEqual({ ok: false, status: 404 });
  });

  test("project row missing orgId -> ok:false status:404 (never fabricates an org)", async () => {
    ddbMock.on(GetCommand).resolves({ Item: { id: "proj-2" } });

    const result = await resolveConversationOwnership("proj-2");
    expect(result).toEqual({ ok: false, status: 404 });
  });
});
