/**
 * eval-artifact-store tests (CIT-102 Pass A, F4).
 *
 * Covers: SSM bucket-name resolution + per-execution-environment caching,
 * graceful degradation when the parameter is absent (never throws),
 * artifact materialization writing to the exact `eval-runs/{evalRunId}/{caseId}.json`
 * key, and propagation of assembleReplayPackage/S3 failures into the same
 * graceful-degradation contract.
 */
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const ssmMock = mockClient(SSMClient);
const s3Mock = mockClient(S3Client);

jest.mock("../replay-package-builder", () => ({
  assembleReplayPackage: jest.fn(),
}));

import { assembleReplayPackage } from "../replay-package-builder";
import {
  resolveReplayBucketName,
  materializeEvalCaseArtifact,
  __resetReplayBucketCacheForTests,
} from "../eval-artifact-store";

describe("eval-artifact-store", () => {
  beforeEach(() => {
    ssmMock.reset();
    s3Mock.reset();
    (assembleReplayPackage as jest.Mock).mockReset();
    __resetReplayBucketCacheForTests();
    process.env.ENVIRONMENT = "test";
  });

  describe("resolveReplayBucketName", () => {
    test("resolves the bucket name from the exact expected parameter name", async () => {
      ssmMock.on(GetParameterCommand).resolves({
        Parameter: {
          Value: "citadel-telemetry-test-replaypackagebucket-abc123",
        },
      });

      const name = await resolveReplayBucketName();

      expect(name).toBe("citadel-telemetry-test-replaypackagebucket-abc123");
      const calls = ssmMock.commandCalls(GetParameterCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input.Name).toBe(
        "/citadel/eval-replay-bucket-test",
      );
    });

    test("caches the resolved value — a second call performs zero additional ssm:GetParameter calls", async () => {
      ssmMock.on(GetParameterCommand).resolves({
        Parameter: { Value: "bucket-a" },
      });

      const first = await resolveReplayBucketName();
      const second = await resolveReplayBucketName();

      expect(first).toBe("bucket-a");
      expect(second).toBe("bucket-a");
      expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1);
    });

    test("degrades gracefully (returns null, never throws) when the parameter is not found", async () => {
      const notFound = Object.assign(new Error("not found"), {
        name: "ParameterNotFound",
      });
      ssmMock.on(GetParameterCommand).rejects(notFound);

      const name = await resolveReplayBucketName();

      expect(name).toBeNull();
    });

    test("caches a negative (null) result — a persistently-missing parameter is not retried within the same execution environment", async () => {
      const notFound = Object.assign(new Error("not found"), {
        name: "ParameterNotFound",
      });
      ssmMock.on(GetParameterCommand).rejects(notFound);

      await resolveReplayBucketName();
      await resolveReplayBucketName();

      expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1);
    });

    test("degrades gracefully when the parameter resolves with no value", async () => {
      ssmMock.on(GetParameterCommand).resolves({ Parameter: {} });

      const name = await resolveReplayBucketName();

      expect(name).toBeNull();
    });

    test("degrades gracefully on any other SSM error (never throws)", async () => {
      ssmMock.on(GetParameterCommand).rejects(new Error("ThrottlingException"));

      await expect(resolveReplayBucketName()).resolves.toBeNull();
    });
  });

  describe("materializeEvalCaseArtifact", () => {
    test("writes the assembled envelope to the exact prefix eval-runs/{evalRunId}/{caseId}.json", async () => {
      ssmMock
        .on(GetParameterCommand)
        .resolves({ Parameter: { Value: "my-bucket" } });
      (assembleReplayPackage as jest.Mock).mockResolvedValue({
        schemaVersion: "1.0.0",
        kind: "execution",
      });
      s3Mock.on(PutObjectCommand).resolves({});

      const result = await materializeEvalCaseArtifact(
        "run-1",
        "case-1",
        "org-1",
        "execution",
        "exec-1",
      );

      expect(result).toEqual({
        artifactRef: "eval-runs/run-1/case-1.json",
        artifactKind: "execution",
      });
      const calls = s3Mock.commandCalls(PutObjectCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input.Bucket).toBe("my-bucket");
      expect(calls[0].args[0].input.Key).toBe("eval-runs/run-1/case-1.json");
      expect(JSON.parse(calls[0].args[0].input.Body as string)).toEqual({
        schemaVersion: "1.0.0",
        kind: "execution",
      });
      expect(assembleReplayPackage).toHaveBeenCalledWith(
        "org-1",
        "execution",
        "exec-1",
      );
    });

    test("prefix is exact for a different evalRunId/caseId pair (no accidental delimiter drift)", async () => {
      ssmMock
        .on(GetParameterCommand)
        .resolves({ Parameter: { Value: "my-bucket" } });
      (assembleReplayPackage as jest.Mock).mockResolvedValue({
        kind: "conversation",
      });
      s3Mock.on(PutObjectCommand).resolves({});

      const result = await materializeEvalCaseArtifact(
        "11111111-1111-1111-1111-111111111111",
        "case-xyz",
        "org-2",
        "conversation",
        "conv-1",
      );

      expect(result.artifactRef).toBe(
        "eval-runs/11111111-1111-1111-1111-111111111111/case-xyz.json",
      );
    });

    test("degrades gracefully (artifactRef null) when the bucket parameter is unresolved — never throws", async () => {
      const notFound = Object.assign(new Error("not found"), {
        name: "ParameterNotFound",
      });
      ssmMock.on(GetParameterCommand).rejects(notFound);

      const result = await materializeEvalCaseArtifact(
        "run-1",
        "case-1",
        "org-1",
        "execution",
        "exec-1",
      );

      expect(result).toEqual({ artifactRef: null, artifactKind: null });
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
      expect(assembleReplayPackage).not.toHaveBeenCalled();
    });

    test("degrades gracefully (artifactRef null) when assembleReplayPackage throws — never throws", async () => {
      ssmMock
        .on(GetParameterCommand)
        .resolves({ Parameter: { Value: "my-bucket" } });
      (assembleReplayPackage as jest.Mock).mockRejectedValue(new Error("boom"));

      await expect(
        materializeEvalCaseArtifact(
          "run-1",
          "case-1",
          "org-1",
          "execution",
          "exec-1",
        ),
      ).resolves.toEqual({ artifactRef: null, artifactKind: null });
      expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    });

    test("degrades gracefully (artifactRef null) when the S3 write fails — never throws", async () => {
      ssmMock
        .on(GetParameterCommand)
        .resolves({ Parameter: { Value: "my-bucket" } });
      (assembleReplayPackage as jest.Mock).mockResolvedValue({
        kind: "execution",
      });
      s3Mock.on(PutObjectCommand).rejects(new Error("AccessDenied"));

      await expect(
        materializeEvalCaseArtifact(
          "run-1",
          "case-1",
          "org-1",
          "execution",
          "exec-1",
        ),
      ).resolves.toEqual({ artifactRef: null, artifactKind: null });
    });
  });
});
