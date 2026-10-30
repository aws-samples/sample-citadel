/**
 * CIT-254 C21: policy-manager.ensureRole rejects non-IAM / cross-account-without-externalId principals.
 *
 * Per site: two negatives + one positive; trust policy snapshot shows sts:ExternalId condition.
 */
import {
  IAMClient,
  CreateRoleCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import {
  STSClient,
  GetCallerIdentityCommand,
  AssumeRoleCommand,
} from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { PolicyManager } from "../policy-manager";
import { PermissionError } from "../../lambda/adapters/errors";

const iamMock = mockClient(IAMClient);
const stsMock = mockClient(STSClient);

const PLATFORM = "123456789012";
const FOREIGN = "999888777666";

describe("CIT-254 C21 — ensureRole ARN binding", () => {
  beforeEach(() => {
    iamMock.reset();
    stsMock.reset();
    stsMock.on(GetCallerIdentityCommand).resolves({
      Account: PLATFORM,
      Arn: `arn:aws:sts::${PLATFORM}:assumed-role/LambdaRole/session`,
    });
    stsMock.on(AssumeRoleCommand).resolves({
      Credentials: {
        AccessKeyId: "AKIAEXAMPLE",
        SecretAccessKey: "secret",
        SessionToken: "token",
        Expiration: new Date("2030-01-01T00:00:00.000Z"),
      },
    });
    iamMock.on(CreateRoleCommand).resolves({});
    iamMock.on(PutRolePolicyCommand).resolves({});
  });

  // --- Negative: foreign account without externalId ---
  it("rejects a cross-account role ARN without externalId", async () => {
    await expect(
      new PolicyManager().ensureRole(
        "ds-1",
        [{ actions: ["s3:GetObject"], resources: ["*"] }],
        PLATFORM,
        "datastore",
        `arn:aws:iam::${FOREIGN}:role/CustomerRole`,
        undefined,
        undefined, // no externalId
      ),
    ).rejects.toThrow(PermissionError);

    // ensureRole must NOT have created the role
    expect(iamMock.commandCalls(CreateRoleCommand)).toHaveLength(0);
  });

  // --- Negative: non-IAM ARN (e.g. S3 bucket) ---
  it("rejects a non-IAM ARN (arn:aws:s3:::bucket)", async () => {
    await expect(
      new PolicyManager().ensureRole(
        "ds-2",
        [{ actions: ["s3:GetObject"], resources: ["*"] }],
        PLATFORM,
        "datastore",
        `arn:aws:s3:::some-bucket`,
      ),
    ).rejects.toThrow(PermissionError);

    expect(iamMock.commandCalls(CreateRoleCommand)).toHaveLength(0);
  });

  // --- Positive: valid cross-account IAM role with externalId ---
  it("accepts a cross-account IAM role with externalId and binds sts:ExternalId in trust policy", async () => {
    const externalId = "citadel-ext-abc";
    await new PolicyManager().ensureRole(
      "ds-3",
      [{ actions: ["s3:GetObject"], resources: ["*"] }],
      PLATFORM,
      "datastore",
      `arn:aws:iam::${FOREIGN}:role/CustomerRole`,
      undefined,
      externalId,
    );

    const createCalls = iamMock.commandCalls(CreateRoleCommand);
    expect(createCalls).toHaveLength(1);

    const trustPolicy = JSON.parse(
      createCalls[0].args[0].input.AssumeRolePolicyDocument as string,
    );

    // Snapshot: trust policy includes the cross-account principal + sts:ExternalId condition
    expect(trustPolicy.Statement[0].Condition).toEqual({
      StringEquals: { "sts:ExternalId": externalId },
    });

    const principals = Array.isArray(trustPolicy.Statement[0].Principal.AWS)
      ? trustPolicy.Statement[0].Principal.AWS
      : [trustPolicy.Statement[0].Principal.AWS];
    expect(principals).toContain(`arn:aws:iam::${FOREIGN}:role/CustomerRole`);
  });

  // --- Positive: same-account IAM role (no externalId required) ---
  it("accepts a same-account IAM role without externalId", async () => {
    await new PolicyManager().ensureRole(
      "ds-4",
      [{ actions: ["s3:GetObject"], resources: ["*"] }],
      PLATFORM,
      "datastore",
      `arn:aws:iam::${PLATFORM}:role/SameAccountRole`,
    );

    const createCalls = iamMock.commandCalls(CreateRoleCommand);
    expect(createCalls).toHaveLength(1);
    const trustPolicy = JSON.parse(
      createCalls[0].args[0].input.AssumeRolePolicyDocument as string,
    );
    // No condition when no externalId is provided for same-account
    expect(trustPolicy.Statement[0].Condition).toBeUndefined();
  });

  // --- Negative: additionalTrustedPrincipals with a non-IAM ARN ---
  it("rejects a non-IAM additional trusted principal", async () => {
    await expect(
      new PolicyManager().ensureRole(
        "ds-5",
        [{ actions: ["s3:GetObject"], resources: ["*"] }],
        PLATFORM,
        "datastore",
        undefined,
        [`arn:aws:s3:::evil-bucket`],
      ),
    ).rejects.toThrow(PermissionError);
  });
});
