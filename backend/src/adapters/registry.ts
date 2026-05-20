/**
 * Unified Connector Registry
 *
 * Single registry for both datastore and integration adapters.
 * Wraps existing implementations to conform to the ConnectorAdapter interface.
 */

import { ConnectorAdapter, ConnectorCategory, ConnectorSpec } from './base';
import { ValidationError } from './errors';
import { BaseIntegrationAdapter } from './integration/base-integration-adapter';

// Import datastore adapters (now implement ConnectorAdapter directly)
import { S3Adapter } from '../lambda/adapters/s3-adapter';
import { DynamoDBAdapter } from '../lambda/adapters/dynamodb-adapter';
import { RdsAdapter } from '../lambda/adapters/rds-adapter';
import { AuroraAdapter } from '../lambda/adapters/aurora-adapter';
import { RedshiftAdapter } from '../lambda/adapters/redshift-adapter';
import { OpenSearchAdapter } from '../lambda/adapters/opensearch-adapter';
import { NeptuneAdapter } from '../lambda/adapters/neptune-adapter';
import { TimestreamAdapter } from '../lambda/adapters/timestream-adapter';
import { ElastiCacheAdapter } from '../lambda/adapters/elasticache-adapter';
import { KeyspacesAdapter } from '../lambda/adapters/keyspaces-adapter';
import { DocumentDBAdapter } from '../lambda/adapters/documentdb-adapter';
import { LakeFormationAdapter } from '../lambda/adapters/lake-formation-adapter';
import { S3TablesAdapter } from '../lambda/adapters/s3-tables-adapter';
import { SageMakerLakehouseAdapter } from '../lambda/adapters/sagemaker-lakehouse-adapter';
import { SageMakerFeatureStoreAdapter } from '../lambda/adapters/sagemaker-feature-store-adapter';
import { KnowledgeBaseAdapter } from '../lambda/adapters/knowledge-base-adapter';
import { SnowflakeAdapter } from '../lambda/adapters/snowflake-adapter';
import { DatabricksAdapter } from '../lambda/adapters/databricks-adapter';
import { AwsGenericAdapter } from '../lambda/adapters/aws-generic-adapter';
import { ExternalDatabaseAdapter } from '../lambda/adapters/external-adapter';

// Import integration connector specs
import { BACKEND_CONNECTOR_REGISTRY } from '../utils/connector-registry';

function buildDataStoreAdapters(): Record<string, ConnectorAdapter> {
  return {
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
    QLDB: new AwsGenericAdapter('qldb'),
    EXTERNAL_POSTGRESQL: new ExternalDatabaseAdapter('postgresql'),
    EXTERNAL_MYSQL: new ExternalDatabaseAdapter('mysql'),
    EXTERNAL_MONGODB: new ExternalDatabaseAdapter('mongodb'),
    EXTERNAL_ELASTICSEARCH: new ExternalDatabaseAdapter('elasticsearch'),
    EXTERNAL_REDIS: new ExternalDatabaseAdapter('redis'),
    EXTERNAL_API: new ExternalDatabaseAdapter('api'),
  };
}

function buildIntegrationAdapters(): Record<string, ConnectorAdapter> {
  const adapters: Record<string, ConnectorAdapter> = {};
  for (const [key, spec] of Object.entries(BACKEND_CONNECTOR_REGISTRY)) {
    adapters[key] = new BaseIntegrationAdapter(spec);
  }
  return adapters;
}

export class UnifiedRegistry {
  private adapters: Record<string, ConnectorAdapter>;

  constructor() {
    this.adapters = {
      ...buildDataStoreAdapters(),
      ...buildIntegrationAdapters(),
    };
  }

  getAdapter(type: string): ConnectorAdapter {
    const adapter = this.adapters[type];
    if (!adapter) {
      throw new ValidationError(`Unsupported connector type: ${type}`);
    }
    return adapter;
  }

  getSpec(type: string): ConnectorSpec | undefined {
    return this.adapters[type]?.spec;
  }

  listTypes(): string[] {
    return Object.keys(this.adapters);
  }

  listByCategory(category: ConnectorCategory): string[] {
    return Object.entries(this.adapters)
      .filter(([, adapter]) => adapter.category === category)
      .map(([key]) => key);
  }
}

/** Singleton instance for convenience */
let _instance: UnifiedRegistry | undefined;
export function getUnifiedRegistry(): UnifiedRegistry {
  if (!_instance) _instance = new UnifiedRegistry();
  return _instance;
}
