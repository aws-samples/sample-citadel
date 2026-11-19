/**
 * TDD: Redshift adapter reads masterUsername/masterPassword from credentials
 * only — config fallback is removed (secret-field migration).
 */
import { RedshiftClient, CreateClusterCommand } from "@aws-sdk/client-redshift";
import { mockClient } from "aws-sdk-client-mock";
import { MOCK_SCOPED_CREDENTIALS } from "./helpers/mock-credentials";
import { markScopedCredentials } from "../credential-guard";

const rsMock = mockClient(RedshiftClient);

import { RedshiftAdapter } from "../redshift-adapter";

describe("RedshiftAdapter.provision - credential resolution", () => {
  const adapter = new RedshiftAdapter();

  beforeEach(() => {
    rsMock.reset();
    rsMock
      .on(CreateClusterCommand)
      .resolves({ Cluster: { ClusterIdentifier: "test" } });
  });

  test("reads masterUsername/masterPassword from credentials", async () => {
    const result = await adapter.provision(
      { clusterIdentifier: "test" },
      markScopedCredentials({
        ...MOCK_SCOPED_CREDENTIALS,
        masterUsername: "admin",
        masterPassword: "Secret123!",
      }),
    );

    expect(result.resourceArn).toBeDefined();
    const calls = rsMock.commandCalls(CreateClusterCommand);
    expect(calls[0].args[0].input.MasterUsername).toBe("admin");
    expect(calls[0].args[0].input.MasterUserPassword).toBe("Secret123!");
  });

  test("throws when credentials lack masterUsername", async () => {
    await expect(
      adapter.provision({ clusterIdentifier: "test" }, MOCK_SCOPED_CREDENTIALS),
    ).rejects.toThrow(/masterUsername/);
  });

  test("ignores masterUsername/masterPassword in config", async () => {
    await adapter.provision(
      {
        clusterIdentifier: "test",
        masterUsername: "config-user",
        masterPassword: "Config1pass",
      },
      markScopedCredentials({
        ...MOCK_SCOPED_CREDENTIALS,
        masterUsername: "cred-admin",
        masterPassword: "Cred1pass!",
      }),
    );

    const calls = rsMock.commandCalls(CreateClusterCommand);
    expect(calls[0].args[0].input.MasterUsername).toBe("cred-admin");
    expect(calls[0].args[0].input.MasterUserPassword).toBe("Cred1pass!");
  });
});
