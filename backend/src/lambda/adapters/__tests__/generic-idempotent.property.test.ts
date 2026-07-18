import * as fc from 'fast-check';
import { AwsGenericAdapter } from '../aws-generic-adapter';
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
import { NotImplementedError } from '../../../adapters/errors';
import type { ConnectorAdapter } from '../../../adapters/base';

/** Adapter with a concrete provision method (all datastore adapters under test). */
type ProvisioningAdapter = ConnectorAdapter & Required<Pick<ConnectorAdapter, 'provision'>>;

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

// STS mock for KnowledgeBaseAdapter.getAccountContext()
jest.mock('@aws-sdk/client-sts', () => ({
  STSClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({ Account: '123456789012' }),
    config: { region: () => Promise.resolve('us-west-2') },
  })),
  GetCallerIdentityCommand: jest.fn(),
}));

const allMocks = [
  mockS3Send, mockDdbSend, mockRdsSend, mockRedshiftSend, mockOssSend,
  mockNeptuneSend, mockTimestreamSend, mockElastiCacheSend, mockKeyspacesSend,
  mockDocDbSend, mockLakeFormationSend, mockS3TablesSend, mockSageMakerSend,
  mockBedrockAgentSend,
];

// Feature: datastore-adapter-pattern, Property 10: Generic adapter refuses to fake success
// Validates: Requirements 8.3 (fail loudly instead of pretending to succeed)
//
// Previously this property tested that AwsGenericAdapter returned hardcoded
// { success: true } / a fabricated ARN. That silent-success behavior masked
// every integration failure across the registry. The adapter now throws
// NotImplementedError so unimplemented connector types fail loudly.
describe('Property 10: Generic adapter throws NotImplementedError instead of faking success', () => {
  // NotImplementedError is imported from the canonical adapters/errors module
  // at the top of this file.
  const serviceNameArb = fc.constantFrom(    'knowledge-base', 'aurora-postgresql', 'aurora-mysql', 'redshift',
    'lake-formation', 'opensearch', 'neptune', 'timestream',
    'documentdb', 'elasticache-redis', 'keyspaces', 'qldb',
    'sagemaker-feature-store'
  );
  const configArb = fc.dictionary(
    fc.string({ minLength: 1, maxLength: 20 }),
    fc.string({ minLength: 0, maxLength: 50 }),
    { minKeys: 0, maxKeys: 5 }
  );

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('testConnection throws NotImplementedError for any service name and config', async () => {
    await fc.assert(
      fc.asyncProperty(serviceNameArb, configArb, async (serviceName, config) => {
        const adapter = new AwsGenericAdapter(serviceName);
        await expect(adapter.testConnection(config)).rejects.toBeInstanceOf(NotImplementedError);
      }),
      { numRuns: 100 }
    );
  });

  it('provision throws NotImplementedError for any service name and config', async () => {
    await fc.assert(
      fc.asyncProperty(serviceNameArb, configArb, async (serviceName, config) => {
        const adapter = new AwsGenericAdapter(serviceName);
        await expect(adapter.provision(config)).rejects.toBeInstanceOf(NotImplementedError);
      }),
      { numRuns: 100 }
    );
  });

  it('NotImplementedError messages always contain the serviceName', async () => {
    await fc.assert(
      fc.asyncProperty(serviceNameArb, async (serviceName) => {
        const adapter = new AwsGenericAdapter(serviceName);
        try {
          await adapter.testConnection({});
          fail('Expected NotImplementedError');
        } catch (err) {
          expect(err).toBeInstanceOf(NotImplementedError);
          expect((err as Error).message).toContain(serviceName);
        }
      }),
      { numRuns: 100 }
    );
  });
});

// Feature: datastore-adapter-pattern, Property 16: Adapter idempotent provisioning on already-exists
// Validates: Requirements 11.5
describe('Property 16: Adapter idempotent provisioning on already-exists', () => {
  beforeEach(() => {
    allMocks.forEach((m) => m.mockReset());
  });

  // Each adapter entry: [name, adapter factory, mockSend, config, credentials, alreadyExistsErrorName]
  const adapterCases: Array<{
    name: string;
    create: () => ProvisioningAdapter;
    mock: jest.Mock;
    config: Record<string, unknown>;
    creds?: Record<string, string>;
    errorName: string;
  }> = [
    {
      name: 'S3Adapter',
      create: () => new S3Adapter(),
      mock: mockS3Send,
      config: { bucketName: 'test-bucket' },
      errorName: 'BucketAlreadyOwnedByYou',
    },
    {
      name: 'DynamoDBAdapter',
      create: () => new DynamoDBAdapter(),
      mock: mockDdbSend,
      config: { tableName: 'test-table' },
      errorName: 'ResourceInUseException',
    },
    {
      name: 'RdsAdapter',
      create: () => new RdsAdapter('postgres'),
      mock: mockRdsSend,
      config: { dbInstanceIdentifier: 'test-db' },
      creds: { masterUsername: 'u', masterPassword: 'p' },
      errorName: 'DBInstanceAlreadyExistsFault',
    },
    {
      name: 'AuroraAdapter',
      create: () => new AuroraAdapter('postgres'),
      mock: mockRdsSend,
      config: { dbClusterIdentifier: 'test-cluster' },
      creds: { masterUsername: 'u', masterPassword: 'p' },
      errorName: 'DBClusterAlreadyExistsFault',
    },
    {
      name: 'RedshiftAdapter',
      create: () => new RedshiftAdapter(),
      mock: mockRedshiftSend,
      config: { clusterIdentifier: 'test-cluster' },
      creds: { masterUsername: 'admin', masterPassword: 'Test1pass' },
      errorName: 'ClusterAlreadyExistsFault',
    },
    {
      name: 'OpenSearchAdapter',
      create: () => new OpenSearchAdapter(),
      mock: mockOssSend,
      config: { collectionName: 'test-collection' },
      errorName: 'ConflictException',
    },
    {
      name: 'NeptuneAdapter',
      create: () => new NeptuneAdapter(),
      mock: mockNeptuneSend,
      config: { dbClusterIdentifier: 'test-neptune' },
      errorName: 'DBClusterAlreadyExistsFault',
    },
    {
      name: 'TimestreamAdapter',
      create: () => new TimestreamAdapter(),
      mock: mockTimestreamSend,
      config: { databaseName: 'test-db' },
      errorName: 'ConflictException',
    },
    {
      name: 'ElastiCacheAdapter',
      create: () => new ElastiCacheAdapter(),
      mock: mockElastiCacheSend,
      config: { cacheClusterId: 'test-cache' },
      errorName: 'CacheClusterAlreadyExistsFault',
    },
    {
      name: 'KeyspacesAdapter',
      create: () => new KeyspacesAdapter(),
      mock: mockKeyspacesSend,
      config: { keyspaceName: 'test-keyspace' },
      errorName: 'ConflictException',
    },
    {
      name: 'DocumentDBAdapter',
      create: () => new DocumentDBAdapter(),
      mock: mockDocDbSend,
      config: { dbClusterIdentifier: 'test-docdb' },
      creds: { masterUsername: 'u', masterPassword: 'p' },
      errorName: 'DBClusterAlreadyExistsFault',
    },
    {
      name: 'LakeFormationAdapter',
      create: () => new LakeFormationAdapter(),
      mock: mockLakeFormationSend,
      config: { resourceArn: 'arn:aws:s3:::test-bucket' },
      errorName: 'AlreadyExistsException',
    },
    {
      name: 'S3TablesAdapter',
      create: () => new S3TablesAdapter(),
      mock: mockS3TablesSend,
      config: { tableBucketName: 'test-bucket' },
      errorName: 'ConflictException',
    },
    {
      name: 'SageMakerLakehouseAdapter',
      create: () => new SageMakerLakehouseAdapter(),
      mock: mockSageMakerSend,
      config: { featureGroupName: 'test-fg' },
      errorName: 'ResourceInUse',
    },
    {
      name: 'SageMakerFeatureStoreAdapter',
      create: () => new SageMakerFeatureStoreAdapter(),
      mock: mockSageMakerSend,
      config: { featureGroupName: 'test-fg' },
      errorName: 'ResourceInUse',
    },
    {
      name: 'KnowledgeBaseAdapter',
      create: () => { const a = new KnowledgeBaseAdapter(); a.roleCreationDelayMs = 0; return a; },
      mock: mockBedrockAgentSend,
      config: { name: 'test-kb', roleArn: 'arn:aws:iam::123456789012:role/test-role', collectionArn: 'arn:aws:aoss:us-east-1:123456789012:collection/test-col' },
      errorName: 'ConflictException',
    },
  ];

  // For each adapter, generate random error messages and verify idempotent success
  adapterCases.forEach(({ name, create, mock, config, creds, errorName }) => {
    it(`${name} returns successful ProvisionResult when "${errorName}" is thrown`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 100 }),
          async (errorMessage) => {
            allMocks.forEach((m) => m.mockReset());
            const adapter = create();
            const err = new Error(errorMessage);
            err.name = errorName;
            // Use mockRejectedValue (persistent) so multi-call adapters get the error on every call
            mock.mockRejectedValue(err);
            // For adapters that use multiple SDK clients (e.g. KnowledgeBase uses OSS + Bedrock),
            // also mock the OSS client to reject with the same error
            if (mock !== mockOssSend) {
              const ossErr = new Error(errorMessage);
              ossErr.name = errorName;
              mockOssSend.mockRejectedValue(ossErr);
            }

            const result = await adapter.provision(config, creds);
            expect(result).toBeDefined();
            expect(result.resourceArn).toBeTruthy();
            expect(result.resourceArn.length).toBeGreaterThan(0);
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
