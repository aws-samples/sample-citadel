/**
 * ToolTestingSandbox Component
 *
 * UI panel for testing tools with sample inputs in an isolated Lambda environment.
 * Renders input fields from the tool's JSON schema, invokes the testTool mutation,
 * and displays results with execution time and history.
 *
 * Requirement references: 7.1, 7.2, 7.3, 7.6, 7.7, 7.8, 7.9, 7.10, 11.5
 */

import { useState, useCallback, useEffect } from 'react';
import { Play, CheckCircle, XCircle, Clock, History } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import serverService from '../services/server';
import { ToolConfig, DataStoreBinding } from '../services/toolConfigService';
import { datastoreService, DataStore } from '../services/datastoreService';

// --- Types ---

export interface ToolTestResult {
  success: boolean;
  output?: any;
  error?: string;
  executionTimeMs: number;
}

export interface ToolTestHistoryEntry extends ToolTestResult {
  timestamp: string;
  inputs: any;
}

// --- Pure helper: history management (Req 7.9) ---

export function addToHistory<T>(
  history: T[],
  newEntry: T,
  maxSize: number
): T[] {
  const updated = [...history, newEntry];
  if (updated.length > maxSize) {
    return updated.slice(updated.length - maxSize);
  }
  return updated;
}

// --- GraphQL ---

const testToolMutation = `
  mutation TestTool($toolId: String!, $inputs: AWSJSON!, $orgId: String!) {
    testTool(toolId: $toolId, inputs: $inputs, orgId: $orgId) {
      success
      output
      error
      executionTimeMs
    }
  }
`;

// --- Component ---

interface ToolTestingSandboxProps {
  tool: ToolConfig;
  orgId: string;
  onClose?: () => void;
}

const MAX_HISTORY = 5;

/**
 * Extract the primary resource identifier from a data store's config JSON.
 * Returns the bucket name, table name, endpoint, etc. depending on type.
 */
function extractResourceName(ds: DataStore): string | undefined {
  try {
    const cfg = typeof ds.config === 'string' ? JSON.parse(ds.config) : ds.config;
    return cfg?.bucketName || cfg?.tableName || cfg?.endpoint || cfg?.host || cfg?.clusterEndpoint || ds.name;
  } catch {
    return ds.name;
  }
}

/**
 * Match a schema field name to a data store binding based on naming conventions.
 * e.g. "input_bucket" matches an INPUT S3 binding, "output_bucket" matches OUTPUT S3 binding.
 */
function matchFieldToBinding(
  fieldName: string,
  bindings: DataStoreBinding[],
): DataStoreBinding | undefined {
  const lower = fieldName.toLowerCase();
  const isInput = lower.startsWith('input');
  const isOutput = lower.startsWith('output');

  for (const binding of bindings) {
    const typeKey = binding.dataStoreType?.toLowerCase() || '';
    const isBucketField = lower.includes('bucket');
    const isTableField = lower.includes('table');
    const isS3 = typeKey.includes('s3');
    const isDynamo = typeKey.includes('dynamo');

    const typeMatches =
      (isBucketField && isS3) ||
      (isTableField && isDynamo) ||
      (!isBucketField && !isTableField); // generic match

    if (!typeMatches) continue;

    const dir = binding.direction?.toUpperCase();
    if (isInput && (dir === 'INPUT' || dir === 'BIDIRECTIONAL')) return binding;
    if (isOutput && (dir === 'OUTPUT' || dir === 'BIDIRECTIONAL')) return binding;
    if (!isInput && !isOutput) return binding; // no direction prefix — take first match
  }
  return undefined;
}

export function ToolTestingSandbox({ tool, orgId, onClose }: ToolTestingSandboxProps) {
  const config = typeof tool.config === 'string' ? (() => { try { return tool.config.trim() ? JSON.parse(tool.config) : {}; } catch { return {}; } })() : tool.config;
  const schema = config?.schema?.properties;
  const hasSchema = schema && Object.keys(schema).length > 0;

  // Input state: keyed by field name for schema mode, or raw JSON string
  const [schemaInputs, setSchemaInputs] = useState<Record<string, string>>(() => {
    if (hasSchema) {
      const initial: Record<string, string> = {};
      for (const key of Object.keys(schema)) {
        // Use JSON schema default value if available
        const def = schema[key]?.default;
        initial[key] = def != null ? String(def) : '';
      }
      return initial;
    }
    return {};
  });
  const [rawJsonInput, setRawJsonInput] = useState('{}');

  const [isRunning, setIsRunning] = useState(false);
  const [currentResult, setCurrentResult] = useState<ToolTestResult | null>(null);
  const [history, setHistory] = useState<ToolTestHistoryEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Pre-populate data-store-related schema fields from bindings or connected data stores
  useEffect(() => {
    if (!hasSchema) return;

    const fieldNames = Object.keys(schema);
    const dsFields = fieldNames.filter(f => {
      const l = f.toLowerCase();
      return l.includes('bucket') || l.includes('table') || l.includes('endpoint') || l.includes('host');
    });
    if (dsFields.length === 0) return;

    (async () => {
      const updates: Record<string, string> = {};

      // Strategy 1: Use dataStoreBindings if available
      if (tool.dataStoreBindings?.length) {
        const dsMap = new Map<string, DataStore>();
        try {
          const results = await Promise.all(
            tool.dataStoreBindings.map(b => datastoreService.getDataStore(b.dataStoreId).catch(() => null))
          );
          for (const ds of results) {
            if (ds) dsMap.set(ds.dataStoreId, ds);
          }
        } catch { /* ignore */ }

        for (const fieldName of dsFields) {
          const binding = matchFieldToBinding(fieldName, tool.dataStoreBindings);
          if (!binding) continue;
          const ds = dsMap.get(binding.dataStoreId);
          if (!ds) continue;
          const resourceName = extractResourceName(ds);
          if (resourceName) updates[fieldName] = resourceName;
        }
      }

      // Strategy 2: Fallback — fetch all connected data stores and match by type
      const unresolved = dsFields.filter(f => !updates[f]);
      if (unresolved.length > 0) {
        try {
          const allStores = await datastoreService.listDataStores(orgId);
          const connected = allStores.filter(ds => ds.status === 'CONNECTED');

          for (const fieldName of unresolved) {
            const lower = fieldName.toLowerCase();
            const isBucket = lower.includes('bucket');
            const isTable = lower.includes('table');

            const candidates = connected.filter(ds => {
              const t = ds.type?.toLowerCase() || '';
              if (isBucket) return t.includes('s3');
              if (isTable) return t.includes('dynamo');
              return false;
            });
            if (candidates.length === 0) continue;

            // Pick by direction hint in field name
            const isInput = lower.startsWith('input');
            const isOutput = lower.startsWith('output');
            let picked = candidates[0]; // default: first match
            if (isInput) {
              picked = candidates.find(ds => ds.usage === 'KNOWLEDGE' || ds.usage === 'BOTH') || picked;
            } else if (isOutput) {
              picked = candidates.find(ds => ds.usage === 'OPERATIONAL' || ds.usage === 'BOTH') || picked;
            }

            const resourceName = extractResourceName(picked);
            if (resourceName) updates[fieldName] = resourceName;
          }
        } catch { /* ignore */ }
      }

      if (Object.keys(updates).length > 0) {
        setSchemaInputs(prev => {
          const next = { ...prev };
          for (const [k, v] of Object.entries(updates)) {
            if (!next[k]) next[k] = v;
          }
          return next;
        });
      }
    })();
  }, [hasSchema, tool.dataStoreBindings, schema, orgId]);

  const handleSchemaInputChange = useCallback((field: string, value: string) => {
    setSchemaInputs(prev => ({ ...prev, [field]: value }));
  }, []);

  const buildInputs = useCallback((): any => {
    if (hasSchema) {
      const inputs: Record<string, any> = {};
      for (const [key, value] of Object.entries(schemaInputs)) {
        // Try to parse as JSON for non-string types
        const fieldType = schema[key]?.type;
        if (fieldType === 'number' || fieldType === 'integer') {
          inputs[key] = Number(value) || 0;
        } else if (fieldType === 'boolean') {
          inputs[key] = value === 'true';
        } else {
          inputs[key] = value;
        }
      }
      return inputs;
    }
    return JSON.parse(rawJsonInput);
  }, [hasSchema, schemaInputs, rawJsonInput, schema]);

  const handleRunTest = useCallback(async () => {
    setIsRunning(true);
    setError(null);
    setCurrentResult(null);

    try {
      const inputs = buildInputs();
      const response = await serverService.mutate<{ testTool: ToolTestResult }>(
        testToolMutation,
        {
          toolId: tool.toolId,
          inputs: JSON.stringify(inputs),
          orgId,
        }
      );

      const result = response.testTool;
      setCurrentResult(result);

      // Add to history (Req 7.9)
      const entry: ToolTestHistoryEntry = {
        ...result,
        timestamp: new Date().toISOString(),
        inputs,
      };
      setHistory(prev => addToHistory(prev, entry, MAX_HISTORY));
    } catch (err: any) {
      setError(err.message || 'Failed to execute test');
    } finally {
      setIsRunning(false);
    }
  }, [buildInputs, tool.toolId, orgId]);

  return (
    <Card className="border-input bg-accent">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm text-foreground flex items-center gap-2">
            <Play className="size-4" />
            Test Sandbox
          </CardTitle>
          {onClose && (
            <Button variant="ghost" size="sm" onClick={onClose} className="text-muted-foreground h-6 px-2">
              ✕
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {/* Input Fields (Req 7.2, 7.10) */}
        {hasSchema ? (
          <div className="flex flex-col gap-2">
            {Object.entries(schema).map(([fieldName, fieldDef]: [string, any]) => (
              <div key={fieldName}>
                <label className="text-xs text-muted-foreground block mb-1">
                  {fieldName} <span className="text-muted-foreground">({fieldDef.type || 'string'})</span>
                </label>
                <Input
                  type="text"
                  value={schemaInputs[fieldName] || ''}
                  onChange={(e) => handleSchemaInputChange(fieldName, e.target.value)}
                  placeholder={`Enter ${fieldName}...`}
                  className="text-sm"
                />
              </div>
            ))}
          </div>
        ) : (
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Raw JSON Input
            </label>
            <Textarea
              value={rawJsonInput}
              onChange={(e) => setRawJsonInput(e.target.value)}
              placeholder='{"key": "value"}'
              rows={3}
              className="text-sm font-mono"
            />
          </div>
        )}

        {/* Run Test Button (Req 7.3) */}
        <Button
          size="sm"
          className="w-full"
          onClick={handleRunTest}
          disabled={isRunning}
        >
          <Play className="size-3 mr-1" />
          {isRunning ? 'Running...' : 'Run Test'}
        </Button>

        {/* Error Display */}
        {error && (
          <div className="p-2 bg-destructive/10 border border-destructive/30 rounded text-xs text-destructive">
            {error}
          </div>
        )}

        {/* Result Display (Req 7.6, 7.7) */}
        {currentResult && (
          <div className={`p-2 rounded border ${
            currentResult.success
              ? 'bg-chart-2/10 border-chart-2/30'
              : 'bg-destructive/10 border-destructive/30'
          }`}>
            <div className="flex items-center gap-2 mb-1">
              {currentResult.success ? (
                <CheckCircle className="size-4 text-chart-2" />
              ) : (
                <XCircle className="size-4 text-destructive" />
              )}
              <span className={`text-xs font-medium ${
                currentResult.success ? 'text-chart-2' : 'text-destructive'
              }`}>
                {currentResult.success ? 'Success' : 'Failed'}
              </span>
              <Badge className="bg-accent text-muted-foreground border-0 text-xs ml-auto">
                <Clock className="size-3 mr-1" />
                {currentResult.executionTimeMs}ms
              </Badge>
            </div>
            {currentResult.success && currentResult.output && (
              <pre className="text-xs text-muted-foreground mt-1 overflow-x-auto font-mono bg-background p-1 rounded">
                {typeof currentResult.output === 'string'
                  ? JSON.stringify(JSON.parse(currentResult.output), null, 2)
                  : JSON.stringify(currentResult.output, null, 2)}
              </pre>
            )}
            {!currentResult.success && currentResult.error && (
              <p className="text-xs text-destructive mt-1">{currentResult.error}</p>
            )}
          </div>
        )}

        {/* History (Req 7.9) */}
        {history.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <History className="size-3" />
              History ({history.length}/{MAX_HISTORY})
            </div>
            {history.slice().reverse().map((entry, idx) => (
              <div
                key={idx}
                className="flex items-center gap-2 text-xs p-1 bg-background rounded"
              >
                {entry.success ? (
                  <CheckCircle className="size-3 text-chart-2 flex-shrink-0" />
                ) : (
                  <XCircle className="size-3 text-destructive flex-shrink-0" />
                )}
                <span className="text-muted-foreground truncate flex-1">
                  {entry.success ? 'Pass' : entry.error?.slice(0, 30) || 'Error'}
                </span>
                <span className="text-muted-foreground">{entry.executionTimeMs}ms</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
