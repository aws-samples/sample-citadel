/**
 * TDD: RDS adapter reads masterUsername/masterPassword from credentials
 * only — config fallback is removed (secret-field migration).
 *
 * RDS uses platformProvisionClient() so scoped-credential provenance
 * (WeakSet marker) is not required for provision. Plain credentials
 * carrying the secret fields suffice.
 */
import { RDSClient, CreateDBInstanceCommand } from "@aws-sdk/client-rds";
import { mockClient } from "aws-sdk-client-mock";

const rdsMock = mockClient(RDSClient);

import { RdsAdapter } from "../rds-adapter";

describe("RdsAdapter.provision - credential resolution", () => {
  const adapter = new RdsAdapter("postgres");

  beforeEach(() => {
    rdsMock.reset();
    rdsMock.on(CreateDBInstanceCommand).resolves({
      DBInstance: { DBInstanceArn: "arn:aws:rds:us-east-1:123:db:test" },
    });
  });

  test("reads masterUsername and masterPassword from credentials", async () => {
    const result = await adapter.provision(
      { dataStoreId: "ds-1", orgId: "org-1" },
      { masterUsername: "dbadmin", masterPassword: "pass123" },
    );
    expect(result.resourceArn).toBeDefined();
    const calls = rdsMock.commandCalls(CreateDBInstanceCommand);
    expect(calls[0].args[0].input.MasterUsername).toBe("dbadmin");
    expect(calls[0].args[0].input.MasterUserPassword).toBe("pass123");
  });

  test("throws when credentials are undefined", async () => {
    await expect(
      adapter.provision({ dataStoreId: "ds-1", orgId: "org-1" }, undefined),
    ).rejects.toThrow(/masterUsername/);
  });

  test("throws when credentials lack masterPassword", async () => {
    await expect(
      adapter.provision(
        { dataStoreId: "ds-1", orgId: "org-1" },
        { masterUsername: "admin" },
      ),
    ).rejects.toThrow(/masterPassword/);
  });

  test("ignores masterUsername/masterPassword in config — reads only from credentials", async () => {
    await adapter.provision(
      {
        dataStoreId: "ds-1",
        orgId: "org-1",
        masterUsername: "config-user",
        masterPassword: "config-pass",
      },
      { masterUsername: "cred-user", masterPassword: "cred-pass" },
    );

    const calls = rdsMock.commandCalls(CreateDBInstanceCommand);
    expect(calls[0].args[0].input.MasterUsername).toBe("cred-user");
    expect(calls[0].args[0].input.MasterUserPassword).toBe("cred-pass");
  });

  test("does not require scoped credentials — RDS provision uses the platform path", async () => {
    // Plain object (no WeakSet marker) with just the secret fields
    const result = await adapter.provision(
      { dataStoreId: "ds-1", orgId: "org-1" },
      { masterUsername: "dbadmin", masterPassword: "pass123" },
    );
    expect(result.resourceArn).toBeDefined();
  });
});
