/**
 * Tests for arn-safety.ts — CIT-254 SH-1.
 *
 * Table-driven vectors cover: valid ARNs, wrong partition/service/account,
 * malformed strings, cross-account rules (externalId required, account != platform).
 */

import {
  parseArn,
  assertSameAccountArn,
  assertCrossAccountRole,
  ArnRejectedError,
} from "../arn-safety";

// ---------------------------------------------------------------------------
// parseArn
// ---------------------------------------------------------------------------

describe("parseArn", () => {
  const valid: Array<{
    arn: string;
    expected: {
      partition: string;
      service: string;
      region: string;
      accountId: string;
      resource: string;
    };
  }> = [
    {
      arn: "arn:aws:lambda:us-east-1:123456789012:function:my-fn",
      expected: {
        partition: "aws",
        service: "lambda",
        region: "us-east-1",
        accountId: "123456789012",
        resource: "function:my-fn",
      },
    },
    {
      arn: "arn:aws:iam::123456789012:role/my-role",
      expected: {
        partition: "aws",
        service: "iam",
        region: "",
        accountId: "123456789012",
        resource: "role/my-role",
      },
    },
    {
      arn: "arn:aws-cn:s3:cn-north-1:111222333444:my-bucket/key",
      expected: {
        partition: "aws-cn",
        service: "s3",
        region: "cn-north-1",
        accountId: "111222333444",
        resource: "my-bucket/key",
      },
    },
    {
      arn: "arn:aws-us-gov:iam::999888777666:role/gov-role",
      expected: {
        partition: "aws-us-gov",
        service: "iam",
        region: "",
        accountId: "999888777666",
        resource: "role/gov-role",
      },
    },
  ];

  it.each(valid)("parses $arn", ({ arn, expected }) => {
    expect(parseArn(arn)).toEqual(expected);
  });

  const invalid: Array<{ label: string; input: unknown }> = [
    { label: "empty string", input: "" },
    { label: "null", input: null },
    { label: "undefined", input: undefined },
    { label: "number", input: 42 },
    { label: "missing colons", input: "arn:aws:lambda" },
    { label: "too few parts", input: "arn:aws:lambda:us-east-1:12345:" },
    {
      label: "11-digit account",
      input: "arn:aws:lambda:us-east-1:12345678901:function:fn",
    },
    {
      label: "13-digit account",
      input: "arn:aws:lambda:us-east-1:1234567890123:function:fn",
    },
    {
      label: "wrong partition",
      input: "arn:azure:lambda:us-east-1:123456789012:function:fn",
    },
    { label: "wildcard principal", input: "*" },
    {
      label: "empty resource",
      input: "arn:aws:lambda:us-east-1:123456789012:",
    },
  ];

  it.each(invalid)("rejects $label", ({ input }) => {
    expect(() => parseArn(input as string)).toThrow(ArnRejectedError);
    expect(() => parseArn(input as string)).toThrow(
      "Invalid resource reference",
    );
  });

  it("every rejection has the same opaque message", () => {
    const messages = invalid.map(({ input }) => {
      try {
        parseArn(input as string);
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    });
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toBe("Invalid resource reference");
  });
});

// ---------------------------------------------------------------------------
// assertSameAccountArn
// ---------------------------------------------------------------------------

describe("assertSameAccountArn", () => {
  const PLATFORM = "123456789012";

  it("accepts a same-account lambda ARN", () => {
    const result = assertSameAccountArn(
      "arn:aws:lambda:us-east-1:123456789012:function:my-fn",
      { platformAccountId: PLATFORM, allowedServices: ["lambda"] },
    );
    expect(result.service).toBe("lambda");
    expect(result.accountId).toBe(PLATFORM);
  });

  it("accepts multiple allowed services", () => {
    const result = assertSameAccountArn(
      "arn:aws:iam::123456789012:role/my-role",
      { platformAccountId: PLATFORM, allowedServices: ["lambda", "iam"] },
    );
    expect(result.service).toBe("iam");
  });

  const rejections: Array<{
    label: string;
    arn: string;
    opts: { platformAccountId: string; allowedServices: string[] };
  }> = [
    {
      label: "wrong service (s3 not in allowed)",
      arn: "arn:aws:s3:us-east-1:123456789012:my-bucket",
      opts: { platformAccountId: PLATFORM, allowedServices: ["lambda", "iam"] },
    },
    {
      label: "foreign account",
      arn: "arn:aws:lambda:us-east-1:999888777666:function:evil",
      opts: { platformAccountId: PLATFORM, allowedServices: ["lambda"] },
    },
    {
      label: "malformed ARN",
      arn: "not-an-arn",
      opts: { platformAccountId: PLATFORM, allowedServices: ["lambda"] },
    },
  ];

  it.each(rejections)("rejects: $label", ({ arn, opts }) => {
    expect(() => assertSameAccountArn(arn, opts)).toThrow(ArnRejectedError);
  });
});

// ---------------------------------------------------------------------------
// assertCrossAccountRole
// ---------------------------------------------------------------------------

describe("assertCrossAccountRole", () => {
  const PLATFORM = "123456789012";
  const FOREIGN = "999888777666";

  it("accepts a cross-account IAM role with externalId", () => {
    const result = assertCrossAccountRole(
      `arn:aws:iam::${FOREIGN}:role/cross-role`,
      { platformAccountId: PLATFORM, externalId: "ext-123" },
    );
    expect(result.parsed.accountId).toBe(FOREIGN);
    expect(result.externalId).toBe("ext-123");
    expect(result.parsed.resource).toBe("role/cross-role");
  });

  const rejections: Array<{
    label: string;
    arn: string;
    opts: { platformAccountId: string; externalId: string };
  }> = [
    {
      label: "same account (must differ)",
      arn: `arn:aws:iam::${PLATFORM}:role/my-role`,
      opts: { platformAccountId: PLATFORM, externalId: "ext-123" },
    },
    {
      label: "not IAM service",
      arn: `arn:aws:lambda:us-east-1:${FOREIGN}:function:fn`,
      opts: { platformAccountId: PLATFORM, externalId: "ext-123" },
    },
    {
      label: "not a role resource",
      arn: `arn:aws:iam::${FOREIGN}:user/someone`,
      opts: { platformAccountId: PLATFORM, externalId: "ext-123" },
    },
    {
      label: "empty externalId",
      arn: `arn:aws:iam::${FOREIGN}:role/cross-role`,
      opts: { platformAccountId: PLATFORM, externalId: "" },
    },
    {
      label: "whitespace-only externalId",
      arn: `arn:aws:iam::${FOREIGN}:role/cross-role`,
      opts: { platformAccountId: PLATFORM, externalId: "   " },
    },
    {
      label: "malformed ARN",
      arn: "arn:aws:iam::bad:role/cross-role",
      opts: { platformAccountId: PLATFORM, externalId: "ext-123" },
    },
  ];

  it.each(rejections)("rejects: $label", ({ arn, opts }) => {
    expect(() => assertCrossAccountRole(arn, opts)).toThrow(ArnRejectedError);
  });
});
