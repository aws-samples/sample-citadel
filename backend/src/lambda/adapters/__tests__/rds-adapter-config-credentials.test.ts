/**
 * TDD: RDS adapter reads masterUsername/masterPassword from config (the
 * wizard sends them in config; the resolver never dispatches a caller-
 * supplied credentials payload to an IAM_ROLE adapter — see
 * dispatchCreds() in datastore-resolver.ts).
 *
 * Continuum C3 (PR-2): provision() now ignores its `credentials` argument
 * entirely and runs under platformProvisionClient() (ambient Lambda
 * execution role), so the "prefers credentials over config" case from the
 * pre-PR-2 contract no longer applies — there is no credentials-sourced
 * masterUsername/masterPassword path in production, and keeping that
 * fallback alive would have been dead code reachable only from a test.
 */
import { RDSClient, CreateDBInstanceCommand } from "@aws-sdk/client-rds";
import { mockClient } from "aws-sdk-client-mock";
import { MOCK_SCOPED_CREDENTIALS } from "./helpers/mock-credentials";

const rdsMock = mockClient(RDSClient);

import { RdsAdapter } from "../rds-adapter";

describe("RdsAdapter.provision - credential resolution", () => {
  const adapter = new RdsAdapter("postgres");

  beforeEach(() => {
    rdsMock.reset();
    rdsMock.on(CreateDBInstanceCommand).resolves({
      DBInstance: {
        DBInstanceArn: "arn:aws:rds:us-east-1:123456789012:db:test-db",
        DBInstanceIdentifier: "test-db",
      },
    });
  });

  test("reads masterUsername and masterPassword from config when credentials are undefined", async () => {
    const result = await adapter.provision(
      {
        dbInstanceIdentifier: "test-db",
        masterUsername: "dbadmin",
        masterPassword: "secret123",
        dataStoreId: "ds-1",
        orgId: "org-1",
      },
      undefined,
    );

    expect(result.resourceArn).toContain("test-db");
    const calls = rdsMock.commandCalls(CreateDBInstanceCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.MasterUsername).toBe("dbadmin");
    expect(calls[0].args[0].input.MasterUserPassword).toBe("secret123");
  });

  test("reads masterUsername and masterPassword from config when credentials argument is also present (ignored)", async () => {
    const result = await adapter.provision(
      {
        dbInstanceIdentifier: "test-db",
        masterUsername: "dbadmin",
        masterPassword: "secret123",
        dataStoreId: "ds-1",
        orgId: "org-1",
      },
      MOCK_SCOPED_CREDENTIALS,
    );

    expect(result.resourceArn).toContain("test-db");
    const calls = rdsMock.commandCalls(CreateDBInstanceCommand);
    expect(calls[0].args[0].input.MasterUsername).toBe("dbadmin");
    expect(calls[0].args[0].input.MasterUserPassword).toBe("secret123");
  });

  test("throws when config has no masterUsername", async () => {
    await expect(
      adapter.provision(
        {
          dbInstanceIdentifier: "test-db",
          dataStoreId: "ds-1",
          orgId: "org-1",
        },
        undefined,
      ),
    ).rejects.toThrow(/masterUsername/);
  });

  test("throws when dataStoreId/orgId are absent even if credentials are valid", async () => {
    await expect(
      adapter.provision(
        {
          dbInstanceIdentifier: "test-db",
          masterUsername: "dbadmin",
          masterPassword: "secret123",
        },
        undefined,
      ),
    ).rejects.toThrow(/dataStoreId and orgId/);
  });
});
