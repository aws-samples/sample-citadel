/**
 * eval-sampling-selector.test.ts (Phase 2 §2.3) — the selector Lambda that
 * decides whether a terminal workflow/conversation signal gets sampled,
 * materializes a sanitized prod-sample artifact by reusing
 * assembleReplayPackage verbatim, and emits governance.eval.sample.captured.
 *
 * Jest + aws-sdk-client-mock (established convention, see
 * eval-case-scorer.test.ts). `getEvalSamplingConfig`/`shouldSample` are
 * jest.mock'd (pure orchestration seam, not AWS I/O);
 * `assembleReplayPackage` is jest.mock'd too — it is independently tested
 * by replay-package-builder.test.ts, so here we only need to control what
 * it returns/throws for the selector's own gating/materialization logic.
 */
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";

process.env.EVAL_SAMPLING_CONFIG_TABLE = "eval-sampling-config-test";
process.env.IDEMPOTENCY_TABLE = "idempotency-test";
process.env.ENVIRONMENT = "test";

jest.mock("../utils/eval-sampling-config", () => ({
  getEvalSamplingConfig: jest.fn(),
  resolveEffectiveRate: (
    config:
      | {
          optIn: boolean;
          defaultSampleRate: number;
          perAgentSampleRate: Record<string, number>;
        }
      | undefined,
    agentId: string,
  ) => {
    if (!config || config.optIn !== true) return 0;
    return config.perAgentSampleRate[agentId] ?? config.defaultSampleRate;
  },
  shouldSample: (_runId: string, rate: number) => rate >= 1,
}));

jest.mock("../utils/replay-package-builder", () => {
  const actual = jest.requireActual("../utils/replay-package-builder");
  return {
    ...actual,
    assembleReplayPackage: jest.fn(),
  };
});

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const ssmMock = mockClient(SSMClient);
const ebMock = mockClient(EventBridgeClient);

import {
  handleTerminalSignal,
  type TerminalSignalInput,
} from "../eval-sampling-selector";
import { __resetReplayBucketCacheForTests } from "../utils/eval-artifact-store";
import { getEvalSamplingConfig } from "../utils/eval-sampling-config";
import { assembleReplayPackage } from "../utils/replay-package-builder";

const mockGetEvalSamplingConfig = getEvalSamplingConfig as jest.Mock;
const mockAssembleReplayPackage = assembleReplayPackage as jest.Mock;

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  ssmMock.reset();
  ebMock.reset();
  jest.clearAllMocks();
  __resetReplayBucketCacheForTests();
  ssmMock
    .on(GetParameterCommand)
    .resolves({ Parameter: { Value: "prod-sample-bucket" } });
  // IdempotencyGuard's conditional PutCommand — default "not seen before".
  ddbMock.resolves({});
});

const baseInput: TerminalSignalInput = {
  runId: "run-abc123",
  orgId: "org-1",
  agentId: "agent-1",
  kind: "execution",
  sourceId: "exec-1",
};

describe("eval-sampling-selector — org opt-in gate", () => {
  test("does not sample when the org has not opted in", async () => {
    mockGetEvalSamplingConfig.mockResolvedValue({
      orgId: "org-1",
      optIn: false,
      defaultSampleRate: 1,
      perAgentSampleRate: {},
    });

    await handleTerminalSignal(baseInput);

    expect(mockAssembleReplayPackage).not.toHaveBeenCalled();
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
  });

  test("does not sample when no config exists for the org", async () => {
    mockGetEvalSamplingConfig.mockResolvedValue(undefined);

    await handleTerminalSignal(baseInput);

    expect(mockAssembleReplayPackage).not.toHaveBeenCalled();
  });

  test("samples when opted in and the effective rate resolves to sample=true", async () => {
    mockGetEvalSamplingConfig.mockResolvedValue({
      orgId: "org-1",
      optIn: true,
      defaultSampleRate: 1,
      perAgentSampleRate: {},
    });
    mockAssembleReplayPackage.mockResolvedValue({
      schemaVersion: "1.0.0",
      kind: "execution",
      orgId: "org-1",
      sections: {},
    });
    s3Mock.on(PutObjectCommand).resolves({});

    await handleTerminalSignal(baseInput);

    expect(mockAssembleReplayPackage).toHaveBeenCalledWith(
      "org-1",
      "execution",
      "exec-1",
    );
    const putCalls = s3Mock.commandCalls(PutObjectCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input.Key).toBe(
      "prod-samples/org-1/run-abc123.json",
    );
    expect(putCalls[0].args[0].input.Bucket).toBe("prod-sample-bucket");
  });
});

describe("eval-sampling-selector — fail-closed drop on sanitize gate throw", () => {
  test("drops the sample (never writes, never emits) when assembleReplayPackage throws", async () => {
    mockGetEvalSamplingConfig.mockResolvedValue({
      orgId: "org-1",
      optIn: true,
      defaultSampleRate: 1,
      perAgentSampleRate: {},
    });
    mockAssembleReplayPackage.mockRejectedValue(
      new Error("ReplaySecretLeakError: secret detected"),
    );

    await handleTerminalSignal(baseInput);

    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(ebMock.commandCalls(PutEventsCommand)).toHaveLength(0);
  });

  test("never throws out of the handler itself even when the gate throws", async () => {
    mockGetEvalSamplingConfig.mockResolvedValue({
      orgId: "org-1",
      optIn: true,
      defaultSampleRate: 1,
      perAgentSampleRate: {},
    });
    mockAssembleReplayPackage.mockRejectedValue(new Error("boom"));

    await expect(handleTerminalSignal(baseInput)).resolves.not.toThrow();
  });
});

describe("eval-sampling-selector — idempotency", () => {
  test("does not re-materialize when the runId was already processed", async () => {
    mockGetEvalSamplingConfig.mockResolvedValue({
      orgId: "org-1",
      optIn: true,
      defaultSampleRate: 1,
      perAgentSampleRate: {},
    });
    const err = Object.assign(new Error("dup"), {
      name: "ConditionalCheckFailedException",
    });
    ddbMock.rejects(err);

    await handleTerminalSignal(baseInput);

    expect(mockAssembleReplayPackage).not.toHaveBeenCalled();
  });
});

describe("eval-sampling-selector — event emission allowlist", () => {
  test("emits governance.eval.sample.captured with the allowlist excluding task_success/tool_accuracy", async () => {
    mockGetEvalSamplingConfig.mockResolvedValue({
      orgId: "org-1",
      optIn: true,
      defaultSampleRate: 1,
      perAgentSampleRate: {},
    });
    mockAssembleReplayPackage.mockResolvedValue({
      schemaVersion: "1.0.0",
      kind: "execution",
      orgId: "org-1",
      sections: {},
    });
    s3Mock.on(PutObjectCommand).resolves({});
    ebMock.on(PutEventsCommand).resolves({});

    await handleTerminalSignal(baseInput);

    const calls = ebMock.commandCalls(PutEventsCommand);
    expect(calls).toHaveLength(1);
    const entry = calls[0].args[0].input.Entries![0];
    expect(entry.DetailType).toBe("governance.eval.sample.captured");
    const payload = JSON.parse(entry.Detail!);
    expect(payload.dimensions).not.toContain("task_success");
    expect(payload.dimensions).not.toContain("tool_accuracy");
    expect(payload.orgId).toBe("org-1");
    expect(payload.runId).toBe("run-abc123");
    expect(payload.artifactRef).toBe("prod-samples/org-1/run-abc123.json");
  });
});

describe("eval-sampling-selector — conversation kind", () => {
  test("passes kind=conversation through to assembleReplayPackage", async () => {
    mockGetEvalSamplingConfig.mockResolvedValue({
      orgId: "org-1",
      optIn: true,
      defaultSampleRate: 1,
      perAgentSampleRate: {},
    });
    mockAssembleReplayPackage.mockResolvedValue({
      schemaVersion: "1.0.0",
      kind: "conversation",
      orgId: "org-1",
      sections: {},
    });
    s3Mock.on(PutObjectCommand).resolves({});

    await handleTerminalSignal({
      ...baseInput,
      kind: "conversation",
      sourceId: "conv-1",
    });

    expect(mockAssembleReplayPackage).toHaveBeenCalledWith(
      "org-1",
      "conversation",
      "conv-1",
    );
  });
});
