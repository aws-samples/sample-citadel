import serverService from './server';

// --- Enums ---

export enum DataStoreType {
  S3 = 'S3',
  DYNAMODB = 'DYNAMODB',
  RDS_POSTGRESQL = 'RDS_POSTGRESQL',
  RDS_MYSQL = 'RDS_MYSQL',
  KNOWLEDGE_BASE = 'KNOWLEDGE_BASE',
  AURORA_POSTGRESQL = 'AURORA_POSTGRESQL',
  AURORA_MYSQL = 'AURORA_MYSQL',
  REDSHIFT = 'REDSHIFT',
  LAKE_FORMATION = 'LAKE_FORMATION',
  OPENSEARCH = 'OPENSEARCH',
  NEPTUNE = 'NEPTUNE',
  TIMESTREAM = 'TIMESTREAM',
  DOCUMENTDB = 'DOCUMENTDB',
  ELASTICACHE_REDIS = 'ELASTICACHE_REDIS',
  KEYSPACES = 'KEYSPACES',
  SAGEMAKER_FEATURE_STORE = 'SAGEMAKER_FEATURE_STORE',
  EXTERNAL_POSTGRESQL = 'EXTERNAL_POSTGRESQL',
  EXTERNAL_MYSQL = 'EXTERNAL_MYSQL',
  EXTERNAL_MONGODB = 'EXTERNAL_MONGODB',
  EXTERNAL_ELASTICSEARCH = 'EXTERNAL_ELASTICSEARCH',
  EXTERNAL_REDIS = 'EXTERNAL_REDIS',
  EXTERNAL_API = 'EXTERNAL_API',
}

export enum DataStoreCategory {
  S3_STORAGE = 'S3_STORAGE',
  NOSQL_DATABASE = 'NOSQL_DATABASE',
  RELATIONAL_DATABASE = 'RELATIONAL_DATABASE',
  KNOWLEDGE_BASE = 'KNOWLEDGE_BASE',
  DATA_WAREHOUSE = 'DATA_WAREHOUSE',
  DATA_LAKE = 'DATA_LAKE',
  SEARCH_ENGINE = 'SEARCH_ENGINE',
  GRAPH_DATABASE = 'GRAPH_DATABASE',
  TIME_SERIES = 'TIME_SERIES',
  DOCUMENT_DATABASE = 'DOCUMENT_DATABASE',
  CACHE = 'CACHE',
  EXTERNAL = 'EXTERNAL',
}

export enum DataStoreStatus {
  CREATED = 'CREATED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  PROVISIONING = 'PROVISIONING',
  PROVISIONED = 'PROVISIONED',
  DISCONNECTED = 'DISCONNECTED',
  ERROR = 'ERROR',
  DELETING = 'DELETING',
}

export enum DataStoreProvisionMode {
  CREATE_NEW = 'CREATE_NEW',
  CONNECT_EXISTING = 'CONNECT_EXISTING',
}

export enum DataStoreUsage {
  KNOWLEDGE = 'KNOWLEDGE',
  OPERATIONAL = 'OPERATIONAL',
  BOTH = 'BOTH',
}

// --- Interfaces ---

export interface DataStore {
  dataStoreId: string;
  name: string;
  description?: string;
  type: DataStoreType;
  category: DataStoreCategory;
  status: DataStoreStatus;
  usage?: DataStoreUsage;
  icon: string;
  provider: string;
  provisionMode: DataStoreProvisionMode;
  orgId: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  config: string; // AWSJSON
  size?: string;
  records?: number;
  lastSync?: string;
  features?: string[];
  errorMessage?: string;
  resourceArn?: string;
  secretArn?: string;
  version: number;
}

export interface DataStoreStats {
  total: number;
  connected: number;
  error: number;
  byCategory?: string; // AWSJSON
  byType?: string; // AWSJSON
}

export interface DataStoreTestResult {
  success: boolean;
  message: string;
  details?: string; // AWSJSON
}

export interface DeleteDataStoreResult {
  success: boolean;
  message?: string;
}

export interface CreateDataStoreInput {
  name: string;
  description?: string;
  type: DataStoreType;
  category: DataStoreCategory;
  provisionMode: DataStoreProvisionMode;
  orgId: string;
  config: string; // AWSJSON
  credentials?: string; // AWSJSON
  clientRequestToken: string;
  usage?: DataStoreUsage;
}

export interface UpdateDataStoreInput {
  dataStoreId: string;
  name?: string;
  description?: string;
  config?: string; // AWSJSON
  version: number;
  usage?: DataStoreUsage;
}

// --- Type Metadata Registry ---

export interface TypeMeta {
  displayName: string;
  icon: string;
  category: DataStoreCategory;
  provider: string;
  defaultFeatures: string[];
  isAws: boolean;
}

export const DATA_STORE_TYPE_META: Record<DataStoreType, TypeMeta> = {
  [DataStoreType.S3]: {
    displayName: 'Amazon S3',
    icon: 'Cloud',
    category: DataStoreCategory.S3_STORAGE,
    provider: 'Amazon S3',
    defaultFeatures: ['Versioning', 'Lifecycle policies', 'Cross-region replication', 'Event notifications'],
    isAws: true,
  },
  [DataStoreType.DYNAMODB]: {
    displayName: 'Amazon DynamoDB',
    icon: 'Database',
    category: DataStoreCategory.NOSQL_DATABASE,
    provider: 'Amazon DynamoDB',
    defaultFeatures: ['Fast retrieval', 'TTL support', 'Point-in-time recovery', 'Global tables'],
    isAws: true,
  },
  [DataStoreType.RDS_POSTGRESQL]: {
    displayName: 'Amazon RDS PostgreSQL',
    icon: 'Database',
    category: DataStoreCategory.RELATIONAL_DATABASE,
    provider: 'Amazon RDS',
    defaultFeatures: ['SQL queries', 'Real-time sync', 'Backup enabled', 'Encryption at rest'],
    isAws: true,
  },
  [DataStoreType.RDS_MYSQL]: {
    displayName: 'Amazon RDS MySQL',
    icon: 'Database',
    category: DataStoreCategory.RELATIONAL_DATABASE,
    provider: 'Amazon RDS',
    defaultFeatures: ['SQL queries', 'Real-time sync', 'Backup enabled', 'Encryption at rest'],
    isAws: true,
  },
  [DataStoreType.KNOWLEDGE_BASE]: {
    displayName: 'Amazon Bedrock Knowledge Base',
    icon: 'BookOpen',
    category: DataStoreCategory.KNOWLEDGE_BASE,
    provider: 'Amazon Bedrock',
    defaultFeatures: ['Vector search', 'Semantic retrieval', 'Auto-indexing', 'RAG support'],
    isAws: true,
  },
  [DataStoreType.AURORA_POSTGRESQL]: {
    displayName: 'Amazon Aurora PostgreSQL',
    icon: 'Database',
    category: DataStoreCategory.RELATIONAL_DATABASE,
    provider: 'Amazon Aurora',
    defaultFeatures: ['PostgreSQL compatible', 'Auto-scaling', 'Multi-AZ', 'Serverless option'],
    isAws: true,
  },
  [DataStoreType.AURORA_MYSQL]: {
    displayName: 'Amazon Aurora MySQL',
    icon: 'Database',
    category: DataStoreCategory.RELATIONAL_DATABASE,
    provider: 'Amazon Aurora',
    defaultFeatures: ['MySQL compatible', 'Auto-scaling', 'Multi-AZ', 'Serverless option'],
    isAws: true,
  },
  [DataStoreType.REDSHIFT]: {
    displayName: 'Amazon Redshift',
    icon: 'BarChart3',
    category: DataStoreCategory.DATA_WAREHOUSE,
    provider: 'Amazon Redshift',
    defaultFeatures: ['Columnar storage', 'Massively parallel', 'Spectrum integration', 'Concurrency scaling'],
    isAws: true,
  },
  [DataStoreType.LAKE_FORMATION]: {
    displayName: 'AWS Lake Formation',
    icon: 'Layers',
    category: DataStoreCategory.DATA_LAKE,
    provider: 'AWS Lake Formation',
    defaultFeatures: ['Petabyte scale', 'Athena integration', 'Glue catalog', 'S3 backed'],
    isAws: true,
  },
  [DataStoreType.OPENSEARCH]: {
    displayName: 'Amazon OpenSearch',
    icon: 'Search',
    category: DataStoreCategory.SEARCH_ENGINE,
    provider: 'Amazon OpenSearch',
    defaultFeatures: ['Full-text search', 'Vector search', 'Dashboards', 'Serverless option'],
    isAws: true,
  },
  [DataStoreType.NEPTUNE]: {
    displayName: 'Amazon Neptune',
    icon: 'Share2',
    category: DataStoreCategory.GRAPH_DATABASE,
    provider: 'Amazon Neptune',
    defaultFeatures: ['Graph queries', 'Gremlin support', 'SPARQL support', 'Fast traversals'],
    isAws: true,
  },
  [DataStoreType.TIMESTREAM]: {
    displayName: 'Amazon Timestream',
    icon: 'Clock',
    category: DataStoreCategory.TIME_SERIES,
    provider: 'Amazon Timestream',
    defaultFeatures: ['Time-series optimized', 'Auto-scaling', 'Built-in analytics', 'Retention policies'],
    isAws: true,
  },
  [DataStoreType.DOCUMENTDB]: {
    displayName: 'Amazon DocumentDB',
    icon: 'FileText',
    category: DataStoreCategory.DOCUMENT_DATABASE,
    provider: 'Amazon DocumentDB',
    defaultFeatures: ['MongoDB compatible', 'Auto-scaling', 'Encryption', 'Backup'],
    isAws: true,
  },
  [DataStoreType.ELASTICACHE_REDIS]: {
    displayName: 'Amazon ElastiCache Redis',
    icon: 'Zap',
    category: DataStoreCategory.CACHE,
    provider: 'Amazon ElastiCache',
    defaultFeatures: ['In-memory caching', 'Sub-millisecond latency', 'Pub/Sub', 'Cluster mode'],
    isAws: true,
  },
  [DataStoreType.KEYSPACES]: {
    displayName: 'Amazon Keyspaces',
    icon: 'Key',
    category: DataStoreCategory.NOSQL_DATABASE,
    provider: 'Amazon Keyspaces',
    defaultFeatures: ['Cassandra compatible', 'Serverless', 'Auto-scaling', 'Encryption'],
    isAws: true,
  },
  [DataStoreType.SAGEMAKER_FEATURE_STORE]: {
    displayName: 'Amazon SageMaker Feature Store',
    icon: 'Brain',
    category: DataStoreCategory.NOSQL_DATABASE,
    provider: 'Amazon SageMaker',
    defaultFeatures: ['Feature storage', 'Online/offline store', 'Feature versioning', 'ML integration'],
    isAws: true,
  },
  [DataStoreType.EXTERNAL_POSTGRESQL]: {
    displayName: 'External PostgreSQL',
    icon: 'Database',
    category: DataStoreCategory.EXTERNAL,
    provider: 'PostgreSQL',
    defaultFeatures: ['SQL queries', 'ACID compliance', 'Extensions', 'Replication'],
    isAws: false,
  },
  [DataStoreType.EXTERNAL_MYSQL]: {
    displayName: 'External MySQL',
    icon: 'Database',
    category: DataStoreCategory.EXTERNAL,
    provider: 'MySQL',
    defaultFeatures: ['SQL queries', 'ACID compliance', 'Replication', 'Partitioning'],
    isAws: false,
  },
  [DataStoreType.EXTERNAL_MONGODB]: {
    displayName: 'External MongoDB',
    icon: 'Database',
    category: DataStoreCategory.EXTERNAL,
    provider: 'MongoDB',
    defaultFeatures: ['Document store', 'Aggregation pipeline', 'Sharding', 'Replication'],
    isAws: false,
  },
  [DataStoreType.EXTERNAL_ELASTICSEARCH]: {
    displayName: 'External Elasticsearch',
    icon: 'Search',
    category: DataStoreCategory.EXTERNAL,
    provider: 'Elasticsearch',
    defaultFeatures: ['Full-text search', 'Analytics', 'Aggregations', 'Distributed'],
    isAws: false,
  },
  [DataStoreType.EXTERNAL_REDIS]: {
    displayName: 'External Redis',
    icon: 'Zap',
    category: DataStoreCategory.EXTERNAL,
    provider: 'Redis',
    defaultFeatures: ['In-memory caching', 'Pub/Sub', 'Data structures', 'Clustering'],
    isAws: false,
  },
  [DataStoreType.EXTERNAL_API]: {
    displayName: 'External API',
    icon: 'Globe',
    category: DataStoreCategory.EXTERNAL,
    provider: 'Custom API',
    defaultFeatures: ['REST/GraphQL', 'Custom endpoints', 'Authentication', 'Rate limiting'],
    isAws: false,
  },
};

// --- GraphQL Fragments & Queries ---

const DATA_STORE_FIELDS = `
  dataStoreId
  name
  description
  type
  category
  status
  usage
  icon
  provider
  provisionMode
  orgId
  createdBy
  createdAt
  updatedAt
  config
  size
  records
  lastSync
  features
  errorMessage
  resourceArn
  secretArn
  version
`;

const LIST_DATA_STORES = `
  query ListDataStores($orgId: String!, $category: DataStoreCategory) {
    listDataStores(orgId: $orgId, category: $category) {
      ${DATA_STORE_FIELDS}
    }
  }
`;

const GET_DATA_STORE = `
  query GetDataStore($dataStoreId: ID!) {
    getDataStore(dataStoreId: $dataStoreId) {
      ${DATA_STORE_FIELDS}
    }
  }
`;

const GET_DATA_STORE_STATS = `
  query GetDataStoreStats($orgId: String!) {
    getDataStoreStats(orgId: $orgId) {
      total
      connected
      error
      byCategory
      byType
    }
  }
`;

const CREATE_DATA_STORE = `
  mutation CreateDataStore($input: CreateDataStoreInput!) {
    createDataStore(input: $input) {
      ${DATA_STORE_FIELDS}
    }
  }
`;

const UPDATE_DATA_STORE = `
  mutation UpdateDataStore($input: UpdateDataStoreInput!) {
    updateDataStore(input: $input) {
      ${DATA_STORE_FIELDS}
    }
  }
`;

const DELETE_DATA_STORE = `
  mutation DeleteDataStore($dataStoreId: ID!) {
    deleteDataStore(dataStoreId: $dataStoreId) {
      success
      message
    }
  }
`;

const CONNECT_DATA_STORE = `
  mutation ConnectDataStore($dataStoreId: ID!) {
    connectDataStore(dataStoreId: $dataStoreId) {
      ${DATA_STORE_FIELDS}
    }
  }
`;

const DISCONNECT_DATA_STORE = `
  mutation DisconnectDataStore($dataStoreId: ID!) {
    disconnectDataStore(dataStoreId: $dataStoreId) {
      ${DATA_STORE_FIELDS}
    }
  }
`;

const TEST_DATA_STORE_CONNECTION = `
  mutation TestDataStoreConnection($dataStoreId: ID!) {
    testDataStoreConnection(dataStoreId: $dataStoreId) {
      success
      message
      details
    }
  }
`;

// --- Service ---

export const datastoreService = {
  async listDataStores(orgId: string, category?: DataStoreCategory): Promise<DataStore[]> {
    const response = await serverService.query<{ listDataStores: DataStore[] }>(
      LIST_DATA_STORES,
      { orgId, category },
    );
    return response.listDataStores || [];
  },

  async getDataStore(dataStoreId: string): Promise<DataStore> {
    const response = await serverService.query<{ getDataStore: DataStore }>(
      GET_DATA_STORE,
      { dataStoreId },
    );
    return response.getDataStore;
  },

  async getDataStoreStats(orgId: string): Promise<DataStoreStats> {
    const response = await serverService.query<{ getDataStoreStats: DataStoreStats }>(
      GET_DATA_STORE_STATS,
      { orgId },
    );
    return response.getDataStoreStats;
  },

  async createDataStore(input: CreateDataStoreInput): Promise<DataStore> {
    const response = await serverService.mutate<{ createDataStore: DataStore }>(
      CREATE_DATA_STORE,
      { input },
    );
    return response.createDataStore;
  },

  async updateDataStore(input: UpdateDataStoreInput): Promise<DataStore> {
    const response = await serverService.mutate<{ updateDataStore: DataStore }>(
      UPDATE_DATA_STORE,
      { input },
    );
    return response.updateDataStore;
  },

  async deleteDataStore(dataStoreId: string): Promise<DeleteDataStoreResult> {
    const response = await serverService.mutate<{ deleteDataStore: DeleteDataStoreResult }>(
      DELETE_DATA_STORE,
      { dataStoreId },
    );
    return response.deleteDataStore;
  },

  async connectDataStore(dataStoreId: string): Promise<DataStore> {
    const response = await serverService.mutate<{ connectDataStore: DataStore }>(
      CONNECT_DATA_STORE,
      { dataStoreId },
    );
    return response.connectDataStore;
  },

  async disconnectDataStore(dataStoreId: string): Promise<DataStore> {
    const response = await serverService.mutate<{ disconnectDataStore: DataStore }>(
      DISCONNECT_DATA_STORE,
      { dataStoreId },
    );
    return response.disconnectDataStore;
  },

  async testConnection(dataStoreId: string): Promise<DataStoreTestResult> {
    const response = await serverService.mutate<{ testDataStoreConnection: DataStoreTestResult }>(
      TEST_DATA_STORE_CONNECTION,
      { dataStoreId },
    );
    return response.testDataStoreConnection;
  },
};
