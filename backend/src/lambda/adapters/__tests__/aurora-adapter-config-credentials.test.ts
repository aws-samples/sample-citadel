/**
 * TDD: Aurora adapter reads masterUsername/masterPassword from credentials
 * only — config fallback is removed (secret-field migration).
 */
import { RDSClient, CreateDBClusterCommand } from "@aws-sdk/client-rds";
import { mockClient } from "aws-sdk-client-mock";
import { MOCK_SCOPED_CREDENTIALS } from "./helpers/mock-credentials";
import { markScopedCredentials } from "../credential-guard";

const rdsMock = mockClient(RDSClient);

import { AuroraAdapter } from "../aurora-adapter";

describe("AuroraAdapter.provision - credential resolution", () => {
  const adapter = new AuroraAdapter("postgres");

  beforeEach(() => {
    rdsMock.reset();
    rdsMock.on(CreateDBClusterCommand).resolves({
      DBCluster: {
        DBClusterArn: "arn:aws:rds:us-east-1:123456789012:cluster:test-cluster",
        DBClusterIdentifier: "test-cluster",
      },
    });
  });

  test("reads masterUsername and masterPassword from credentials", async () => {
    const result = await adapter.provision(
      { dbClusterIdentifier: "test-cluster" },
      markScopedCredentials({
        ...MOCK_SCOPED_CREDENTIALS,
        masterUsername: "dbadmin",
        masterPassword: "secret123",
      }),
    );

    expect(result.resourceArn).toContain("test-cluster");
    const calls = rdsMock.commandCalls(CreateDBClusterCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.MasterUsername).toBe("dbadmin");
    expect(calls[0].args[0].input.MasterUserPassword).toBe("secret123");
  });

  test("throws when credentials lack masterUsername/masterPassword", async () => {
    await expect(
      adapter.provision(
        { dbClusterIdentifier: "test-cluster" },
        MOCK_SCOPED_CREDENTIALS,
      ),
    ).rejects.toThrow(/masterUsername/);
  });

  test("ignores masterUsername/masterPassword in config — reads only from credentials", async () => {
    await adapter.provision(
      {
        dbClusterIdentifier: "test-cluster",
        masterUsername: "config-user",
        masterPassword: "config-pass",
      },
      markScopedCredentials({
        ...MOCK_SCOPED_CREDENTIALS,
        masterUsername: "cred-user",
        masterPassword: "cred-pass",
      }),
    );

    const calls = rdsMock.commandCalls(CreateDBClusterCommand);
    expect(calls[0].args[0].input.MasterUsername).toBe("cred-user");
    expect(calls[0].args[0].input.MasterUserPassword).toBe("cred-pass");
  });
});
