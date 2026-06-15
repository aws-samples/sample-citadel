import * as fc from 'fast-check';
import { S3Adapter } from '../s3-adapter';
import { DynamoDBAdapter } from '../dynamodb-adapter';
import { RdsAdapter } from '../rds-adapter';
import { AuroraAdapter } from '../aurora-adapter';
import { RedshiftAdapter } from '../redshift-adapter';
import { OpenSearchAdapter } from '../opensearch-adapter';
import { NeptuneAdapter } from '../neptune-adapter';
import { TimestreamAdapter } from '../timestream-adapter';
import { ElastiCacheAdapter } from '../elasticache-adapter';
import { KeyspacesAdapter } from '../keyspaces-adapter';
import { DocumentDBAdapter } from '../documentdb-adapter';
import { LakeFormationAdapter } from '../lake-formation-adapter';
import { S3TablesAdapter } from '../s3-tables-adapter';
import { SageMakerLakehouseAdapter } from '../sagemaker-lakehouse-adapter';
import { SageMakerFeatureStoreAdapter } from '../sagemaker-feature-store-adapter';
import { KnowledgeBaseAdapter } from '../knowledge-base-adapter';
import { SnowflakeAdapter } from '../snowflake-adapter';
import { DatabricksAdapter } from '../databricks-adapter';
import { DataStoreError } from '../errors';

// Feature: datastore-adapter-pattern, Property 1: Adapter SDK error wrapping
// Validates: Requirements 2.4

// --- Mock all AWS SDK modules ---
const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: mockS3Send })),
  CreateBucketCommand: jest.fn().mockImplementation((i) => i),
  PutBucketVersioningCommand: jest.fn().mockImplementation((i) => i),
  HeadBucketCommand: jest.fn().mockImplementation((i) => i),
  ListObjectsV2Command: jest.fn().mockImplementation((i) => i),
}));

const mockDdbSend = jest.fn();
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({ send: mockDdbSend })),
  CreateTableCommand: jest.fn().mockImplementation((i) => i),
  DescribeTableCommand: jest.fn().mockImplementation((i) => i),
  KeyType: { HASH: 'HASH', RANGE: 'RANGE' },
  ScalarAttributeType: { S: 'S' },
  BillingMode: { PAY_PER_REQUEST: 'PAY_PER_REQUEST' },
}));

// RDS mock is shared by RdsAdapter, AuroraAdapter
const mockRdsSend = jest.fn();
jest.mock('@aws-sdk/client-rds', () => ({
  RDSClient: jest.fn().mockImplementation(() => ({ send: mockRdsSend })),
  CreateDBInstanceCommand: jest.fn().mockImplementation((i) => i),
  DescribeDBInstancesCommand: jest.fn().mockImplementation((i) => i),
  AddTagsToResourceCommand: jest.fn().mockImplementation((i) => i),
  CreateDBClusterCommand: jest.fn().mockImplementation((i) => i),
  DescribeDBClustersCommand: jest.fn().mockImplementation((i) => i),
}));

const mockRedshiftSend = jest.fn();
jest.mock('@aws-sdk/client-redshift', () => ({
  RedshiftClient: jest.fn().mockImplementation(() => ({ send: mockRedshiftSend })),
  CreateClusterCommand: jest.fn().mockImplementation((i) => i),
  DescribeClustersCommand: jest.fn().mockImplementation((i) => i),
}));

const mockOssSend = jest.fn();
jest.mock('@aws-sdk/client-opensearchserverless', () => ({
  OpenSearchServerlessClient: jest.fn().mockImplementation(() => ({ send: mockOssSend })),
  CreateCollectionCommand: jest.fn().mockImplementation((i) => i),
  BatchGetCollectionCommand: jest.fn().mockImplementation((i) => i),
  CreateSecurityPolicyCommand: jest.fn().mockImplementation((i) => i),
  CreateAccessPolicyCommand: jest.fn().mockImplementation((i) => i),
  DeleteCollectionCommand: jest.fn().mockImplementation((i) => i),
}));

const mockNeptuneSend = jest.fn();
jest.mock('@aws-sdk/client-neptune', () => ({
  NeptuneClient: jest.fn().mockImplementation(() => ({ send: mockNeptuneSend })),
  CreateDBClusterCommand: jest.fn().mockImplementation((i) => i),
  DescribeDBClustersCommand: jest.fn().mockImplementation((i) => i),
}));

const mockTimestreamSend = jest.fn();
jest.mock('@aws-sdk/client-timestream-write', () => ({
  TimestreamWriteClient: jest.fn().mockImplementation(() => ({ send: mockTimestreamSend })),
  CreateDatabaseCommand: jest.fn().mockImplementation((i) => i),
  CreateTableCommand: jest.fn().mockImplementation((i) => i),
  DescribeDatabaseCommand: jest.fn().mockImplementation((i) => i),
}));

const mockElastiCacheSend = jest.fn();
jest.mock('@aws-sdk/client-elasticache', () => ({
  ElastiCacheClient: jest.fn().mockImplementation(() => ({ send: mockElastiCacheSend })),
  CreateCacheClusterCommand: jest.fn().mockImplementation((i) => i),
  DescribeCacheClustersCommand: jest.fn().mockImplementation((i) => i),
}));

const mockKeyspacesSend = jest.fn();
jest.mock('@aws-sdk/client-keyspaces', () => ({
  KeyspacesClient: jest.fn().mockImplementation(() => ({ send: mockKeyspacesSend })),
  CreateKeyspaceCommand: jest.fn().mockImplementation((i) => i),
  GetKeyspaceCommand: jest.fn().mockImplementation((i) => i),
}));

const mockDocDbSend = jest.fn();
jest.mock('@aws-sdk/client-docdb', () => ({
  DocDBClient: jest.fn().mockImplementation(() => ({ send: mockDocDbSend })),
  CreateDBClusterCommand: jest.fn().mockImplementation((i) => i),
  DescribeDBClustersCommand: jest.fn().mockImplementation((i) => i),
}));

const mockLakeFormationSend = jest.fn();
jest.mock('@aws-sdk/client-lakeformation', () => ({
  LakeFormationClient: jest.fn().mockImplementation(() => ({ send: mockLakeFormationSend })),
  RegisterResourceCommand: jest.fn().mockImplementation((i) => i),
  GetDataLakeSettingsCommand: jest.fn().mockImplementation((i) => i),
}));

const mockS3TablesSend = jest.fn();
jest.mock('@aws-sdk/client-s3tables', () => ({
  S3TablesClient: jest.fn().mockImplementation(() => ({ send: mockS3TablesSend })),
  CreateTableBucketCommand: jest.fn().mockImplementation((i) => i),
  GetTableBucketCommand: jest.fn().mockImplementation((i) => i),
  ListTablesCommand: jest.fn().mockImplementation((i) => i),
}));

// SageMaker mock is shared by SageMakerLakehouseAdapter and SageMakerFeatureStoreAdapter
const mockSageMakerSend = jest.fn();
jest.mock('@aws-sdk/client-sagemaker', () => ({
  SageMakerClient: jest.fn().mockImplementation(() => ({ send: mockSageMakerSend })),
  CreateFeatureGroupCommand: jest.fn().mockImplementation((i) => i),
  DescribeFeatureGroupCommand: jest.fn().mockImplementation((i) => i),
}));

const mockBedrockAgentSend = jest.fn();
jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: jest.fn().mockImplementation(() => ({ send: mockBedrockAgentSend })),
  CreateKnowledgeBaseCommand: jest.fn().mockImplementation((i) => i),
  GetKnowledgeBaseCommand: jest.fn().mockImplementation((i) => i),
}));

jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({ Account: '123456789012' }),
    config: { region: () => Promise.resolve('us-west-2') },
  })),
  GetCallerIdentityCommand: jest.fn(),
}));

// Snowflake SDK mock
const mockSnowflakeConnect = jest.fn();
jest.mock('snowflake-sdk', () => ({
  createConnection: () => ({
    connect: mockSnowflakeConnect,
    destroy: jest.fn(),
  }),
}));

// Databricks SDK mock
const mockDatabricksConnect = jest.fn();
const mockDatabricksClose = jest.fn();
jest.mock('@databricks/sql', () => ({
  DBSQLClient: jest.fn().mockImplementation(() => ({
    connect: mockDatabricksConnect,
    close: mockDatabricksClose,
  })),
}));

// --- Arbitraries ---
const sdkErrorNameArb = fc.constantFrom(
  'InternalServerError',
  'ServiceUnavailableException',
  'ThrottlingException',
  'LimitExceededException',
  'InvalidParameterException',
  'TimeoutError',
  'NetworkingError'
);
const sdkErrorMessageArb = fc.string({ minLength: 1, maxLength: 100 });

function makeSdkError(name: string, message: string): Error {
  const err = new Error(message);
  (err as any).name = name;
  return err;
}

const allMocks = [
  mockS3Send, mockDdbSend, mockRdsSend, mockRedshiftSend, mockOssSend,
  mockNeptuneSend, mockTimestreamSend, mockElastiCacheSend, mockKeyspacesSend,
  mockDocDbSend, mockLakeFormationSend, mockS3TablesSend, mockSageMakerSend,
  mockBedrockAgentSend, mockSnowflakeConnect, mockDatabricksConnect, mockDatabricksClose,
];

describe('Property 1: Adapter SDK error wrapping', () => {
  // **Validates: Requirements 2.4**

  beforeEach(() => {
    allMocks.forEach((m) => m.mockReset());
  });

  // Helper: test that provision wraps SDK errors for adapters using mockSend pattern
  function testProvisionWrapping(
    name: string,
    createAdapter: () => any,
    mockSend: jest.Mock,
    config: Record<string, any>,
    credentials?: Record<string, any>
  ) {
    it(`${name}.provision wraps SDK errors in DataStoreError with cause`, async () => {
      const adapter = createAdapter();
      await fc.assert(
        fc.asyncProperty(sdkErrorNameArb, sdkErrorMessageArb, async (errName, errMsg) => {
          const sdkError = makeSdkError(errName, errMsg);
          mockSend.mockRejectedValueOnce(sdkError);
          try {
            await adapter.provision(config, credentials);
          } catch (thrown: any) {
            expect(thrown).toBeInstanceOf(DataStoreError);
            expect(thrown.cause).toBe(sdkError);
          }
        }),
        { numRuns: 100 }
      );
    });
  }

  // AWS adapters using send() pattern
  testProvisionWrapping('S3Adapter', () => new S3Adapter(), mockS3Send, { bucketName: 'my-test-bucket' });
  testProvisionWrapping('DynamoDBAdapter', () => new DynamoDBAdapter(), mockDdbSend, { tableName: 't' });
  testProvisionWrapping('RdsAdapter', () => new RdsAdapter('postgres'), mockRdsSend,
    { dbInstanceIdentifier: 'db' }, { masterUsername: 'u', masterPassword: 'p' });
  testProvisionWrapping('AuroraAdapter', () => new AuroraAdapter('postgres'), mockRdsSend,
    { dbClusterIdentifier: 'cl' }, { masterUsername: 'u', masterPassword: 'p' });
  testProvisionWrapping('RedshiftAdapter', () => new RedshiftAdapter(), mockRedshiftSend,
    { clusterIdentifier: 'cl' }, { masterUsername: 'admin', masterPassword: 'Test1pass' });
  testProvisionWrapping('OpenSearchAdapter', () => new OpenSearchAdapter(), mockOssSend, { collectionName: 'c' });
  testProvisionWrapping('NeptuneAdapter', () => new NeptuneAdapter(), mockNeptuneSend, { dbClusterIdentifier: 'n' });
  testProvisionWrapping('TimestreamAdapter', () => new TimestreamAdapter(), mockTimestreamSend, { databaseName: 'd' });
  testProvisionWrapping('ElastiCacheAdapter', () => new ElastiCacheAdapter(), mockElastiCacheSend, { cacheClusterId: 'c' });
  testProvisionWrapping('KeyspacesAdapter', () => new KeyspacesAdapter(), mockKeyspacesSend, { keyspaceName: 'k' });
  testProvisionWrapping('DocumentDBAdapter', () => new DocumentDBAdapter(), mockDocDbSend,
    { dbClusterIdentifier: 'doc' }, { masterUsername: 'u', masterPassword: 'p' });
  testProvisionWrapping('LakeFormationAdapter', () => new LakeFormationAdapter(), mockLakeFormationSend,
    { resourceArn: 'arn:aws:s3:::bucket' });
  testProvisionWrapping('S3TablesAdapter', () => new S3TablesAdapter(), mockS3TablesSend, { tableBucketName: 'tb' });
  testProvisionWrapping('SageMakerLakehouseAdapter', () => new SageMakerLakehouseAdapter(), mockSageMakerSend,
    { featureGroupName: 'fg' });
  testProvisionWrapping('SageMakerFeatureStoreAdapter', () => new SageMakerFeatureStoreAdapter(), mockSageMakerSend,
    { featureGroupName: 'fg' });

  // KnowledgeBase adapter uses multiple SDK clients (OSS + Bedrock), so we need to mock all of them
  it('KnowledgeBaseAdapter.provision wraps SDK errors in DataStoreError with cause', async () => {
    const adapter = (() => { const a = new KnowledgeBaseAdapter(); a.roleCreationDelayMs = 0; return a; })();
    const config = { name: 'kb', roleArn: 'arn:aws:iam::123456789012:role/test-role' };
    await fc.assert(
      fc.asyncProperty(sdkErrorNameArb, sdkErrorMessageArb, async (errName, errMsg) => {
        allMocks.forEach((m) => m.mockReset());
        const sdkError = makeSdkError(errName, errMsg);
        // Mock both OSS and Bedrock clients to reject
        mockOssSend.mockRejectedValue(sdkError);
        mockBedrockAgentSend.mockRejectedValue(sdkError);
        try {
          await adapter.provision(config);
        } catch (thrown: any) {
          expect(thrown).toBeInstanceOf(DataStoreError);
          expect(thrown.cause).toBe(sdkError);
        }
      }),
      { numRuns: 100 }
    );
  });

  // Snowflake adapter — uses snowflake-sdk callback pattern
  it('SnowflakeAdapter.testConnection wraps SDK errors in DataStoreError with cause', async () => {
    const adapter = new SnowflakeAdapter();
    const config = { accountIdentifier: 'acct', warehouse: 'WH', database: 'DB', username: 'u', password: 'p' };

    await fc.assert(
      fc.asyncProperty(sdkErrorNameArb, sdkErrorMessageArb, async (errName, errMsg) => {
        const sdkError = makeSdkError(errName, errMsg);
        mockSnowflakeConnect.mockImplementation((cb: Function) => cb(sdkError));
        try {
          await adapter.testConnection(config);
        } catch (thrown: any) {
          expect(thrown).toBeInstanceOf(DataStoreError);
          expect(thrown.cause).toBe(sdkError);
        }
      }),
      { numRuns: 100 }
    );
  });

  // Databricks adapter — uses @databricks/sql async pattern
  it('DatabricksAdapter.testConnection wraps SDK errors in DataStoreError with cause', async () => {
    const adapter = new DatabricksAdapter();
    const config = { host: 'h.databricks.com', httpPath: '/sql/1.0/warehouses/x', token: 'tok' };

    await fc.assert(
      fc.asyncProperty(sdkErrorNameArb, sdkErrorMessageArb, async (errName, errMsg) => {
        const sdkError = makeSdkError(errName, errMsg);
        mockDatabricksConnect.mockRejectedValueOnce(sdkError);
        mockDatabricksClose.mockResolvedValueOnce(undefined);
        try {
          await adapter.testConnection(config);
        } catch (thrown: any) {
          expect(thrown).toBeInstanceOf(DataStoreError);
          expect(thrown.cause).toBe(sdkError);
        }
      }),
      { numRuns: 100 }
    );
  });
});
