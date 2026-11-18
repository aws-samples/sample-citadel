/**
 * Citadel PR-1 — H4: PolicyManager.assumeScopedRole must mark its returned
 * credentials with the non-forgeable provenance marker (credential-guard's
 * WeakSet), since it is the single production mint point every data-plane
 * adapter call ultimately depends on.
 */
import {
  STSClient,
  GetCallerIdentityCommand,
  AssumeRoleCommand,
} from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { PolicyManager } from "../policy-manager";
import { isScopedCredentials } from "../../lambda/adapters/credential-guard";

const stsMock = mockClient(STSClient);

describe("PolicyManager.assumeScopedRole credential provenance (H4)", () => {
  beforeEach(() => {
    stsMock.reset();
    stsMock.on(GetCallerIdentityCommand).resolves({
      Account: "123456789012",
      Arn: "arn:aws:sts::123456789012:assumed-role/LambdaRole/session",
    });
  });

  it("marks the returned ScopedCredentials with the provenance marker", async () => {
    stsMock.on(AssumeRoleCommand).resolves({
      Credentials: {
        AccessKeyId: "AK",
        SecretAccessKey: "SK",
        SessionToken: "ST",
        Expiration: new Date("2030-01-01T00:00:00Z"),
      },
    });

    const pm = new PolicyManager();
    const creds = await pm.assumeScopedRole(
      "ds-1",
      "123456789012",
      "datastore",
    );

    expect(isScopedCredentials(creds)).toBe(true);
  });

  it("a plain object with identical fields built independently is NOT marked", async () => {
    stsMock.on(AssumeRoleCommand).resolves({
      Credentials: {
        AccessKeyId: "AK",
        SecretAccessKey: "SK",
        SessionToken: "ST",
      },
    });

    const pm = new PolicyManager();
    const creds = await pm.assumeScopedRole(
      "ds-1",
      "123456789012",
      "datastore",
    );

    const forged = {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    };
    expect(isScopedCredentials(forged)).toBe(false);
  });
});
