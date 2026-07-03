import { useMemo, useState } from 'react';
import {
  SlidersHorizontal,
  Cpu,
  ShieldAlert,
  Loader2,
  AlertTriangle,
  RefreshCw,
  RotateCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { PageContainer } from '../components/PageContainer';
import { ErrorBoundary } from '../components/ErrorBoundary';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { Badge } from '../components/ui/badge';
import { Label } from '../components/ui/label';
import { Button } from '../components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '../components/ui/tooltip';
import { useOrganization } from '../contexts/OrganizationContext';
import { useModelConfig } from '../hooks/useModelConfig';
import {
  modelConfigService,
  ModelCatalogEntry,
} from '../services/modelConfigService';

/** Config slots that can carry a per-slot default model. */
const SLOT_DEFS: Array<{ key: string; label: string }> = [
  { key: 'intake_agent', label: 'Intake agent' },
  { key: 'extraction', label: 'Extraction' },
  { key: 'supervisor', label: 'Supervisor' },
  { key: 'fabricator', label: 'Fabricator' },
  { key: 'fabricated_agent_default', label: 'Fabricated agent default' },
];

const LOCALITY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'regional_preferred', label: 'Regional preferred' },
  { value: 'strict', label: 'Strict' },
];

const CATALOG_STATUSES = ['enabled', 'disabled', 'deprecated'];

/**
 * Sentinel Select value that maps to "clear this slot" (fall back to the
 * global default). Radix Select forbids empty-string item values, so we use a
 * non-empty sentinel and translate it to a delete on change.
 */
const USE_GLOBAL_VALUE = '__use_global_default__';

/**
 * Admin-only Model Configuration page. The catalog and every mutation are
 * data-driven off the model-config GraphQL API — there are no hardcoded model
 * identifiers here.
 */
export function ModelConfiguration() {
  const { isAdmin } = useOrganization();

  if (!isAdmin) {
    return (
      <PageContainer>
        <div
          role="alert"
          data-testid="model-config-admin-only"
          className="mx-auto mt-10 flex max-w-lg flex-col gap-2 rounded-lg border border-border bg-muted/30 p-6 text-center"
        >
          <div className="flex items-center justify-center gap-2">
            <ShieldAlert
              className="size-5 text-muted-foreground"
              aria-hidden="true"
            />
            <h1 className="text-lg font-semibold text-foreground">
              Administrator access required
            </h1>
          </div>
          <p className="text-sm text-muted-foreground">
            You need administrator privileges to view and manage model
            configuration.
          </p>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <ErrorBoundary>
        <ModelConfigurationContent />
      </ErrorBoundary>
    </PageContainer>
  );
}

function ModelConfigurationContent() {
  const { catalog, config, loading, error, refresh } = useModelConfig();
  const [syncing, setSyncing] = useState(false);

  const enabledEntries = useMemo(
    () => catalog.filter((entry) => entry.status === 'enabled'),
    [catalog]
  );

  // Group/sort catalog rows by provider, then by model key for a stable order.
  const sortedCatalog = useMemo(
    () =>
      [...catalog].sort((a, b) => {
        const byProvider = a.provider.localeCompare(b.provider);
        return byProvider !== 0
          ? byProvider
          : a.modelKey.localeCompare(b.modelKey);
      }),
    [catalog]
  );

  const slotDefaults = config?.slotDefaults ?? {};

  const handleGlobalDefaultChange = async (modelKey: string) => {
    try {
      await modelConfigService.updateModelConfig({ globalDefaultKey: modelKey });
      toast.success('Global default model updated');
      refresh();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to update global default');
    }
  };

  const handleSlotChange = async (slot: string, value: string) => {
    // Send the full merged slot map so the backend receives the complete set.
    const nextSlots: Record<string, string> = { ...slotDefaults };
    if (value === USE_GLOBAL_VALUE) {
      delete nextSlots[slot];
    } else {
      nextSlots[slot] = value;
    }
    try {
      await modelConfigService.updateModelConfig({ slotDefaults: nextSlots });
      toast.success('Slot default updated');
      refresh();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to update slot default');
    }
  };

  const handleLocalityChange = async (mode: string) => {
    try {
      await modelConfigService.updateModelConfig({ localityMode: mode });
      toast.success('Data locality updated');
      refresh();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to update data locality');
    }
  };

  const handleStatusChange = async (modelKey: string, status: string) => {
    try {
      await modelConfigService.setModelCatalogEntryStatus(modelKey, status);
      toast.success('Model status updated');
      refresh();
    } catch (err: any) {
      toast.error(err?.message || 'Failed to update model status');
    }
  };

  const handleModelSync = async () => {
    setSyncing(true);
    try {
      const res = await modelConfigService.syncModelCatalog();
      toast.success(res?.message || 'Model sync started', {
        description:
          'New models appear after the sync completes — use Refresh in a few seconds.',
      });
    } catch (e: any) {
      toast.error('Failed to start model sync', { description: e?.message });
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return (
      <div
        className="flex items-center justify-center gap-3 py-16 text-muted-foreground"
        data-testid="model-config-loading"
      >
        <Loader2 className="size-5 animate-spin" aria-hidden="true" />
        <span>Loading model configuration...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div
        role="alert"
        data-testid="model-config-error"
        className="flex flex-col gap-3 rounded-lg border border-destructive/50 bg-destructive/10 p-6"
      >
        <div className="flex items-center gap-2">
          <AlertTriangle
            className="size-5 text-destructive"
            aria-hidden="true"
          />
          <p className="font-medium text-destructive">
            Failed to load model configuration
          </p>
        </div>
        <p className="text-sm text-muted-foreground">{error}</p>
        <div>
          <Button
            variant="outline"
            className="cursor-pointer"
            onClick={() => refresh()}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }

  const optionLabel = (entry: ModelCatalogEntry) =>
    `${entry.provider} · ${entry.baseModelId}`;

  return (
    <div className="flex flex-col gap-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          <SlidersHorizontal
            className="size-6 text-primary"
            aria-hidden="true"
          />
          <div>
            <h1 className="text-2xl font-semibold text-foreground">
              Model Configuration
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Manage model defaults, per-slot overrides, data locality, and the
              model catalog.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            className="cursor-pointer"
            onClick={handleModelSync}
            disabled={syncing}
            aria-label="Sync model catalog from Bedrock"
          >
            {syncing ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="size-4" aria-hidden="true" />
            )}
            Model Sync
          </Button>
          <Button
            variant="outline"
            className="cursor-pointer"
            onClick={() => refresh()}
            aria-label="Refresh model configuration"
          >
            <RotateCw className="size-4" aria-hidden="true" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Defaults */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg font-semibold">
            <SlidersHorizontal
              className="size-5 text-muted-foreground"
              aria-hidden="true"
            />
            Defaults
          </CardTitle>
          <CardDescription>
            The global default applies to every slot unless a per-slot override
            is set.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {/* Global default */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="model-global-default">Global default model</Label>
            <Select
              value={config?.globalDefaultKey ?? undefined}
              onValueChange={handleGlobalDefaultChange}
            >
              <SelectTrigger
                id="model-global-default"
                aria-label="Global default model"
                className="w-full cursor-pointer sm:max-w-md"
              >
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {enabledEntries.map((entry) => (
                  <SelectItem key={entry.modelKey} value={entry.modelKey}>
                    {optionLabel(entry)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Per-slot defaults */}
          <div className="flex flex-col gap-4">
            <h3 className="text-sm font-medium text-foreground">
              Per-slot defaults
            </h3>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {SLOT_DEFS.map((slot) => {
                const controlId = `model-slot-${slot.key}`;
                const current = slotDefaults[slot.key] ?? USE_GLOBAL_VALUE;
                return (
                  <div key={slot.key} className="flex flex-col gap-2">
                    <Label htmlFor={controlId}>{slot.label}</Label>
                    <Select
                      value={current}
                      onValueChange={(value) =>
                        handleSlotChange(slot.key, value)
                      }
                    >
                      <SelectTrigger
                        id={controlId}
                        aria-label={`${slot.label} default model`}
                        className="w-full cursor-pointer"
                      >
                        <SelectValue placeholder="Use global default" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={USE_GLOBAL_VALUE}>
                          Use global default
                        </SelectItem>
                        {enabledEntries.map((entry) => (
                          <SelectItem key={entry.modelKey} value={entry.modelKey}>
                            {optionLabel(entry)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Data locality */}
          <div className="flex flex-col gap-2 sm:max-w-md">
            <Label htmlFor="model-locality">Data locality</Label>
            <Select
              value={config?.localityMode ?? 'off'}
              onValueChange={handleLocalityChange}
            >
              <SelectTrigger
                id="model-locality"
                aria-label="Data locality mode"
                className="w-full cursor-pointer"
              >
                <SelectValue placeholder="Select a mode" />
              </SelectTrigger>
              <SelectContent>
                {LOCALITY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Model catalog */}
      <section className="flex flex-col gap-4" aria-label="Model catalog">
        <div className="flex items-center gap-2">
          <Cpu className="size-5 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-lg font-semibold text-foreground">
            Model Catalog
          </h2>
        </div>

        {sortedCatalog.length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="model-catalog-empty"
          >
            No models in the catalog.
          </p>
        ) : (
          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Capabilities</TableHead>
                  <TableHead>Regions</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedCatalog.map((entry) => {
                  const regionKeys = Object.keys(entry.regionProfiles ?? {});
                  const statusId = `model-status-${entry.modelKey}`;
                  return (
                    <TableRow
                      key={entry.modelKey}
                      data-testid={`model-row-${entry.modelKey}`}
                    >
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium text-foreground">
                            {entry.modelKey}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {entry.baseModelId}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-foreground">
                        {entry.provider}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {entry.supportsTools && (
                            <Badge variant="secondary">tools</Badge>
                          )}
                          {entry.supportsStreaming && (
                            <Badge variant="secondary">streaming</Badge>
                          )}
                          <Badge variant="outline">{entry.modality}</Badge>
                          <Badge variant="outline">{entry.invocationMode}</Badge>
                        </div>
                      </TableCell>
                      <TableCell>
                        {regionKeys.length === 0 ? (
                          <span className="text-sm text-muted-foreground">0</span>
                        ) : (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="cursor-help text-sm text-foreground underline decoration-dotted">
                                {regionKeys.length}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {regionKeys.join(', ')}
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </TableCell>
                      <TableCell>
                        <Select
                          value={entry.status}
                          onValueChange={(value) =>
                            handleStatusChange(entry.modelKey, value)
                          }
                        >
                          <SelectTrigger
                            id={statusId}
                            aria-label={`Status for ${entry.modelKey}`}
                            size="sm"
                            className="w-36 cursor-pointer"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {CATALOG_STATUSES.map((status) => (
                              <SelectItem key={status} value={status}>
                                {status}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}

export default ModelConfiguration;
