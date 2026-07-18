import {
  DynamoDBClient,
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  KeyType,
  ScalarAttributeType,
  BillingMode,
} from '@aws-sdk/client-dynamodb';
import {
  ConnectorAdapter,
  ConnectorCategory,
  ConnectorSpec,
  AuthenticationMethod,
  RequiredPolicies,
  ProvisionResult,
  ConnectionTestResult,
  MetricsResult,
} from '../../adapters/base';
import {
  ProvisioningError,
  ConnectionError,
  PermissionError,
  ResourceNotFoundError,
} from './errors';
import { SdkError, AwsCredentialFields } from './sdk-types';

export class DynamoDBAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec = { type: 'DYNAMODB', provider: 'Amazon Web Services', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['tableName'], optional: ['partitionKey', 'sortKey'], ssmParameters: [] } };
  private makeClient(creds?: Record<string, unknown>): DynamoDBClient {
    const c = creds as AwsCredentialFields | undefined;
    if (c?.accessKeyId && c?.secretAccessKey && c?.sessionToken) {
      return new DynamoDBClient({
        credentials: {
          accessKeyId: c.accessKeyId,
          secretAccessKey: c.secretAccessKey,
          sessionToken: c.sessionToken,
        },
      });
    }
    return new DynamoDBClient({});
  }

  requiredPolicies(
    config: Record<string, unknown>,
    accountId: string,
    region: string
  ): RequiredPolicies {
    const tableName = config.tableName as string | undefined;
    const tableArn = `arn:aws:dynamodb:${region}:${accountId}:table/${tableName}`;

    return {
      provision: [
        {
          actions: ['dynamodb:CreateTable', 'dynamodb:DeleteTable', 'dynamodb:DescribeTable'],
          resources: ['*'],
        },
      ],
      connect: [
        {
          actions: [
            'dynamodb:DescribeTable',
            'dynamodb:GetItem',
            'dynamodb:PutItem',
            'dynamodb:Query',
            'dynamodb:Scan',
          ],
          resources: [tableArn, `${tableArn}/index/*`],
        },
      ],
    };
  }

  async provision(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<ProvisionResult> {
    const client = this.makeClient(credentials);
    const tableName = config.tableName as string | undefined;
    const partitionKey = (config.partitionKey as string | undefined) || 'pk';
    const sortKey = (config.sortKey as string | undefined) || undefined;

    try {
      const keySchema = [
        { AttributeName: partitionKey, KeyType: KeyType.HASH },
        ...(sortKey ? [{ AttributeName: sortKey, KeyType: KeyType.RANGE }] : []),
      ];
      const attributeDefinitions = [
        { AttributeName: partitionKey, AttributeType: ScalarAttributeType.S },
        ...(sortKey ? [{ AttributeName: sortKey, AttributeType: ScalarAttributeType.S }] : []),
      ];

      await client.send(
        new CreateTableCommand({
          TableName: tableName,
          KeySchema: keySchema,
          AttributeDefinitions: attributeDefinitions,
          BillingMode: BillingMode.PAY_PER_REQUEST,
        })
      );
    } catch (error) {
      const err = error as SdkError;
      if (err.name === 'ResourceInUseException') {
        // Idempotent success — table already exists
      } else if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied creating table ${tableName}`,
          err
        );
      } else {
        throw new ProvisioningError(
          `Failed to create table ${tableName}: ${err.message}`,
          err
        );
      }
    }

    return {
      resourceArn: `arn:aws:dynamodb:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:table/${tableName}`,
    };
  }

  async connect(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const tableName = config.tableName as string | undefined;

    try {
      const response = await client.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      const status = response.Table?.TableStatus;
      if (status !== 'ACTIVE') {
        throw new ConnectionError(
          `Table ${tableName} is not active (status: ${status})`,
          true
        );
      }
    } catch (error) {
      const err = error as SdkError;
      if (err instanceof ConnectionError) {
        throw err;
      }
      if (
        err.name === 'ResourceNotFoundException'
      ) {
        throw new ResourceNotFoundError(
          `Table ${tableName} does not exist`,
          err
        );
      }
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied accessing table ${tableName}`,
          err
        );
      }
      throw new ConnectionError(
        `Failed to connect to table ${tableName}: ${err.message}`,
        true,
        err
      );
    }
  }

  async disconnect(_config: Record<string, unknown>): Promise<void> {
    // No-op: disconnecting from DynamoDB doesn't require cleanup
  }

  async deprovision(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const tableName = config.tableName as string | undefined;

    try {
      await client.send(new DeleteTableCommand({ TableName: tableName }));
    } catch (error) {
      const err = error as SdkError;
      if (err.name === 'ResourceNotFoundException') {
        return; // Already gone
      }
      throw err;
    }
  }

  async testConnection(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<ConnectionTestResult> {
    const client = this.makeClient(credentials);
    const tableName = config.tableName as string | undefined;

    try {
      const response = await client.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      const table = response.Table;
      return {
        success: true,
        message: `Successfully connected to table ${tableName}`,
        details: {
          tableStatus: table?.TableStatus,
          itemCount: table?.ItemCount ?? 0,
          tableSizeBytes: table?.TableSizeBytes ?? 0,
        },
      };
    } catch (error) {
      const err = error as SdkError;
      return {
        success: false,
        message: `Failed to connect to table ${tableName}: ${err.message}`,
        details: { errorName: err.name },
      };
    }
  }

  async getMetrics(
    config: Record<string, unknown>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    const client = this.makeClient();
    const tableName = config.tableName as string | undefined;

    try {
      const response = await client.send(
        new DescribeTableCommand({ TableName: tableName })
      );
      const table = response.Table;
      const sizeBytes = table?.TableSizeBytes ?? 0;
      const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);

      return {
        size: `${sizeMB} MB`,
        records: table?.ItemCount ?? 0,
      };
    } catch (error) {
      const err = error as SdkError;
      if (
        err.name === 'AccessDenied' ||
        err.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied describing table ${tableName}`,
          err
        );
      }
      throw new ConnectionError(
        `Failed to get metrics for table ${tableName}: ${err.message}`,
        true,
        err
      );
    }
  }
}
