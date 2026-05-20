import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ArrowLeft,
  Eye,
  EyeOff,
  Plus,
  RotateCcw,
  Trash2,
  Key,
  Activity,
  AlertCircle,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Skeleton } from '../components/ui/skeleton';
import { cn } from '../components/ui/utils';
import {
  maskApiKey,
  getHealthStatus,
  type HealthStatus,
} from '../utils/publishUtils';
import { appApiService } from '../services/appApiService';
import type { AppApiKey } from '../services/appApiService';
import serverService from '../services/server';
import { EndpointUrlDisplay } from './components/EndpointUrlDisplay';
import { PlaintextKeyReveal } from './components/PlaintextKeyReveal';
import { useMetricsAutoRefresh } from '../hooks/useMetricsAutoRefresh';

// ---- Types ----

interface AppMetrics {
  totalRequests: number;
  successCount: number;
  clientErrorCount: number;
  serverErrorCount: number;
  p50Latency: number;
  p95Latency: number;
  p99Latency: number;
  timeSeries: Array<{
    timestamp: string;
    requestCount: number;
    errorCount: number;
    avgLatency: number;
  }>;
}

type KeyRevealState = { [keyId: string]: boolean };

export interface AppApiDashboardProps {
  appId: string;
  onBack: () => void;
  onNavigate?: (view: string) => void;
}

// ---- Constants ----

const HEALTH_COLORS: Record<HealthStatus, { bg: string; text: string; label: string }> = {
  green: { bg: 'bg-chart-2/20', text: 'text-chart-2', label: 'Healthy' },
  yellow: { bg: 'bg-chart-4/20', text: 'text-chart-4', label: 'Degraded' },
  red: { bg: 'bg-destructive/20', text: 'text-destructive', label: 'Unhealthy' },
};

const TIME_RANGES = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 },
];

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

function formatTimestamp(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return ts;
  }
}

// ---- Component ----

export function AppApiDashboard({ appId, onBack, onNavigate: _onNavigate }: AppApiDashboardProps) {
  // App state
  const [appName, setAppName] = useState('');
  const [appStatus, setAppStatus] = useState('');
  const [endpointUrl, setEndpointUrl] = useState('');
  const [appLoading, setAppLoading] = useState(true);
  const [appError, setAppError] = useState<string | null>(null);

  // Keys state
  const [keys, setKeys] = useState<AppApiKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [keyRevealState, setKeyRevealState] = useState<KeyRevealState>({});

  // Create key dialog — two-step state machine
  type CreateDialogState =
    | { kind: 'closed' }
    | { kind: 'entry' }
    | { kind: 'submitting' }
    | { kind: 'confirmation'; plaintext: string; keyName: string }
    | { kind: 'error'; message: string };
  const [createDialog, setCreateDialog] = useState<CreateDialogState>({ kind: 'closed' });
  const [newKeyName, setNewKeyName] = useState('');
  const [newKeyExpiresIn, setNewKeyExpiresIn] = useState('');

  // Rotate key dialog
  const [rotateDialogOpen, setRotateDialogOpen] = useState(false);
  const [rotatedPlaintextKey, setRotatedPlaintextKey] = useState('');
  const [rotatedKeyName, setRotatedKeyName] = useState('');

  // Metrics state
  const [metrics, setMetrics] = useState<AppMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [selectedRange, setSelectedRange] = useState(TIME_RANGES[2]); // default 24h

  // ---- Data fetching ----

  const fetchApp = useCallback(async () => {
    setAppLoading(true);
    setAppError(null);
    try {
      const data = await appApiService.getApp(appId);
      setAppName(data.name);
      setAppStatus(data.status);
      setEndpointUrl(data.endpointUrl || '');
    } catch (err: any) {
      setAppError(err.message || 'Failed to load app data');
    } finally {
      setAppLoading(false);
    }
  }, [appId]);

  const fetchKeys = useCallback(async () => {
    setKeysLoading(true);
    setKeysError(null);
    try {
      const data = await appApiService.listAppApiKeys(appId);
      setKeys(data || []);
    } catch (err: any) {
      setKeysError(err.message || 'Failed to load API keys');
    } finally {
      setKeysLoading(false);
    }
  }, [appId]);

  const fetchMetrics = useCallback(async (hours: number) => {
    setMetricsLoading(true);
    setMetricsError(null);
    try {
      const endTime = new Date().toISOString();
      const startTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      const data = await appApiService.getAppMetrics(appId, startTime, endTime);
      setMetrics(data);
    } catch (err: any) {
      setMetricsError(err.message || 'Failed to load metrics');
    } finally {
      setMetricsLoading(false);
    }
  }, [appId]);

  // Anti-flicker refresh: doesn't touch metricsLoading, preserves stale data on failure
  const refreshMetrics = useCallback(async (hours: number) => {
    try {
      const endTime = new Date().toISOString();
      const startTime = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      const data = await appApiService.getAppMetrics(appId, startTime, endTime);
      setMetrics(data);
    } catch (err: any) {
      setMetricsError(err.message || 'Failed to refresh metrics');
    }
  }, [appId]);

  useEffect(() => {
    fetchApp();
  }, [fetchApp]);

  useEffect(() => {
    if (appStatus === 'PUBLISHED') {
      fetchKeys();
      fetchMetrics(selectedRange.hours);
    }
  }, [appStatus, fetchKeys, fetchMetrics, selectedRange.hours]);

  // Auto-refresh metrics (Req 12)
  const autoRefreshCallback = useMemo(
    () => () => refreshMetrics(selectedRange.hours),
    [refreshMetrics, selectedRange.hours],
  );
  useMetricsAutoRefresh({
    enabled: appStatus === 'PUBLISHED',
    onRefresh: autoRefreshCallback,
  });

  // Subscribe to onAppStatusChange for real-time status updates (Req 6)
  useEffect(() => {
    const ON_APP_STATUS_CHANGE = `
      subscription OnAppStatusChange($appId: ID!) {
        onAppStatusChange(appId: $appId) {
          appId
          previousStatus
          newStatus
          timestamp
        }
      }
    `;

    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = serverService.subscribe(
        ON_APP_STATUS_CHANGE,
        { appId },
        (data: any) => {
          const event = data?.onAppStatusChange;
          if (event?.newStatus) {
            setAppStatus(event.newStatus);
          }
        },
      );
    } catch (err) {
      // Graceful degradation [Req 6.5] — dashboard keeps working with initial getApp() status
      console.warn('Failed to subscribe to app status changes:', err);
    }

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [appId]);

  // ---- Key actions ----

  const handleCreateKey = async () => {
    if (!newKeyName.trim()) return;
    setCreateDialog({ kind: 'submitting' });
    try {
      const expiresIn = newKeyExpiresIn.trim() ? parseInt(newKeyExpiresIn.trim(), 10) : undefined;
      const result = await appApiService.createAppApiKey(appId, newKeyName.trim(), expiresIn);
      setCreateDialog({ kind: 'confirmation', plaintext: result.apiKey, keyName: newKeyName.trim() });
    } catch (err: any) {
      setCreateDialog({ kind: 'error', message: err.message || 'Failed to create API key' });
    }
  };

  const handleDismissCreateConfirmation = () => {
    setCreateDialog({ kind: 'closed' });
    setNewKeyName('');
    setNewKeyExpiresIn('');
    fetchKeys();
  };

  const handleRevokeKey = async (keyId: string) => {
    try {
      await appApiService.revokeAppApiKey(appId, keyId);
      await fetchKeys();
    } catch (err: any) {
      setKeysError(err.message || 'Failed to revoke API key');
    }
  };

  const handleRotateKey = async (keyId: string, keyName: string) => {
    try {
      const result = await appApiService.rotateAppApiKey(appId, keyId);
      if (!result.apiKey) {
        setKeysError('Rotation succeeded but plaintext was not returned. Please rotate again.');
        return;
      }
      setRotatedPlaintextKey(result.apiKey);
      setRotatedKeyName(keyName);
      setRotateDialogOpen(true);
    } catch (err: any) {
      setKeysError(err.message || 'Failed to rotate API key');
    }
  };

  const handleDismissRotate = () => {
    setRotateDialogOpen(false);
    setRotatedPlaintextKey('');
    setRotatedKeyName('');
    fetchKeys();
  };

  const toggleKeyReveal = (keyId: string) => {
    setKeyRevealState((prev) => ({ ...prev, [keyId]: !prev[keyId] }));
  };

  const handleTimeRangeChange = (range: typeof TIME_RANGES[number]) => {
    setSelectedRange(range);
  };

  // ---- Loading state for app ----

  if (appLoading) {
    return (
      <div className="min-h-screen bg-background text-foreground p-6">
        <div className="max-w-6xl mx-auto flex items-center gap-3">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
          <span className="text-muted-foreground">Loading app data…</span>
        </div>
      </div>
    );
  }

  // ---- App error state ----

  if (appError) {
    return (
      <div className="min-h-screen bg-background text-foreground p-6">
        <div className="max-w-6xl mx-auto">
          <Button variant="ghost" onClick={onBack} className="mb-4 text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4 mr-2" /> Back
          </Button>
          <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-6 text-center">
            <AlertCircle className="size-8 text-destructive mx-auto mb-2" />
            <p className="text-destructive mb-4">{appError}</p>
            <Button variant="outline" onClick={fetchApp}>
              <RefreshCw className="size-4 mr-2" /> Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ---- Non-PUBLISHED guard ----

  if (appStatus !== 'PUBLISHED') {
    return (
      <div className="min-h-screen bg-background text-foreground p-6">
        <div className="max-w-6xl mx-auto">
          <Button variant="ghost" onClick={onBack} className="mb-4 text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4 mr-2" /> Back
          </Button>
          <div className="bg-card border border-border rounded-lg p-8 text-center">
            <Key className="size-10 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">This app must be published before API data is available.</p>
          </div>
        </div>
      </div>
    );
  }

  // ---- Compute health ----

  const errorRate = metrics && metrics.totalRequests > 0
    ? (metrics.clientErrorCount + metrics.serverErrorCount) / metrics.totalRequests
    : 0;
  const healthStatus = getHealthStatus(errorRate);
  const healthColor = HEALTH_COLORS[healthStatus];

  // ---- Main render ----

  return (
    <div className="min-h-screen bg-background text-foreground p-6">
      <div className="flex flex-col max-w-6xl mx-auto gap-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" onClick={onBack} className="text-muted-foreground hover:text-foreground">
              <ArrowLeft className="size-4" />
            </Button>
            <div>
              <h1 className="text-2xl font-bold text-foreground">{appName}</h1>
              <p className="text-sm text-muted-foreground">API Dashboard</p>
            </div>
          </div>
          <Badge className="bg-chart-5/20 text-chart-5 border-chart-5/30">
            PUBLISHED
          </Badge>
        </div>

        {/* ===== Endpoint URL Section ===== */}
        {endpointUrl && <EndpointUrlDisplay endpointUrl={endpointUrl} />}

        {/* ===== API Keys Section ===== */}
        <div className="bg-card border border-border rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Key className="size-5 text-muted-foreground" />
              <h2 className="text-lg font-semibold text-foreground">API Keys</h2>
            </div>
            <Button
              size="sm"
              onClick={() => setCreateDialog({ kind: 'entry' })}
              className="bg-primary hover:bg-primary text-foreground"
            >
              <Plus className="size-4 mr-1" /> Create API Key
            </Button>
          </div>

          {/* Keys error */}
          {keysError && (
            <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertCircle className="size-4 text-destructive" />
                <span className="text-destructive text-sm">{keysError}</span>
              </div>
              <Button variant="outline" size="sm" onClick={fetchKeys}>
                <RefreshCw className="size-3 mr-1" /> Retry
              </Button>
            </div>
          )}

          {/* Keys loading */}
          {keysLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground mr-2" />
              <span className="text-muted-foreground">Loading API keys…</span>
            </div>
          ) : keys.length === 0 && !keysError ? (
            /* Empty state */
            <div className="text-center py-8">
              <Key className="size-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-muted-foreground">No API keys yet. Create your first key to get started.</p>
            </div>
          ) : keys.length > 0 ? (
            /* Keys table */
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground">
                    <th className="text-left py-2 px-3 font-medium">Name</th>
                    <th className="text-left py-2 px-3 font-medium">Key</th>
                    <th className="text-left py-2 px-3 font-medium">Status</th>
                    <th className="text-left py-2 px-3 font-medium">Created</th>
                    <th className="text-left py-2 px-3 font-medium">Expires</th>
                    <th className="text-left py-2 px-3 font-medium">Last Used</th>
                    <th className="text-right py-2 px-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((key) => (
                    <tr key={key.keyId} className="border-b border-border hover:bg-accent">
                      <td className="py-2 px-3 text-foreground">{key.name}</td>
                      <td className="py-2 px-3">
                        <div className="flex items-center gap-2">
                          <code className="text-xs bg-accent px-2 py-1 rounded font-mono text-muted-foreground">
                            {keyRevealState[key.keyId] ? key.keyId : maskApiKey(key.prefix)}
                          </code>
                          <button
                            onClick={() => toggleKeyReveal(key.keyId)}
                            className="text-muted-foreground hover:text-foreground transition-colors"
                            aria-label={keyRevealState[key.keyId] ? 'Hide key' : 'Reveal key'}
                          >
                            {keyRevealState[key.keyId] ? (
                              <EyeOff className="size-4" />
                            ) : (
                              <Eye className="size-4" />
                            )}
                          </button>
                        </div>
                      </td>
                      <td className="py-2 px-3">
                        <Badge
                          className={cn(
                            key.status === 'ACTIVE'
                              ? 'bg-chart-2/20 text-chart-2 border-chart-2/30'
                              : 'bg-muted/20 text-muted-foreground border-border'
                          )}
                        >
                          {key.status}
                        </Badge>
                      </td>
                      <td className="py-2 px-3 text-muted-foreground">{formatDate(key.createdAt)}</td>
                      <td className="py-2 px-3 text-muted-foreground">{key.expiresAt ? formatDate(key.expiresAt) : '—'}</td>
                      <td className="py-2 px-3 text-muted-foreground">{key.lastUsedAt ? formatDate(key.lastUsedAt) : '—'}</td>
                      <td className="py-2 px-3 text-right">
                        {key.status === 'ACTIVE' && (
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleRotateKey(key.keyId, key.name)}
                              className="text-muted-foreground hover:text-foreground h-7 px-2"
                              title="Rotate key"
                            >
                              <RotateCcw className="size-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleRevokeKey(key.keyId)}
                              className="text-muted-foreground hover:text-destructive h-7 px-2"
                              title="Revoke key"
                            >
                              <Trash2 className="size-3" />
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>

        {/* ===== Metrics Section ===== */}
        <div className="bg-card border border-border rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Activity className="size-5 text-muted-foreground" />
              <h2 className="text-lg font-semibold text-foreground">Metrics</h2>
              {metrics && (
                <Badge className={cn(healthColor.bg, healthColor.text, 'border-0 ml-2')}>
                  {healthColor.label}
                </Badge>
              )}
            </div>
            {/* Time range selector */}
            <div className="flex items-center gap-1 bg-accent rounded-lg p-1">
              {TIME_RANGES.map((range) => (
                <button
                  key={range.label}
                  onClick={() => handleTimeRangeChange(range)}
                  className={cn(
                    'px-3 py-1 text-xs rounded-md transition-colors',
                    selectedRange.label === range.label
                      ? 'bg-primary text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  {range.label}
                </button>
              ))}
            </div>
          </div>

          {/* Metrics error */}
          {metricsError && (
            <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertCircle className="size-4 text-destructive" />
                <span className="text-destructive text-sm">{metricsError}</span>
              </div>
              <Button variant="outline" size="sm" onClick={() => fetchMetrics(selectedRange.hours)}>
                <RefreshCw className="size-3 mr-1" /> Retry
              </Button>
            </div>
          )}

          {/* Metrics loading */}
          {metricsLoading ? (
            <div className="flex flex-col gap-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {Array.from({ length: 7 }).map((_, i) => (
                  <Skeleton key={i} className="h-20 bg-accent rounded-lg" />
                ))}
              </div>
              <Skeleton className="h-64 bg-accent rounded-lg" />
            </div>
          ) : !metrics && !metricsError ? (
            <div className="text-center py-8">
              <Activity className="size-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-muted-foreground">No data available for the selected time range</p>
            </div>
          ) : metrics ? (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <div className="bg-accent rounded-lg p-4">
                  <p className="text-xs text-muted-foreground mb-1">Total Requests</p>
                  <p className="text-2xl font-bold text-foreground">{metrics.totalRequests.toLocaleString()}</p>
                </div>
                <div className="bg-accent rounded-lg p-4">
                  <p className="text-xs text-muted-foreground mb-1">Success Count</p>
                  <p className="text-2xl font-bold text-chart-2">{metrics.successCount.toLocaleString()}</p>
                </div>
                <div className="bg-accent rounded-lg p-4">
                  <p className="text-xs text-muted-foreground mb-1">Client Errors</p>
                  <p className="text-2xl font-bold text-chart-4">{metrics.clientErrorCount.toLocaleString()}</p>
                </div>
                <div className="bg-accent rounded-lg p-4">
                  <p className="text-xs text-muted-foreground mb-1">Server Errors</p>
                  <p className="text-2xl font-bold text-destructive">{metrics.serverErrorCount.toLocaleString()}</p>
                </div>
                <div className="bg-accent rounded-lg p-4">
                  <p className="text-xs text-muted-foreground mb-1">p50 Latency</p>
                  <p className="text-2xl font-bold text-foreground">{metrics.p50Latency.toFixed(1)} ms</p>
                </div>
                <div className="bg-accent rounded-lg p-4">
                  <p className="text-xs text-muted-foreground mb-1">p95 Latency</p>
                  <p className="text-2xl font-bold text-foreground">{metrics.p95Latency.toFixed(1)} ms</p>
                </div>
                <div className="bg-accent rounded-lg p-4">
                  <p className="text-xs text-muted-foreground mb-1">p99 Latency</p>
                  <p className="text-2xl font-bold text-foreground">{metrics.p99Latency.toFixed(1)} ms</p>
                </div>
              </div>

              {/* Time-series charts */}
              {metrics.timeSeries.length > 0 ? (
                <div className="flex flex-col gap-6">
                  {/* Request Counts Chart */}
                  <div className="bg-accent rounded-lg p-4">
                    <h3 className="text-sm font-medium text-muted-foreground mb-3">Request Counts</h3>
                    <ResponsiveContainer width="100%" height={200}>
                      <LineChart data={metrics.timeSeries}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                        <XAxis
                          dataKey="timestamp"
                          tickFormatter={formatTimestamp}
                          stroke="#6B7280"
                          tick={{ fontSize: 11 }}
                        />
                        <YAxis stroke="#6B7280" tick={{ fontSize: 11 }} />
                        <Tooltip
                          contentStyle={{ backgroundColor: '#1F2937', border: '1px solid #374151', borderRadius: '8px' }}
                          labelFormatter={formatTimestamp}
                        />
                        <Line type="monotone" dataKey="requestCount" stroke="#3B82F6" strokeWidth={2} dot={false} name="Requests" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Error Rates Chart */}
                  <div className="bg-accent rounded-lg p-4">
                    <h3 className="text-sm font-medium text-muted-foreground mb-3">Error Rates</h3>
                    <ResponsiveContainer width="100%" height={200}>
                      <LineChart data={metrics.timeSeries}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                        <XAxis
                          dataKey="timestamp"
                          tickFormatter={formatTimestamp}
                          stroke="#6B7280"
                          tick={{ fontSize: 11 }}
                        />
                        <YAxis stroke="#6B7280" tick={{ fontSize: 11 }} />
                        <Tooltip
                          contentStyle={{ backgroundColor: '#1F2937', border: '1px solid #374151', borderRadius: '8px' }}
                          labelFormatter={formatTimestamp}
                        />
                        <Line type="monotone" dataKey="errorCount" stroke="#EF4444" strokeWidth={2} dot={false} name="Errors" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>

                  {/* Latency Chart */}
                  <div className="bg-accent rounded-lg p-4">
                    <h3 className="text-sm font-medium text-muted-foreground mb-3">Latency</h3>
                    <ResponsiveContainer width="100%" height={200}>
                      <LineChart data={metrics.timeSeries}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                        <XAxis
                          dataKey="timestamp"
                          tickFormatter={formatTimestamp}
                          stroke="#6B7280"
                          tick={{ fontSize: 11 }}
                        />
                        <YAxis stroke="#6B7280" tick={{ fontSize: 11 }} />
                        <Tooltip
                          contentStyle={{ backgroundColor: '#1F2937', border: '1px solid #374151', borderRadius: '8px' }}
                          labelFormatter={formatTimestamp}
                        />
                        <Line type="monotone" dataKey="avgLatency" stroke="#A855F7" strokeWidth={2} dot={false} name="Avg Latency (ms)" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              ) : (
                <div className="text-center py-8">
                  <p className="text-muted-foreground">No data available for the selected time range</p>
                </div>
              )}
            </>
          ) : null}
        </div>

        {/* ===== Create API Key Dialog (two-step state machine) ===== */}
        <Dialog
          open={createDialog.kind !== 'closed'}
          onOpenChange={(open) => {
            if (!open) {
              if (createDialog.kind === 'confirmation') {
                handleDismissCreateConfirmation();
              } else {
                setCreateDialog({ kind: 'closed' });
                setNewKeyName('');
                setNewKeyExpiresIn('');
              }
            }
          }}
        >
          <DialogContent className="bg-card border-border text-foreground">
            <DialogHeader>
              <DialogTitle className="text-foreground">
                {createDialog.kind === 'confirmation' ? 'API Key Created' : 'Create API Key'}
              </DialogTitle>
              {createDialog.kind !== 'confirmation' && (
                <DialogDescription className="text-muted-foreground">
                  Enter a name and optional expiration for the new API key.
                </DialogDescription>
              )}
            </DialogHeader>

            {(createDialog.kind === 'entry' || createDialog.kind === 'submitting' || createDialog.kind === 'error') && (
              <div className="flex flex-col gap-3 py-4">
                {createDialog.kind === 'error' && (
                  <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 flex items-center gap-2">
                    <AlertCircle className="size-4 text-destructive" />
                    <span className="text-destructive text-sm">{createDialog.message}</span>
                  </div>
                )}
                <Input
                  placeholder="Key name (required)"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  className="bg-accent border-border text-foreground"
                />
                <Input
                  placeholder="Expires in (seconds, optional)"
                  type="number"
                  value={newKeyExpiresIn}
                  onChange={(e) => setNewKeyExpiresIn(e.target.value)}
                  className="bg-accent border-border text-foreground"
                />
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    onClick={() => { setCreateDialog({ kind: 'closed' }); setNewKeyName(''); setNewKeyExpiresIn(''); }}
                    className="border-border text-muted-foreground"
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleCreateKey}
                    disabled={!newKeyName.trim() || createDialog.kind === 'submitting'}
                    className="bg-primary hover:bg-primary text-foreground"
                  >
                    {createDialog.kind === 'submitting' && <Loader2 className="size-4 mr-1 animate-spin" />}
                    Create
                  </Button>
                </div>
              </div>
            )}

            {createDialog.kind === 'confirmation' && (
              <PlaintextKeyReveal
                plaintext={createDialog.plaintext}
                keyName={createDialog.keyName}
                onDismiss={handleDismissCreateConfirmation}
              />
            )}
          </DialogContent>
        </Dialog>

        {/* ===== Rotate Key Result Dialog ===== */}
        <Dialog open={rotateDialogOpen} onOpenChange={(open) => { if (!open) handleDismissRotate(); }}>
          <DialogContent className="bg-card border-border text-foreground">
            <DialogHeader>
              <DialogTitle className="text-foreground">Key Rotated</DialogTitle>
            </DialogHeader>
            <PlaintextKeyReveal
              plaintext={rotatedPlaintextKey}
              keyName={rotatedKeyName}
              onDismiss={handleDismissRotate}
            />
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
