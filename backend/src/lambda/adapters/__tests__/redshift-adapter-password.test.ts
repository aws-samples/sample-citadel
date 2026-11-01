/**
 * TDD: Redshift adapter should validate password requirements before calling API.
 * Redshift requires: 8-64 chars, at least 1 uppercase, 1 lowercase, 1 digit.
 */
import { RedshiftClient, CreateClusterCommand } from "@aws-sdk/client-redshift";
import { mockClient } from "aws-sdk-client-mock";
import { MOCK_SCOPED_CREDENTIALS } from "./helpers/mock-credentials";

const rsMock = mockClient(RedshiftClient);

import { RedshiftAdapter } from "../redshift-adapter";

describe("RedshiftAdapter.provision - password validation", () => {
  const adapter = new RedshiftAdapter();

  beforeEach(() => {
    rsMock.reset();
    rsMock
      .on(CreateClusterCommand)
      .resolves({ Cluster: { ClusterIdentifier: "test" } });
  });

  test("rejects password without uppercase letter", async () => {
    await expect(
      adapter.provision(
        {
          clusterIdentifier: "test",
          masterUsername: "admin",
          masterPassword: "alllowercase1",
        },
        MOCK_SCOPED_CREDENTIALS,
      ),
    ).rejects.toThrow(/uppercase/i);
  });

  test("rejects password without lowercase letter", async () => {
    await expect(
      adapter.provision(
        {
          clusterIdentifier: "test",
          masterUsername: "admin",
          masterPassword: "ALLUPPERCASE1",
        },
        MOCK_SCOPED_CREDENTIALS,
      ),
    ).rejects.toThrow(/lowercase/i);
  });

  test("rejects password without digit", async () => {
    await expect(
      adapter.provision(
        {
          clusterIdentifier: "test",
          masterUsername: "admin",
          masterPassword: "NoDigitsHere",
        },
        MOCK_SCOPED_CREDENTIALS,
      ),
    ).rejects.toThrow(/digit/i);
  });

  test("accepts valid password with uppercase, lowercase, and digit", async () => {
    const result = await adapter.provision(
      {
        clusterIdentifier: "test",
        masterUsername: "admin",
        masterPassword: "ValidPass1",
      },
      MOCK_SCOPED_CREDENTIALS,
    );
    expect(result.resourceArn).toBeDefined();
  });
});
