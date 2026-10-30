/**
 * Tests for CIT-254 H24 / C11 — getAgentInvocationSecret org-scoping.
 *
 * Verifies that getAgentInvocationSecret requires callerOrgId and delegates
 * to assertSecretRefInOrgNamespace before issuing the GetSecretValue call.
 *
 * Two-org negative per call site; platform-owned fixed-name secrets
 * are NOT routed through getAgentInvocationSecret (they use separate
 * GetSecretValueCommand paths), so they are unaffected by this guard.
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";
import { getAgentInvocationSecret } from "../credential-manager";
import { SecretRefRejectedError } from "../secret-ref-safety";

const smMock = mockClient(SecretsManagerClient);

const ORG_A = "org-alpha";
const ORG_B = "org-beta";
const SECRET_A = `/citadel/agents/${ORG_A}/secret-abc`;
const SECRET_B = `/citadel/agents/${ORG_B}/secret-xyz`;
const ARN_A = `arn:aws:secretsmanager:us-east-1:123456789012:secret:${SECRET_A}-AbCdEf`;
const ARN_B = `arn:aws:secretsmanager:us-east-1:123456789012:secret:${SECRET_B}-AbCdEf`;

beforeEach(() => {
  smMock.reset();
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("getAgentInvocationSecret — happy path", () => {
  it("returns the secret when ref matches callerOrgId (path-style)", async () => {
    smMock.on(GetSecretValueCommand).resolves({ SecretString: "s3cr3t" });
    const result = await getAgentInvocationSecret(SECRET_A, ORG_A);
    expect(result).toBe("s3cr3t");
    const calls = smMock.commandCalls(GetSecretValueCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.SecretId).toBe(SECRET_A);
  });

  it("returns the secret when ref matches callerOrgId (ARN-style)", async () => {
    smMock.on(GetSecretValueCommand).resolves({ SecretString: "arn-secret" });
    const result = await getAgentInvocationSecret(ARN_A, ORG_A);
    expect(result).toBe("arn-secret");
  });

  it("accepts integration-type secret for the owning org", async () => {
    const intRef = `/citadel/integrations/${ORG_A}/confluence-int-1`;
    smMock.on(GetSecretValueCommand).resolves({ SecretString: "int-secret" });
    const result = await getAgentInvocationSecret(intRef, ORG_A);
    expect(result).toBe("int-secret");
  });
});

// ---------------------------------------------------------------------------
// Two-org negative (cross-tenant rejection)
// ---------------------------------------------------------------------------

describe("getAgentInvocationSecret — two-org negative", () => {
  it("rejects path-style ref belonging to org-B when caller is org-A", async () => {
    await expect(getAgentInvocationSecret(SECRET_B, ORG_A)).rejects.toThrow(
      SecretRefRejectedError,
    );
    // GetSecretValue must NOT have been called.
    expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(0);
  });

  it("rejects ARN-style ref belonging to org-B when caller is org-A", async () => {
    await expect(getAgentInvocationSecret(ARN_B, ORG_A)).rejects.toThrow(
      SecretRefRejectedError,
    );
    expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(0);
  });

  it("rejects non-Citadel-namespaced ref", async () => {
    await expect(
      getAgentInvocationSecret("admin-password", ORG_A),
    ).rejects.toThrow(SecretRefRejectedError);
    expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(0);
  });

  it("rejects bare secret name outside /citadel/ prefix", async () => {
    await expect(
      getAgentInvocationSecret("citadel/gateway-oauth-dev", ORG_A),
    ).rejects.toThrow(SecretRefRejectedError);
    expect(smMock.commandCalls(GetSecretValueCommand)).toHaveLength(0);
  });

  it("produces identical opaque error for missing vs foreign ref", async () => {
    const foreignErr = await getAgentInvocationSecret(SECRET_B, ORG_A).catch(
      (e: Error) => e.message,
    );
    const nonCitadelErr = await getAgentInvocationSecret(
      "some-random-secret",
      ORG_A,
    ).catch((e: Error) => e.message);
    expect(foreignErr).toBe("Access denied");
    expect(nonCitadelErr).toBe("Access denied");
  });
});

// ---------------------------------------------------------------------------
// Error from Secrets Manager (secret exists but no string value)
// ---------------------------------------------------------------------------

describe("getAgentInvocationSecret — Secrets Manager errors", () => {
  it("throws when SecretString is empty", async () => {
    smMock
      .on(GetSecretValueCommand)
      .resolves({ SecretString: undefined } as never);
    await expect(getAgentInvocationSecret(SECRET_A, ORG_A)).rejects.toThrow(
      "has no string value",
    );
  });

  it("does not leak the secretRef in the error message", async () => {
    smMock
      .on(GetSecretValueCommand)
      .resolves({ SecretString: undefined } as never);
    const err = await getAgentInvocationSecret(SECRET_A, ORG_A).catch(
      (e: Error) => e.message,
    );
    expect(err).not.toContain(SECRET_A);
    expect(err).not.toContain("org-alpha");
  });
});
