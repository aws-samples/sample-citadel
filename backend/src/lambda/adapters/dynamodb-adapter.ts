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

export class DynamoDBAdapter implements ConnectorAdapter {
  readonly category: ConnectorCategory = 'datastore';
  readonly spec: ConnectorSpec = { type: 'DYNAMODB', provider: 'Amazon Web Services', category: 'datastore', authentication: { method: AuthenticationMethod.IAM_ROLE, fields: [], secretStructure: {} }, configuration: { required: ['tableName'], optional: ['partitionKey', 'sortKey'], ssmParameters: [] } };
  private makeClient(creds?: Record<string, any>): DynamoDBClient {
    if (creds?.accessKeyId && creds?.secretAccessKey && creds?.sessionToken) {
      return new DynamoDBClient({
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        },
      });
    }
    return new DynamoDBClient({});
  }

  requiredPolicies(
    config: Record<string, any>,
    accountId: string,
    region: string
  ): RequiredPolicies {
    const tableName = config.tableName;
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
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<ProvisionResult> {
    const client = this.makeClient(credentials);
    const tableName = config.tableName;
    const partitionKey = config.partitionKey || 'pk';
    const sortKey = config.sortKey || undefined;

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
    } catch (error: any) {
      if (error.name === 'ResourceInUseException') {
        // Idempotent success — table already exists
      } else if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied creating table ${tableName}`,
          error
        );
      } else {
        throw new ProvisioningError(
          `Failed to create table ${tableName}: ${error.message}`,
          error
        );
      }
    }

    return {
      resourceArn: `arn:aws:dynamodb:${config.region ?? 'us-east-1'}:${config.accountId ?? '000000000000'}:table/${tableName}`,
    };
  }

  async connect(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const tableName = config.tableName;

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
    } catch (error: any) {
      if (error instanceof ConnectionError) {
        throw error;
      }
      if (
        error.name === 'ResourceNotFoundException'
      ) {
        throw new ResourceNotFoundError(
          `Table ${tableName} does not exist`,
          error
        );
      }
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied accessing table ${tableName}`,
          error
        );
      }
      throw new ConnectionError(
        `Failed to connect to table ${tableName}: ${error.message}`,
        true,
        error
      );
    }
  }

  async disconnect(_config: Record<string, any>): Promise<void> {
    // No-op: disconnecting from DynamoDB doesn't require cleanup
  }

  async deprovision(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<void> {
    const client = this.makeClient(credentials);
    const tableName = config.tableName;

    try {
      await client.send(new DeleteTableCommand({ TableName: tableName }));
    } catch (error: any) {
      if (error.name === 'ResourceNotFoundException') {
        return; // Already gone
      }
      throw error;
    }
  }

  async testConnection(
    config: Record<string, any>,
    credentials?: Record<string, any>
  ): Promise<ConnectionTestResult> {
    const client = this.makeClient(credentials);
    const tableName = config.tableName;

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
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to connect to table ${tableName}: ${error.message}`,
        details: { errorName: error.name },
      };
    }
  }

  async getMetrics(
    config: Record<string, any>,
    _resourceArn?: string
  ): Promise<MetricsResult> {
    const client = this.makeClient();
    const tableName = config.tableName;

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
    } catch (error: any) {
      if (
        error.name === 'AccessDenied' ||
        error.name === 'AccessDeniedException'
      ) {
        throw new PermissionError(
          `Permission denied describing table ${tableName}`,
          error
        );
      }
      throw new ConnectionError(
        `Failed to get metrics for table ${tableName}: ${error.message}`,
        true,
        error
      );
    }
  }
}
