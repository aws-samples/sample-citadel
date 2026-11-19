import {
  RDSClient,
  CreateDBInstanceCommand,
  DeleteDBInstanceCommand,
  DescribeDBInstancesCommand,
  AddTagsToResourceCommand,
} from "@aws-sdk/client-rds";
import {
  ConnectorAdapter,
  ConnectorCategory,
  ConnectorSpec,
  AuthenticationMethod,
  RequiredPolicies,
  ProvisionResult,
  ConnectionTestResult,
  MetricsResult,
} from "../../adapters/base";
import {
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
} from "./errors";
import { SdkError } from "./sdk-types";
import { requireScopedCredentials } from "./credential-guard";

export class RdsAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = "datastore";
  readonly spec: ConnectorSpec;

  constructor(private engine: "postgres" | "mysql") {
    this.spec = {
      type: engine === "postgres" ? "RDS_POSTGRESQL" : "RDS_MYSQL",
      provider: "Amazon Web Services",
      category: "datastore",
      authentication: {
        method: AuthenticationMethod.IAM_ROLE,
        fields: [],
        secretStructure: {},
      },
      configuration: {
        required: ["instanceIdentifier"],
        optional: [],
        ssmParameters: [],
      },
    };
  }

  private makeClient(
    creds: Record<string, unknown> | undefined,
    op: string,
  ): RDSClient {
    const credentials = requireScopedCredentials(creds, {
      adapter: "RdsAdapter",
      op,
    });
    return new RDSClient({ credentials });
  }

  /**
   * Continuum C3 (PR-2): control-plane provisioning (CreateDBInstance/
   * DeleteDBInstance/DescribeDBInstances/AddTagsToResource) runs under the
   * datastore-resolver Lambda's directly-granted, tag/region-constrained
   * permissions — NOT under the scoped citadel-ds-<id> role, which is
   * minted connect-only post-provision. Named so the ambient-client guard
   * test can allowlist it explicitly.
   */
  private platformProvisionClient(): RDSClient {
    return new RDSClient({});
  }

  requiredPolicies(
    config: Record<string, unknown>,
    accountId: string,
    region: string,
  ): RequiredPolicies {
    const dbArn = `arn:aws:rds:${region}:${accountId}:db:${config.dbInstanceIdentifier ?? "*"}`;

    return {
      // Continuum C3 (PR-2): CDK-mirrored platform-only documentation —
      // never minted onto citadel-ds-<id>. Runs under
      // platformProvisionClient() using the resolver Lambda's
      // tag/region-constrained grants (backend-stack.ts).
      provision: [
        {
          actions: [
            "rds:CreateDBInstance",
            "rds:DeleteDBInstance",
            "rds:DescribeDBInstances",
            "rds:AddTagsToResource",
          ],
          resources: ["*"],
        },
      ],
      connect: [
        {
          actions: ["rds:DescribeDBInstances"],
          resources: [dbArn],
        },
      ],
    };
  }

  async provision(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>,
  ): Promise<ProvisionResult> {
    const client = this.platformProvisionClient();
    const identifier =
      (config.dbInstanceIdentifier as string | undefined) ??
      `citadel-${this.engine}-${Date.now()}`;
    const engineName = this.engine === "postgres" ? "postgres" : "mysql";

    const masterUsername = credentials?.masterUsername as string | undefined;
    const masterPassword = credentials?.masterPassword as string | undefined;

    if (!masterUsername || !masterPassword) {
      throw new ProvisioningError(
        "masterUsername and masterPassword are required to provision an RDS instance",
      );
    }

    // PostgreSQL reserves certain usernames
    const POSTGRES_RESERVED_USERNAMES = ["admin", "postgres", "rdsadmin"];
    if (
      this.engine === "postgres" &&
      POSTGRES_RESERVED_USERNAMES.includes(masterUsername.toLowerCase())
    ) {
      throw new ProvisioningError(
        `masterUsername "${masterUsername}" is a reserved word for PostgreSQL. Use a different username (e.g. "dbadmin").`,
      );
    }

    // Continuum C3 (PR-2): dataStoreId + orgId are required so the instance
    // can be tagged at create, backing the `aws:ResourceTag` condition that
    // bounds the platform role's DeleteDBInstance grant.
    const dataStoreId = config.dataStoreId as string | undefined;
    const orgId = config.orgId as string | undefined;
    if (!dataStoreId || !orgId) {
      throw new ProvisioningError(
        "RDS instance provisioning requires dataStoreId and orgId",
      );
    }

    try {
      const result = await client.send(
        new CreateDBInstanceCommand({
          DBInstanceIdentifier: identifier,
          Engine: engineName,
          DBInstanceClass:
            (config.dbInstanceClass as string | undefined) ?? "db.t3.micro",
          AllocatedStorage:
            (config.allocatedStorage as number | undefined) ?? 20,
          MasterUsername: masterUsername,
          MasterUserPassword: masterPassword,
          Tags: [
            { Key: "citadel:orgId", Value: orgId },
            { Key: "citadel:dataStoreId", Value: dataStoreId },
            { Key: "ManagedBy", Value: "citadel" },
          ],
        }),
      );

      const arn =
        result.DBInstance?.DBInstanceArn ??
        `arn:aws:rds:${config.region ?? "us-east-1"}:${config.accountId ?? "000000000000"}:db:${identifier}`;

      return { resourceArn: arn };
    } catch (error) {
      const err = error as SdkError;
      if (err.name === "DBInstanceAlreadyExistsFault") {
        // Idempotent success — ensure ownership tags are present (best-effort).
        try {
          const existingArn = `arn:aws:rds:${config.region ?? "us-east-1"}:${config.accountId ?? "000000000000"}:db:${identifier}`;
          await client.send(
            new AddTagsToResourceCommand({
              ResourceName: existingArn,
              Tags: [
                { Key: "citadel:orgId", Value: orgId },
                { Key: "citadel:dataStoreId", Value: dataStoreId },
                { Key: "ManagedBy", Value: "citadel" },
              ],
            }),
          );
        } catch {
          // best-effort — idempotent re-provision must not fail on tagging
        }
        return {
          resourceArn: `arn:aws:rds:${config.region ?? "us-east-1"}:${config.accountId ?? "000000000000"}:db:${identifier}`,
        };
      }
      if (err.name === "AccessDenied" || err.name === "AccessDeniedException") {
        throw new PermissionError(
          `Permission denied creating RDS instance ${identifier}`,
          err,
        );
      }
      throw new ProvisioningError(
        `Failed to create RDS instance ${identifier}: ${err.message}`,
        err,
      );
    }
  }

  async connect(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>,
  ): Promise<void> {
    const client = this.makeClient(credentials, "connect");
    const identifier = config.dbInstanceIdentifier as string | undefined;

    try {
      const response = await client.send(
        new DescribeDBInstancesCommand({
          DBInstanceIdentifier: identifier,
        }),
      );
      const status = response.DBInstances?.[0]?.DBInstanceStatus;
      if (status !== "available") {
        throw new ConnectionError(
          `RDS instance ${identifier} is not available (status: ${status})`,
          true,
        );
      }
    } catch (error) {
      const err = error as SdkError;
      if (err instanceof ConnectionError) {
        throw err;
      }
      if (err.name === "DBInstanceNotFoundFault") {
        throw new ResourceNotFoundError(
          `RDS instance ${identifier} does not exist`,
          err,
        );
      }
      if (err.name === "AccessDenied" || err.name === "AccessDeniedException") {
        throw new PermissionError(
          `Permission denied accessing RDS instance ${identifier}`,
          err,
        );
      }
      throw new ConnectionError(
        `Failed to connect to RDS instance ${identifier}: ${err.message}`,
        true,
        err,
      );
    }
  }

  async disconnect(
    _config: Record<string, unknown>,
    _credentials?: Record<string, unknown>,
  ): Promise<void> {
    // No-op: disconnecting from RDS doesn't require cleanup
  }

  async deprovision(
    config: Record<string, unknown>,
    _credentials?: Record<string, unknown>,
  ): Promise<void> {
    const client = this.platformProvisionClient();
    const identifier = config.dbInstanceIdentifier as string | undefined;

    try {
      await client.send(
        new DeleteDBInstanceCommand({
          DBInstanceIdentifier: identifier,
          SkipFinalSnapshot: true,
        }),
      );
    } catch (error) {
      const err = error as SdkError;
      if (err.name === "DBInstanceNotFoundFault") {
        return; // Already gone
      }
      throw err;
    }
  }

  async testConnection(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>,
  ): Promise<ConnectionTestResult> {
    const client = this.makeClient(credentials, "testConnection");
    const identifier = config.dbInstanceIdentifier as string | undefined;

    try {
      const response = await client.send(
        new DescribeDBInstancesCommand({
          DBInstanceIdentifier: identifier,
        }),
      );
      const instance = response.DBInstances?.[0];
      return {
        success: true,
        message: `Successfully connected to RDS instance ${identifier}`,
        details: {
          status: instance?.DBInstanceStatus,
          endpoint: instance?.Endpoint?.Address,
          port: instance?.Endpoint?.Port,
          engine: instance?.Engine,
          allocatedStorage: instance?.AllocatedStorage,
        },
      };
    } catch (error) {
      const err = error as SdkError;
      return {
        success: false,
        message: `Failed to connect to RDS instance ${identifier}: ${err.message}`,
        details: { errorName: err.name },
      };
    }
  }

  async getMetrics(
    config: Record<string, unknown>,
    _resourceArn?: string,
    credentials?: Record<string, unknown>,
  ): Promise<MetricsResult> {
    const client = this.makeClient(credentials, "getMetrics");
    const identifier = config.dbInstanceIdentifier as string | undefined;

    try {
      const response = await client.send(
        new DescribeDBInstancesCommand({
          DBInstanceIdentifier: identifier,
        }),
      );
      const instance = response.DBInstances?.[0];
      const allocatedGB = instance?.AllocatedStorage ?? 0;

      return {
        size: `${allocatedGB} GB`,
        records: 0, // RDS doesn't expose row count via API
      };
    } catch (error) {
      const err = error as SdkError;
      if (err.name === "AccessDenied" || err.name === "AccessDeniedException") {
        throw new PermissionError(
          `Permission denied describing RDS instance ${identifier}`,
          err,
        );
      }
      throw new ConnectionError(
        `Failed to get metrics for RDS instance ${identifier}: ${err.message}`,
        true,
        err,
      );
    }
  }
}
