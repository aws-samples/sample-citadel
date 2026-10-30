/**
 * CIT-254 H11: LambdaInvokeAdapter.invoke validates FunctionName via arn-safety.
 *
 * Per site: two negatives (foreign account without cross-account creds;
 * non-Lambda ARN e.g. arn:aws:s3:::bucket) + positive.
 */
import { LambdaInvokeAdapter } from "../lambda-invoke-adapter";
import type { AgentCapabilityDescriptor, InvokeRequest } from "../base";
import type { CommandSender } from "../invoke-support";

const PLATFORM = "123456789012";
const FOREIGN = "999888777666";

function makeReq(): InvokeRequest {
  return { prompt: "hello", sessionId: "s1" };
}

function makeDescriptor(
  target: string,
  overrides?: Partial<AgentCapabilityDescriptor["invocation"]>,
): AgentCapabilityDescriptor {
  return {
    name: "test",
    description: "",
    version: "1",
    skills: [],
    categories: [],
    inputSchema: {},
    outputSchema: {},
    invocation: {
      protocol: "LAMBDA_INVOKE",
      target,
      auth: { mode: "SIGV4" },
      mode: "sync",
      region: "us-east-1",
      account: PLATFORM,
      ...overrides,
    },
    origin: {
      sourceArn: target,
      substrate: "lambda",
      region: "us-east-1",
      account: PLATFORM,
      discoveredAt: new Date().toISOString(),
      ownership: "external",
    },
    fieldConfidence: {},
  } as AgentCapabilityDescriptor;
}

function makeSender(payload: string = '{"response":"ok"}'): CommandSender {
  return {
    send: jest.fn().mockResolvedValue({
      StatusCode: 200,
      Payload: new TextEncoder().encode(payload),
    }),
  };
}

describe("CIT-254 H11 — LambdaInvokeAdapter.invoke ARN binding", () => {
  const originalAccountId = process.env.AWS_ACCOUNT_ID;

  beforeAll(() => {
    process.env.AWS_ACCOUNT_ID = PLATFORM;
  });
  afterAll(() => {
    if (originalAccountId !== undefined) {
      process.env.AWS_ACCOUNT_ID = originalAccountId;
    } else {
      delete process.env.AWS_ACCOUNT_ID;
    }
  });

  // --- Negative: foreign account Lambda ARN without cross-account creds ---
  it("rejects a foreign-account Lambda ARN when no credentialProvider is set", async () => {
    const sender = makeSender();
    const adapter = new LambdaInvokeAdapter(sender, {
      defaultAccount: PLATFORM,
    });
    const desc = makeDescriptor(
      `arn:aws:lambda:us-east-1:${FOREIGN}:function:evil-fn`,
    );

    await expect(adapter.invoke(makeReq(), desc)).rejects.toThrow(
      "Invalid resource reference",
    );
    expect(sender.send).not.toHaveBeenCalled();
  });

  // --- Negative: non-Lambda ARN (e.g. S3 bucket) ---
  it("rejects a non-Lambda ARN (arn:aws:s3:::bucket)", async () => {
    const sender = makeSender();
    const adapter = new LambdaInvokeAdapter(sender, {
      defaultAccount: PLATFORM,
    });
    const desc = makeDescriptor("arn:aws:s3:::evil-bucket");

    await expect(adapter.invoke(makeReq(), desc)).rejects.toThrow(
      "Invalid resource reference",
    );
    expect(sender.send).not.toHaveBeenCalled();
  });

  // --- Positive: same-account Lambda ARN ---
  it("accepts a same-account Lambda function ARN", async () => {
    const sender = makeSender();
    const adapter = new LambdaInvokeAdapter(sender, {
      defaultAccount: PLATFORM,
    });
    const desc = makeDescriptor(
      `arn:aws:lambda:us-east-1:${PLATFORM}:function:my-fn`,
    );

    const result = await adapter.invoke(makeReq(), desc);
    expect(result.output).toBe("ok");
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  // --- Positive: bare function name (same-account, no ARN) ---
  it("accepts a bare function name without cross-account creds", async () => {
    const sender = makeSender();
    const adapter = new LambdaInvokeAdapter(sender, {
      defaultAccount: PLATFORM,
    });
    const desc = makeDescriptor("my-function");

    const result = await adapter.invoke(makeReq(), desc);
    expect(result.output).toBe("ok");
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  // --- Negative: bare function name WITH cross-account creds (requires ARN) ---
  it("rejects a bare function name when credentialProvider is set", async () => {
    const sender = makeSender();
    const creds = {
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      sessionToken: "TOK",
    };
    const adapter = new LambdaInvokeAdapter(sender, {
      defaultAccount: PLATFORM,
      credentialProvider: creds,
    });
    const desc = makeDescriptor("my-function", { account: FOREIGN });

    await expect(adapter.invoke(makeReq(), desc)).rejects.toThrow(
      "Invalid resource reference",
    );
  });

  // --- Positive: cross-account Lambda ARN with matching credentialProvider ---
  it("accepts a cross-account Lambda ARN when credentialProvider is set and account matches", async () => {
    const sender = makeSender();
    const creds = {
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      sessionToken: "TOK",
    };
    const adapter = new LambdaInvokeAdapter(sender, {
      defaultAccount: PLATFORM,
      credentialProvider: creds,
    });
    const desc = makeDescriptor(
      `arn:aws:lambda:us-east-1:${FOREIGN}:function:cross-fn`,
      { account: FOREIGN },
    );

    const result = await adapter.invoke(makeReq(), desc);
    expect(result.output).toBe("ok");
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  // --- Negative: cross-account Lambda ARN but account mismatch ---
  it("rejects a cross-account Lambda ARN when ARN account differs from descriptor account", async () => {
    const sender = makeSender();
    const creds = {
      accessKeyId: "AKID",
      secretAccessKey: "SECRET",
      sessionToken: "TOK",
    };
    const adapter = new LambdaInvokeAdapter(sender, {
      defaultAccount: PLATFORM,
      credentialProvider: creds,
    });
    // ARN is for account 999..., but descriptor says account should be 111...
    const desc = makeDescriptor(
      `arn:aws:lambda:us-east-1:${FOREIGN}:function:cross-fn`,
      { account: "111222333444" },
    );

    await expect(adapter.invoke(makeReq(), desc)).rejects.toThrow(
      "Invalid resource reference",
    );
  });
});
