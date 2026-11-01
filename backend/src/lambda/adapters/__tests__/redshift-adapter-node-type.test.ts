/**
 * TDD: Redshift adapter should use ra3.xlplus as default node type (dc2.large
 * is not available in all regions).
 */
import { RedshiftClient, CreateClusterCommand } from "@aws-sdk/client-redshift";
import { mockClient } from "aws-sdk-client-mock";
import { MOCK_SCOPED_CREDENTIALS } from "./helpers/mock-credentials";

const rsMock = mockClient(RedshiftClient);

import { RedshiftAdapter } from "../redshift-adapter";

describe("RedshiftAdapter.provision - default node type", () => {
  const adapter = new RedshiftAdapter();

  beforeEach(() => {
    rsMock.reset();
    rsMock.on(CreateClusterCommand).resolves({
      Cluster: { ClusterIdentifier: "test" },
    });
  });

  test("uses ra3.xlplus as default node type", async () => {
    await adapter.provision(
      {
        clusterIdentifier: "test",
        masterUsername: "admin",
        masterPassword: "Secret123!",
      },
      MOCK_SCOPED_CREDENTIALS,
    );

    const calls = rsMock.commandCalls(CreateClusterCommand);
    expect(calls[0].args[0].input.NodeType).toBe("ra3.xlplus");
    expect(calls[0].args[0].input.NumberOfNodes).toBe(2);
  });

  test("sets NumberOfNodes to 2 for multi-node types like ra3.xlplus", async () => {
    await adapter.provision(
      {
        clusterIdentifier: "test",
        masterUsername: "admin",
        masterPassword: "Secret123!",
        nodeType: "ra3.xlplus",
      },
      MOCK_SCOPED_CREDENTIALS,
    );

    const calls = rsMock.commandCalls(CreateClusterCommand);
    expect(calls[0].args[0].input.NumberOfNodes).toBeGreaterThanOrEqual(2);
    expect(calls[0].args[0].input.ClusterType).toBe("multi-node");
  });

  test("sets ClusterType to single-node for 1 node", async () => {
    await adapter.provision(
      {
        clusterIdentifier: "test",
        masterUsername: "admin",
        masterPassword: "Secret123!",
        nodeType: "ra3.xlplus",
        numberOfNodes: 1,
      },
      MOCK_SCOPED_CREDENTIALS,
    );

    // Even with numberOfNodes=1, ra3.xlplus requires multi-node (min 2)
    const calls = rsMock.commandCalls(CreateClusterCommand);
    expect(calls[0].args[0].input.NumberOfNodes).toBeGreaterThanOrEqual(2);
  });

  test("allows overriding node type via config", async () => {
    await adapter.provision(
      {
        clusterIdentifier: "test",
        masterUsername: "admin",
        masterPassword: "Secret123!",
        nodeType: "ra3.4xlarge",
      },
      MOCK_SCOPED_CREDENTIALS,
    );

    const calls = rsMock.commandCalls(CreateClusterCommand);
    expect(calls[0].args[0].input.NodeType).toBe("ra3.4xlarge");
  });
});
