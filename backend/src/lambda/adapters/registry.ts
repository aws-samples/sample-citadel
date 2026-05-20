import { ConnectorAdapter } from '../../adapters/base';
import { ValidationError } from './errors';
import { S3Adapter } from './s3-adapter';
import { DynamoDBAdapter } from './dynamodb-adapter';
import { RdsAdapter } from './rds-adapter';
import { AuroraAdapter } from './aurora-adapter';
import { RedshiftAdapter } from './redshift-adapter';
import { OpenSearchAdapter } from './opensearch-adapter';
import { NeptuneAdapter } from './neptune-adapter';
import { TimestreamAdapter } from './timestream-adapter';
import { ElastiCacheAdapter } from './elasticache-adapter';
import { KeyspacesAdapter } from './keyspaces-adapter';
import { DocumentDBAdapter } from './documentdb-adapter';
import { LakeFormationAdapter } from './lake-formation-adapter';
import { S3TablesAdapter } from './s3-tables-adapter';
import { SageMakerLakehouseAdapter } from './sagemaker-lakehouse-adapter';
import { SageMakerFeatureStoreAdapter } from './sagemaker-feature-store-adapter';
import { KnowledgeBaseAdapter } from './knowledge-base-adapter';
import { SnowflakeAdapter } from './snowflake-adapter';
import { DatabricksAdapter } from './databricks-adapter';
import { AwsGenericAdapter } from './aws-generic-adapter';
import { ExternalDatabaseAdapter } from './external-adapter';

const ADAPTER_MAP: Record<string, ConnectorAdapter> = Object.create(null);
Object.assign(ADAPTER_MAP, {
  // AWS adapters with dedicated implementations
  S3: new S3Adapter(),
  DYNAMODB: new DynamoDBAdapter(),
  RDS_POSTGRESQL: new RdsAdapter('postgres'),
  RDS_MYSQL: new RdsAdapter('mysql'),
  AURORA_POSTGRESQL: new AuroraAdapter('postgres'),
  AURORA_MYSQL: new AuroraAdapter('mysql'),
  REDSHIFT: new RedshiftAdapter(),
  OPENSEARCH: new OpenSearchAdapter(),
  NEPTUNE: new NeptuneAdapter(),
  TIMESTREAM: new TimestreamAdapter(),
  ELASTICACHE_REDIS: new ElastiCacheAdapter(),
  KEYSPACES: new KeyspacesAdapter(),
  DOCUMENTDB: new DocumentDBAdapter(),
  LAKE_FORMATION: new LakeFormationAdapter(),
  S3_TABLES: new S3TablesAdapter(),
  SAGEMAKER_LAKEHOUSE: new SageMakerLakehouseAdapter(),
  SAGEMAKER_FEATURE_STORE: new SageMakerFeatureStoreAdapter(),
  KNOWLEDGE_BASE: new KnowledgeBaseAdapter(),
  SNOWFLAKE: new SnowflakeAdapter(),
  DATABRICKS: new DatabricksAdapter(),

  // AWS generic fallback
  QLDB: new AwsGenericAdapter('qldb'),

  // External adapters
  EXTERNAL_POSTGRESQL: new ExternalDatabaseAdapter('postgresql'),
  EXTERNAL_MYSQL: new ExternalDatabaseAdapter('mysql'),
  EXTERNAL_MONGODB: new ExternalDatabaseAdapter('mongodb'),
  EXTERNAL_ELASTICSEARCH: new ExternalDatabaseAdapter('elasticsearch'),
  EXTERNAL_REDIS: new ExternalDatabaseAdapter('redis'),
  EXTERNAL_API: new ExternalDatabaseAdapter('api'),
});

export function getAdapter(type: string): ConnectorAdapter {
  const adapter = ADAPTER_MAP[type];
  if (!adapter) {
    throw new ValidationError(`Unsupported data store type: ${type}`);
  }
  return adapter;
}
