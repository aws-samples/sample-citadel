/**
 * eval-sampling-config-resolver.test.ts (Phase 2 §2.1) — admin-only
 * GraphQL resolver for EvalSamplingConfig storage + reads, and read-only
 * listEvalProdSamples.
 *
 * Admin-only gate: `roles.includes("admin")` directly (stricter than
 * eval:approve — this controls whether production traffic gets sampled
 * at all, a platform-wide toggle, not a per-suite governance action).
 */
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import type { AuthContext } from "../../types";

process.env.EVAL_SAMPLING_CONFIG_TABLE = "eval-sampling-config-test";
process.env.EVAL_PROD_SAMPLES_TABLE = "eval-prod-samples-test";

const ddbMock = mockClient(DynamoDBDocumentClient);

import {
  getEvalSamplingConfig,
  setEvalSamplingConfig,
  listEvalProdSamples,
} from "../eval-sampling-config-resolver";

beforeEach(() => {
  ddbMock.reset();
});

const adminAuth: AuthContext = {
  userId: "admin-1",
  groups: [],
  roles: ["admin"],
};
const nonAdminAuth: AuthContext = {
  userId: "user-1",
  groups: [],
  roles: ["project_manager"],
};

describe("setEvalSamplingConfig — admin-only gate", () => {
  test("rejects a non-admin caller", async () => {
    await expect(
      setEvalSamplingConfig(
        "org-1",
        { optIn: true, defaultSampleRate: 0.1, perAgentSampleRate: {} },
        nonAdminAuth,
      ),
    ).rejects.toThrow(/UnauthorizedError/);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("allows an admin caller and writes the row", async () => {
    ddbMock.on(PutCommand).resolves({});

    const result = await setEvalSamplingConfig(
      "org-1",
      {
        optIn: true,
        defaultSampleRate: 0.1,
        perAgentSampleRate: { "agent-1": 0.5 },
      },
      adminAuth,
    );

    expect(result.orgId).toBe("org-1");
    expect(result.optIn).toBe(true);
    expect(result.defaultSampleRate).toBe(0.1);
    const putArgs = ddbMock.commandCalls(PutCommand)[0].args[0].input;
    expect(putArgs.TableName).toBe("eval-sampling-config-test");
    expect((putArgs.Item as Record<string, unknown>).orgId).toBe("org-1");
  });

  test("clamps an out-of-range rate before persisting", async () => {
    ddbMock.on(PutCommand).resolves({});

    const result = await setEvalSamplingConfig(
      "org-1",
      { optIn: true, defaultSampleRate: 5, perAgentSampleRate: {} },
      adminAuth,
    );

    expect(result.defaultSampleRate).toBe(1);
  });
});

describe("getEvalSamplingConfig — admin-only gate", () => {
  test("rejects a non-admin caller", async () => {
    await expect(getEvalSamplingConfig("org-1", nonAdminAuth)).rejects.toThrow(
      /UnauthorizedError/,
    );
  });

  test("returns undefined when no config exists", async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const result = await getEvalSamplingConfig("org-1", adminAuth);
    expect(result).toBeUndefined();
  });

  test("returns the stored config for an admin", async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        orgId: "org-1",
        optIn: true,
        defaultSampleRate: 0.2,
        perAgentSampleRate: {},
      },
    });
    const result = await getEvalSamplingConfig("org-1", adminAuth);
    expect(result?.optIn).toBe(true);
  });
});

describe("listEvalProdSamples — admin-only gate", () => {
  test("rejects a non-admin caller", async () => {
    await expect(
      listEvalProdSamples("org-1", undefined, nonAdminAuth),
    ).rejects.toThrow(/UnauthorizedError/);
  });

  test("queries the base table by orgId for an admin", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          orgId: "org-1",
          runId: "run-1",
          sampleId: "run-1",
          agentId: "agent-1",
          kind: "EXECUTION",
          artifactRef: "prod-samples/org-1/run-1.json",
          scoreVector: "[]",
          capturedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const result = await listEvalProdSamples("org-1", undefined, adminAuth);

    expect(result).toHaveLength(1);
    expect(result[0].runId).toBe("run-1");
    const queryArgs = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(queryArgs.TableName).toBe("eval-prod-samples-test");
  });

  // M1 (taskId 316427f2): EvalProdSample.kind GraphQL enum expects
  // EXECUTION/CONVERSATION, but rows are written with the lowercase
  // ReplayKind ("execution"/"conversation") — the resolver must map on
  // read so AppSync enum serialization does not reject/blank the field.
  test("maps lowercase stored kind to the uppercase EvalCaseKind enum (M1)", async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        {
          orgId: "org-1",
          runId: "run-2",
          sampleId: "run-2",
          agentId: "agent-1",
          kind: "execution",
          artifactRef: "prod-samples/org-1/run-2.json",
          scoreVector: "[]",
          capturedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          orgId: "org-1",
          runId: "run-3",
          sampleId: "run-3",
          agentId: "agent-1",
          kind: "conversation",
          artifactRef: "prod-samples/org-1/run-3.json",
          scoreVector: "[]",
          capturedAt: "2026-01-01T00:01:00.000Z",
        },
      ],
    });

    const result = await listEvalProdSamples("org-1", undefined, adminAuth);

    expect(result.find((r) => r.runId === "run-2")?.kind).toBe("EXECUTION");
    expect(result.find((r) => r.runId === "run-3")?.kind).toBe("CONVERSATION");
  });
});
