import * as fc from 'fast-check';
import { getAdapter } from '../registry';
import { ValidationError } from '../errors';
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
import { ExternalDatabaseAdapter } from '../external-adapter';

// Mock all AWS SDK modules so adapter constructors don't fail
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  CreateBucketCommand: jest.fn(), PutBucketVersioningCommand: jest.fn(),
  HeadBucketCommand: jest.fn(), ListObjectsV2Command: jest.fn(),
}));
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  CreateTableCommand: jest.fn(), DescribeTableCommand: jest.fn(),
  KeyType: { HASH: 'HASH', RANGE: 'RANGE' },
  ScalarAttributeType: { S: 'S' },
  BillingMode: { PAY_PER_REQUEST: 'PAY_PER_REQUEST' },
}));
jest.mock('@aws-sdk/client-rds', () => ({
  RDSClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  CreateDBInstanceCommand: jest.fn(), DescribeDBInstancesCommand: jest.fn(),
  AddTagsToResourceCommand: jest.fn(), CreateDBClusterCommand: jest.fn(),
  DescribeDBClustersCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-redshift', () => ({
  RedshiftClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  CreateClusterCommand: jest.fn(), DescribeClustersCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-opensearchserverless', () => ({
  OpenSearchServerlessClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  CreateCollectionCommand: jest.fn(), BatchGetCollectionCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-neptune', () => ({
  NeptuneClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  CreateDBClusterCommand: jest.fn(), DescribeDBClustersCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-timestream-write', () => ({
  TimestreamWriteClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  CreateDatabaseCommand: jest.fn(), CreateTableCommand: jest.fn(),
  DescribeDatabaseCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-elasticache', () => ({
  ElastiCacheClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  CreateCacheClusterCommand: jest.fn(), DescribeCacheClustersCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-keyspaces', () => ({
  KeyspacesClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  CreateKeyspaceCommand: jest.fn(), GetKeyspaceCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-docdb', () => ({
  DocDBClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  CreateDBClusterCommand: jest.fn(), DescribeDBClustersCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-lakeformation', () => ({
  LakeFormationClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  RegisterResourceCommand: jest.fn(), GetDataLakeSettingsCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-s3tables', () => ({
  S3TablesClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  CreateTableBucketCommand: jest.fn(), GetTableBucketCommand: jest.fn(),
  ListTablesCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-sagemaker', () => ({
  SageMakerClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  CreateFeatureGroupCommand: jest.fn(), DescribeFeatureGroupCommand: jest.fn(),
}));
jest.mock('@aws-sdk/client-bedrock-agent', () => ({
  BedrockAgentClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  CreateKnowledgeBaseCommand: jest.fn(), GetKnowledgeBaseCommand: jest.fn(),
}));
jest.mock('snowflake-sdk', () => ({
  createConnection: jest.fn().mockReturnValue({ connect: jest.fn() }),
}));
jest.mock('@databricks/sql', () => ({
  DBSQLClient: jest.fn().mockImplementation(() => ({ connect: jest.fn() })),
}));

// All valid DataStoreType enum values and their expected adapter class
const TYPE_TO_CLASS: Array<[string, new (...args: never[]) => unknown]> = [
  ['S3', S3Adapter],
  ['DYNAMODB', DynamoDBAdapter],
  ['RDS_POSTGRESQL', RdsAdapter],
  ['RDS_MYSQL', RdsAdapter],
  ['AURORA_POSTGRESQL', AuroraAdapter],
  ['AURORA_MYSQL', AuroraAdapter],
  ['REDSHIFT', RedshiftAdapter],
  ['OPENSEARCH', OpenSearchAdapter],
  ['NEPTUNE', NeptuneAdapter],
  ['TIMESTREAM', TimestreamAdapter],
  ['ELASTICACHE_REDIS', ElastiCacheAdapter],
  ['KEYSPACES', KeyspacesAdapter],
  ['DOCUMENTDB', DocumentDBAdapter],
  ['LAKE_FORMATION', LakeFormationAdapter],
  ['S3_TABLES', S3TablesAdapter],
  ['SAGEMAKER_LAKEHOUSE', SageMakerLakehouseAdapter],
  ['SAGEMAKER_FEATURE_STORE', SageMakerFeatureStoreAdapter],
  ['KNOWLEDGE_BASE', KnowledgeBaseAdapter],
  ['SNOWFLAKE', SnowflakeAdapter],
  ['DATABRICKS', DatabricksAdapter],
  ['EXTERNAL_POSTGRESQL', ExternalDatabaseAdapter],
  ['EXTERNAL_MYSQL', ExternalDatabaseAdapter],
  ['EXTERNAL_MONGODB', ExternalDatabaseAdapter],
  ['EXTERNAL_ELASTICSEARCH', ExternalDatabaseAdapter],
  ['EXTERNAL_REDIS', ExternalDatabaseAdapter],
  ['EXTERNAL_API', ExternalDatabaseAdapter],
];

const ALL_VALID_TYPES = TYPE_TO_CLASS.map(([type]) => type);

// Feature: datastore-adapter-pattern, Property 11: Registry maps all types to correct adapter class
// Validates: Requirements 9.1, 9.2
describe('Property 11: Registry maps all types to correct adapter class', () => {
  it('getAdapter returns the correct adapter instance for every valid DataStoreType', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...TYPE_TO_CLASS),
        ([type, expectedClass]) => {
          const adapter = getAdapter(type);
          expect(adapter).toBeDefined();
          expect(adapter).toBeInstanceOf(expectedClass);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('getAdapter returns a non-null DataStoreAdapter with required methods for every type', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_VALID_TYPES),
        (type) => {
          const adapter = getAdapter(type);
          expect(adapter).not.toBeNull();
          expect(typeof adapter.requiredPolicies).toBe('function');
          expect(typeof adapter.provision).toBe('function');
          expect(typeof adapter.connect).toBe('function');
          expect(typeof adapter.disconnect).toBe('function');
          expect(typeof adapter.testConnection).toBe('function');
          expect(typeof adapter.getMetrics).toBe('function');
        }
      ),
      { numRuns: 100 }
    );
  });
});

// Feature: datastore-adapter-pattern, Property 12: Registry throws ValidationError for invalid types
// Validates: Requirements 9.3
describe('Property 12: Registry throws ValidationError for invalid types', () => {
  it('getAdapter throws ValidationError for any string not in DataStoreType', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).filter(
          (s) => !ALL_VALID_TYPES.includes(s)
        ),
        (invalidType) => {
          expect(() => getAdapter(invalidType)).toThrow(ValidationError);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('ValidationError message contains the invalid type string', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).filter(
          (s) => !ALL_VALID_TYPES.includes(s)
        ),
        (invalidType) => {
          try {
            getAdapter(invalidType);
            fail('Expected ValidationError');
          } catch (err) {
            expect(err).toBeInstanceOf(ValidationError);
            expect((err as ValidationError).message).toContain(invalidType);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
