/**
 * Tracing foundation — proves the real (unmocked) `aws-xray-sdk-core`
 * behaves as required with no X-Ray daemon/segment context present (the
 * Jest runtime environment): a `captureAWSv3Client`-wrapped client must
 * LOG the missing-context error and continue, never throw/reject the
 * whole call because tracing plumbing is absent.
 *
 * This is the concrete proof behind the "no-op-safe under jest" claim in
 * utils/dynamodb.ts / utils/events.ts — xray-client-wrap.test.ts covers the
 * wrap-is-called assertions against a mocked SDK; this file is the one
 * un-mocked integration check.
 */
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";

describe("tracing foundation — no X-Ray daemon/context (real SDK, no mocks)", () => {
  test("setContextMissingStrategy(LOG_ERROR) + captureAWSv3Client never throws on a real send() without a segment", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const AWSXRay = require("aws-xray-sdk-core");
    AWSXRay.setContextMissingStrategy("LOG_ERROR");

    const wrapped = AWSXRay.captureAWSv3Client(
      new DynamoDBClient({
        region: "us-east-1",
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
      }),
    );

    // No X-Ray segment exists in this process. With LOG_ERROR, the
    // missing-context path must log and fall through to the underlying
    // SDK call (which itself fails on invalid test credentials/network —
    // that rejection is expected and asserted on below) rather than the
    // X-Ray wrap itself throwing a "sub/segment" error.
    await expect(wrapped.send(new ListTablesCommand({}))).rejects.not.toThrow(
      /sub\/segment/i,
    );
  });
});
