import { useState, useMemo } from 'react';
import { ArrowLeft, ArrowRight, Loader2, Check, LucideIcon } from 'lucide-react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import { Badge } from './ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './ui/dialog';
import {
  DataStoreType,
  DataStoreCategory,
  DataStoreProvisionMode,
  DATA_STORE_TYPE_META,
  CreateDataStoreInput,
  datastoreService,
} from '../services/datastoreService';
import {
  Database,
  Cloud,
  BookOpen,
  Search,
  Share2,
  Clock,
  FileText,
  Zap,
  Key,
  Shield,
  Brain,
  Globe,
  Layers,
  BarChart3,
} from 'lucide-react';

// Icon mapping for type meta icons
const iconMap: Record<string, LucideIcon> = {
  Cloud,
  Database,
  BookOpen,
  Search,
  Share2,
  Clock,
  FileText,
  Zap,
  Key,
  Shield,
  Brain,
  Globe,
  Layers,
  BarChart3,
};

const getIcon = (name: string): LucideIcon => iconMap[name] || Database;

// Category display labels
const CATEGORY_LABELS: Record<DataStoreCategory, string> = {
  [DataStoreCategory.S3_STORAGE]: 'S3 Storage',
  [DataStoreCategory.NOSQL_DATABASE]: 'NoSQL Database',
  [DataStoreCategory.RELATIONAL_DATABASE]: 'Relational Database',
  [DataStoreCategory.KNOWLEDGE_BASE]: 'Knowledge Base',
  [DataStoreCategory.DATA_WAREHOUSE]: 'Data Warehouse',
  [DataStoreCategory.DATA_LAKE]: 'Data Lake',
  [DataStoreCategory.SEARCH_ENGINE]: 'Search Engine',
  [DataStoreCategory.GRAPH_DATABASE]: 'Graph Database',
  [DataStoreCategory.TIME_SERIES]: 'Time Series',
  [DataStoreCategory.DOCUMENT_DATABASE]: 'Document Database',
  [DataStoreCategory.CACHE]: 'Cache',
  [DataStoreCategory.EXTERNAL]: 'External',
};

interface CreateDataStoreWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  onCreated: () => void;
}

export function CreateDataStoreWizard({
  open,
  onOpenChange,
  orgId,
  onCreated,
}: CreateDataStoreWizardProps) {
  const [step, setStep] = useState(1);
  const [selectedType, setSelectedType] = useState<DataStoreType | null>(null);
  const [provisionMode, setProvisionMode] = useState<DataStoreProvisionMode | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Group types by category
  const typesByCategory = useMemo(() => {
    const groups: Record<string, { type: DataStoreType; meta: (typeof DATA_STORE_TYPE_META)[DataStoreType] }[]> = {};
    for (const [type, meta] of Object.entries(DATA_STORE_TYPE_META)) {
      const cat = meta.category;
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push({ type: type as DataStoreType, meta });
    }
    return groups;
  }, []);

  const selectedMeta = selectedType ? DATA_STORE_TYPE_META[selectedType] : null;

  const reset = () => {
    setStep(1);
    setSelectedType(null);
    setProvisionMode(null);
    setName('');
    setDescription('');
    setConfig({});
    setError(null);
    setIsSubmitting(false);
  };

  const handleClose = (open: boolean) => {
    if (!open) reset();
    onOpenChange(open);
  };

  const handleTypeSelect = (type: DataStoreType) => {
    setSelectedType(type);
    const meta = DATA_STORE_TYPE_META[type];
    // External types auto-select CONNECT_EXISTING
    if (!meta.isAws) {
      setProvisionMode(DataStoreProvisionMode.CONNECT_EXISTING);
    } else {
      setProvisionMode(null);
    }
  };

  const handleNext = () => {
    if (step === 1 && selectedType) {
      const meta = DATA_STORE_TYPE_META[selectedType];
      if (!meta.isAws) {
        // Skip step 2 for external types, auto-set CONNECT_EXISTING
        setProvisionMode(DataStoreProvisionMode.CONNECT_EXISTING);
        setStep(3);
      } else {
        setStep(2);
      }
    } else if (step === 2 && provisionMode) {
      setStep(3);
    }
  };

  const handleBack = () => {
    if (step === 3) {
      const meta = selectedType ? DATA_STORE_TYPE_META[selectedType] : null;
      if (meta && !meta.isAws) {
        setStep(1); // Skip step 2 going back for external
      } else {
        setStep(2);
      }
    } else if (step === 2) {
      setStep(1);
    }
  };

  const POSTGRES_RESERVED_USERNAMES = ['admin', 'postgres', 'rdsadmin'];

  const isPostgresType =
    selectedType === DataStoreType.RDS_POSTGRESQL ||
    selectedType === DataStoreType.AURORA_POSTGRESQL;

  const hasReservedUsername =
    isPostgresType &&
    provisionMode === DataStoreProvisionMode.CREATE_NEW &&
    POSTGRES_RESERVED_USERNAMES.includes((config.masterUsername || '').toLowerCase());

  const handleSubmit = async () => {
    if (!selectedType || !provisionMode || !name.trim()) {
      setError('Please fill in all required fields.');
      return;
    }

    // Validate required config fields are filled in
    const fields = getConfigFields();
    const missingFields = fields
      .filter((f) => !f.key.toLowerCase().includes('optional') && !f.label.toLowerCase().includes('optional'))
      .filter((f) => f.type !== 'select') // select fields always have a default value
      .filter((f) => !config[f.key]?.trim());
    if (missingFields.length > 0) {
      setError(`Please fill in: ${missingFields.map((f) => f.label).join(', ')}`);
      return;
    }

    if (hasReservedUsername) {
      setError(`"${config.masterUsername}" is a reserved PostgreSQL username. Use a different name (e.g. "dbadmin").`);
      return;
    }

    // Validate master password meets AWS requirements
    const password = config.masterPassword;
    if (password && provisionMode === DataStoreProvisionMode.CREATE_NEW) {
      const needsValidation = [
        DataStoreType.REDSHIFT, DataStoreType.RDS_POSTGRESQL, DataStoreType.RDS_MYSQL,
        DataStoreType.AURORA_POSTGRESQL, DataStoreType.AURORA_MYSQL, DataStoreType.DOCUMENTDB,
      ].includes(selectedType);
      if (needsValidation) {
        if (!/[A-Z]/.test(password)) {
          setError('Master Password must contain at least one uppercase letter.');
          return;
        }
        if (!/[a-z]/.test(password)) {
          setError('Master Password must contain at least one lowercase letter.');
          return;
        }
        if (!/[0-9]/.test(password)) {
          setError('Master Password must contain at least one number.');
          return;
        }
        if (password.length < 8) {
          setError('Master Password must be at least 8 characters.');
          return;
        }
      }
    }

    try {
      setIsSubmitting(true);
      setError(null);

      // Fill in default values for select fields that haven't been touched
      const finalConfig = { ...config };
      for (const field of fields) {
        if (field.type === 'select' && field.options && !finalConfig[field.key]) {
          finalConfig[field.key] = field.options[0]?.value;
        }
      }

      const meta = DATA_STORE_TYPE_META[selectedType];
      const input: CreateDataStoreInput = {
        name: name.trim(),
        description: description.trim() || undefined,
        type: selectedType,
        category: meta.category,
        provisionMode,
        orgId,
        config: JSON.stringify(finalConfig),
        clientRequestToken: crypto.randomUUID(),
      };

      await datastoreService.createDataStore(input);
      onCreated();
      handleClose(false);
    } catch (err: any) {
      setError(err.message || 'Failed to create data store');
    } finally {
      setIsSubmitting(false);
    }
  };

  const updateConfig = (key: string, value: string) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  // Config fields based on type and provision mode
  const getConfigFields = (): { key: string; label: string; placeholder: string; type?: string; options?: { value: string; label: string }[] }[] => {
    if (!selectedType || !provisionMode) return [];

    const isCreateNew = provisionMode === DataStoreProvisionMode.CREATE_NEW;

    switch (selectedType) {
      case DataStoreType.S3:
        return isCreateNew
          ? [{ key: 'bucketName', label: 'Bucket Name', placeholder: 'my-data-bucket' }]
          : [{ key: 'bucketName', label: 'Existing Bucket Name', placeholder: 'my-existing-bucket' }];

      case DataStoreType.DYNAMODB:
        return isCreateNew
          ? [
              { key: 'tableName', label: 'Table Name', placeholder: 'my-table' },
              { key: 'partitionKey', label: 'Partition Key', placeholder: 'pk' },
              { key: 'sortKey', label: 'Sort Key (optional)', placeholder: 'sk' },
            ]
          : [{ key: 'tableName', label: 'Existing Table Name', placeholder: 'my-existing-table' }];

      case DataStoreType.RDS_POSTGRESQL:
        return isCreateNew
          ? [
              { key: 'masterUsername', label: 'Master Username', placeholder: 'dbadmin' },
              { key: 'masterPassword', label: 'Master Password', placeholder: '••••••••', type: 'password' },
            ]
          : [{ key: 'dbInstanceIdentifier', label: 'DB Instance Identifier', placeholder: 'my-rds-instance' }];

      case DataStoreType.RDS_MYSQL:
        return isCreateNew
          ? [
              { key: 'masterUsername', label: 'Master Username', placeholder: 'admin' },
              { key: 'masterPassword', label: 'Master Password', placeholder: '••••••••', type: 'password' },
            ]
          : [{ key: 'dbInstanceIdentifier', label: 'DB Instance Identifier', placeholder: 'my-rds-instance' }];

      case DataStoreType.EXTERNAL_POSTGRESQL:
      case DataStoreType.EXTERNAL_MYSQL:
      case DataStoreType.EXTERNAL_REDIS:
      case DataStoreType.EXTERNAL_ELASTICSEARCH:
        return [
          { key: 'host', label: 'Host', placeholder: 'db.example.com' },
          { key: 'port', label: 'Port', placeholder: '5432' },
          { key: 'username', label: 'Username', placeholder: 'user' },
          { key: 'password', label: 'Password', placeholder: '••••••••', type: 'password' },
        ];

      case DataStoreType.EXTERNAL_MONGODB:
        return [{ key: 'connectionString', label: 'Connection String', placeholder: 'mongodb://host:27017/db' }];

      case DataStoreType.EXTERNAL_API:
        return [
          { key: 'baseUrl', label: 'Base URL', placeholder: 'https://api.example.com' },
          { key: 'apiKey', label: 'API Key (optional)', placeholder: 'your-api-key', type: 'password' },
        ];

      case DataStoreType.KNOWLEDGE_BASE:
        return isCreateNew
          ? [{ key: 'name', label: 'Knowledge Base Name', placeholder: 'my-knowledge-base' }]
          : [{ key: 'knowledgeBaseId', label: 'Knowledge Base ID', placeholder: 'XXXXXXXXXX' }];

      case DataStoreType.OPENSEARCH:
        return isCreateNew
          ? [{ key: 'collectionName', label: 'Collection Name', placeholder: 'my-collection' }]
          : [
              { key: 'collectionName', label: 'Collection Name', placeholder: 'my-collection' },
              { key: 'collectionId', label: 'Collection ID', placeholder: 'col-xxxxx' },
            ];

      case DataStoreType.NEPTUNE:
        return isCreateNew
          ? [{ key: 'dbClusterIdentifier', label: 'Cluster Identifier', placeholder: 'my-neptune-cluster' }]
          : [{ key: 'dbClusterIdentifier', label: 'Cluster Identifier', placeholder: 'my-neptune-cluster' }];

      case DataStoreType.REDSHIFT:
        return isCreateNew
          ? [
              { key: 'clusterIdentifier', label: 'Cluster Identifier', placeholder: 'my-redshift-cluster' },
              { key: 'nodeType', label: 'Node Type', placeholder: 'ra3.xlplus', type: 'select', options: [
                { value: 'ra3.xlplus', label: 'ra3.xlplus (4 vCPU, 32 GiB)' },
                { value: 'ra3.4xlarge', label: 'ra3.4xlarge (12 vCPU, 96 GiB)' },
                { value: 'ra3.16xlarge', label: 'ra3.16xlarge (48 vCPU, 384 GiB)' },
                { value: 'ra3.large', label: 'ra3.large (2 vCPU, 16 GiB)' },
              ]},
              { key: 'masterUsername', label: 'Master Username', placeholder: 'admin' },
              { key: 'masterPassword', label: 'Master Password (A-Z, a-z, 0-9 required)', placeholder: 'MyPass123', type: 'password' },
            ]
          : [{ key: 'clusterIdentifier', label: 'Cluster Identifier', placeholder: 'my-redshift-cluster' }];

      case DataStoreType.TIMESTREAM:
        return isCreateNew
          ? [{ key: 'databaseName', label: 'Database Name', placeholder: 'my-timestream-db' }]
          : [{ key: 'databaseName', label: 'Database Name', placeholder: 'my-timestream-db' }];

      case DataStoreType.ELASTICACHE_REDIS:
        return isCreateNew
          ? [{ key: 'cacheClusterId', label: 'Cache Cluster ID', placeholder: 'my-redis-cluster' }]
          : [{ key: 'cacheClusterId', label: 'Cache Cluster ID', placeholder: 'my-redis-cluster' }];

      case DataStoreType.KEYSPACES:
        return isCreateNew
          ? [{ key: 'keyspaceName', label: 'Keyspace Name', placeholder: 'my-keyspace' }]
          : [{ key: 'keyspaceName', label: 'Keyspace Name', placeholder: 'my-keyspace' }];

      case DataStoreType.DOCUMENTDB:
        return isCreateNew
          ? [
              { key: 'dbClusterIdentifier', label: 'Cluster Identifier', placeholder: 'my-docdb-cluster' },
              { key: 'masterUsername', label: 'Master Username', placeholder: 'admin' },
              { key: 'masterPassword', label: 'Master Password', placeholder: '••••••••', type: 'password' },
            ]
          : [{ key: 'dbClusterIdentifier', label: 'Cluster Identifier', placeholder: 'my-docdb-cluster' }];

      case DataStoreType.AURORA_POSTGRESQL:
        return isCreateNew
          ? [
              { key: 'dbClusterIdentifier', label: 'Cluster Identifier', placeholder: 'my-aurora-cluster' },
              { key: 'masterUsername', label: 'Master Username', placeholder: 'dbadmin' },
              { key: 'masterPassword', label: 'Master Password', placeholder: '••••••••', type: 'password' },
            ]
          : [{ key: 'dbClusterIdentifier', label: 'Cluster Identifier', placeholder: 'my-aurora-cluster' }];

      case DataStoreType.AURORA_MYSQL:
        return isCreateNew
          ? [
              { key: 'dbClusterIdentifier', label: 'Cluster Identifier', placeholder: 'my-aurora-cluster' },
              { key: 'masterUsername', label: 'Master Username', placeholder: 'admin' },
              { key: 'masterPassword', label: 'Master Password', placeholder: '••••••••', type: 'password' },
            ]
          : [{ key: 'dbClusterIdentifier', label: 'Cluster Identifier', placeholder: 'my-aurora-cluster' }];

      case DataStoreType.LAKE_FORMATION:
        return isCreateNew
          ? [{ key: 'resourceArn', label: 'S3 Resource ARN', placeholder: 'arn:aws:s3:::my-data-lake-bucket' }]
          : [{ key: 'resourceArn', label: 'Resource ARN', placeholder: 'arn:aws:s3:::my-data-lake-bucket' }];

      default:
        // Generic AWS types
        return isCreateNew
          ? [{ key: 'resourceName', label: 'Resource Name', placeholder: 'my-resource' }]
          : [{ key: 'resourceArn', label: 'Resource ARN', placeholder: 'arn:aws:...' }];
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl bg-card border-border text-foreground max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-foreground">
            {step === 1 && 'Select Data Store Type'}
            {step === 2 && 'Choose Provision Mode'}
            {step === 3 && 'Configure Data Store'}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {step === 1 && 'Choose the type of data store you want to add'}
            {step === 2 && 'How would you like to set up this data store?'}
            {step === 3 && 'Enter the configuration details'}
          </DialogDescription>
        </DialogHeader>

        {/* Step indicators */}
        <div className="flex items-center gap-2 mb-4">
          {[1, 2, 3].map((s) => (
            <div key={s} className="flex items-center gap-2">
              <div
                className={`size-7 rounded-full flex items-center justify-center text-xs font-medium ${
                  s < step
                    ? 'bg-chart-2/20 text-chart-2 border border-chart-2/50'
                    : s === step
                    ? 'bg-primary/20 text-primary border border-primary/50'
                    : 'bg-accent text-muted-foreground border border-border'
                }`}
              >
                {s < step ? <Check className="w-3.5 h-3.5" /> : s}
              </div>
              {s < 3 && (
                <div className={`w-12 h-px ${s < step ? 'bg-chart-2/50' : 'bg-accent'}`} />
              )}
            </div>
          ))}
        </div>

        {/* Step 1: Type Selection */}
        {step === 1 && (
          <div className="flex flex-col gap-4 max-h-[50vh] overflow-y-auto pr-1">
            {Object.entries(typesByCategory).map(([category, types]) => (
              <div key={category}>
                <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                  {CATEGORY_LABELS[category as DataStoreCategory] || category}
                </h3>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {types.map(({ type, meta }) => {
                    const Icon = getIcon(meta.icon);
                    const isSelected = selectedType === type;
                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() => handleTypeSelect(type)}
                        className={`flex items-center gap-2.5 p-3 rounded-lg border transition-all text-left ${
                          isSelected
                            ? 'bg-primary/10 border-primary'
                            : 'bg-accent border-border hover:border-input'
                        }`}
                      >
                        <div
                          className={`size-8 rounded-md flex items-center justify-center shrink-0 ${
                            isSelected ? 'bg-primary/20' : 'bg-card'
                          }`}
                        >
                          <Icon className={`size-4 ${isSelected ? 'text-primary' : 'text-muted-foreground'}`} />
                        </div>
                        <div className="min-w-0">
                          <p className={`text-sm font-medium truncate ${isSelected ? 'text-foreground' : 'text-muted-foreground'}`}>
                            {meta.displayName}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">{meta.provider}</p>
                        </div>
                        {isSelected && <Check className="size-4 text-primary shrink-0 ml-auto" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Step 2: Provision Mode */}
        {step === 2 && selectedMeta && (
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => setProvisionMode(DataStoreProvisionMode.CREATE_NEW)}
              className={`w-full flex items-start gap-4 p-4 rounded-lg border transition-all text-left ${
                provisionMode === DataStoreProvisionMode.CREATE_NEW
                  ? 'bg-primary/10 border-primary'
                  : 'bg-accent border-border hover:border-input'
              }`}
            >
              <div className="size-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <Cloud className="size-5 text-primary" />
              </div>
              <div>
                <p className="text-foreground font-medium">Create New</p>
                <p className="text-muted-foreground text-sm mt-0.5">
                  Provision a new {selectedMeta.displayName} resource in your AWS account
                </p>
              </div>
              {provisionMode === DataStoreProvisionMode.CREATE_NEW && (
                <Check className="size-5 text-primary shrink-0 ml-auto mt-2" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setProvisionMode(DataStoreProvisionMode.CONNECT_EXISTING)}
              className={`w-full flex items-start gap-4 p-4 rounded-lg border transition-all text-left ${
                provisionMode === DataStoreProvisionMode.CONNECT_EXISTING
                  ? 'bg-primary/10 border-primary'
                  : 'bg-accent border-border hover:border-input'
              }`}
            >
              <div className="size-10 rounded-lg bg-chart-2/10 flex items-center justify-center shrink-0">
                <Database className="size-5 text-chart-2" />
              </div>
              <div>
                <p className="text-foreground font-medium">Connect Existing</p>
                <p className="text-muted-foreground text-sm mt-0.5">
                  Connect to an existing {selectedMeta.displayName} resource
                </p>
              </div>
              {provisionMode === DataStoreProvisionMode.CONNECT_EXISTING && (
                <Check className="size-5 text-primary shrink-0 ml-auto mt-2" />
              )}
            </button>
          </div>
        )}

        {/* Step 3: Configuration */}
        {step === 3 && selectedMeta && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 p-3 rounded-lg bg-accent border border-border">
              {(() => {
                const Icon = getIcon(selectedMeta.icon);
                return <Icon className="size-5 text-primary" />;
              })()}
              <span className="text-sm text-foreground font-medium">{selectedMeta.displayName}</span>
              <Badge variant="secondary" className="text-xs bg-card text-muted-foreground border-border">
                {provisionMode === DataStoreProvisionMode.CREATE_NEW ? 'Create New' : 'Connect Existing'}
              </Badge>
            </div>

            <div className="flex flex-col gap-3">
              <div>
                <Label htmlFor="ds-name" className="text-foreground text-sm">
                  Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="ds-name"
                  placeholder="My Data Store"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1 bg-accent border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <div>
                <Label htmlFor="ds-desc" className="text-foreground text-sm">
                  Description
                </Label>
                <Textarea
                  id="ds-desc"
                  placeholder="Optional description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="mt-1 bg-accent border-border text-foreground placeholder:text-muted-foreground min-h-[60px]"
                />
              </div>

              {getConfigFields().map((field) => (
                <div key={field.key}>
                  <Label htmlFor={`cfg-${field.key}`} className="text-foreground text-sm">
                    {field.label}
                    {!field.label.toLowerCase().includes('optional') && (
                      <span className="text-destructive"> *</span>
                    )}
                  </Label>
                  {field.type === 'select' && field.options ? (
                    <select
                      id={`cfg-${field.key}`}
                      value={config[field.key] || field.options[0]?.value || ''}
                      onChange={(e) => updateConfig(field.key, e.target.value)}
                      className="mt-1 w-full h-9 rounded-md px-3 bg-accent border border-border text-foreground text-sm"
                    >
                      {field.options.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      id={`cfg-${field.key}`}
                      type={field.type || 'text'}
                      placeholder={field.placeholder}
                      value={config[field.key] || ''}
                      onChange={(e) => updateConfig(field.key, e.target.value)}
                      className={`mt-1 bg-accent text-foreground placeholder:text-muted-foreground ${
                        field.key === 'masterUsername' && hasReservedUsername
                          ? 'border-destructive'
                          : 'border-border'
                      }`}
                    />
                  )}
                  {field.key === 'masterUsername' && hasReservedUsername && (
                    <p className="text-destructive text-xs mt-1">
                      &quot;{config.masterUsername}&quot; is reserved in PostgreSQL. Try &quot;dbadmin&quot; instead.
                    </p>
                  )}
                </div>
              ))}
            </div>

            {/* Features preview */}
            <div className="flex flex-wrap gap-1.5">
              {selectedMeta.defaultFeatures.slice(0, 4).map((f) => (
                <Badge key={f} variant="outline" className="text-xs text-muted-foreground border-border bg-transparent">
                  {f}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="bg-destructive/10 border border-destructive/50 rounded-lg p-3">
            <p className="text-destructive text-sm">{error}</p>
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-between pt-2">
          <Button
            variant="outline"
            className="border-border text-muted-foreground hover:bg-accent"
            onClick={step === 1 ? () => handleClose(false) : handleBack}
            disabled={isSubmitting}
          >
            {step === 1 ? (
              'Cancel'
            ) : (
              <>
                <ArrowLeft className="size-4 mr-1" /> Back
              </>
            )}
          </Button>

          {step < 3 ? (
            <Button
              className="bg-primary text-foreground hover:bg-primary/90"
              onClick={handleNext}
              disabled={
                (step === 1 && !selectedType) || (step === 2 && !provisionMode)
              }
            >
              Next <ArrowRight className="size-4 ml-1" />
            </Button>
          ) : (
            <Button
              className="bg-primary text-foreground hover:bg-primary/90"
              onClick={handleSubmit}
              disabled={isSubmitting || !name.trim() || hasReservedUsername}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create Data Store'
              )}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
