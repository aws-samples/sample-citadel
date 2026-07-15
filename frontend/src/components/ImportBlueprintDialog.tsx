/**
 * ImportBlueprintDialog Component
 * Dialog for selecting an existing app or creating a new one to import a blueprint into.
 *
 * On import, every DISTINCT agent slot referenced by the blueprint's definition
 * nodes must be mapped to a real agent from the agent catalog. Placeholder slots
 * (agentId starting with `placeholder-`) MUST be re-mapped before the import can
 * proceed; the resulting agentMapping ({ [slotAgentId]: realAgentId }) is passed
 * to the importBlueprint mutation so an imported blueprint cannot reach PUBLISHED
 * while it still references non-existent placeholder agents.
 */

import { useState, useEffect, useMemo } from 'react';
import type { BlueprintData } from './BlueprintCard';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
import { Input } from './ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import { workflowApiService } from '../services/workflowApiService';
import { appApiService } from '../services/appApiService';
import { agentConfigService, type AgentConfig } from '../services/agentConfigService';

interface ImportBlueprintDialogProps {
  blueprint: BlueprintData | null;
  open: boolean;
  onClose: () => void;
  onImported?: () => void;
}

const PLACEHOLDER_PREFIX = 'placeholder-';

function isPlaceholderSlot(slot: string): boolean {
  return slot.startsWith(PLACEHOLDER_PREFIX);
}

/** Parse the (possibly double-encoded AWSJSON) definition into its node list. */
function parseDefinitionNodes(definition: string): any[] {
  try {
    let parsed: any = typeof definition === 'string' ? JSON.parse(definition) : definition;
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    return Array.isArray(parsed?.nodes) ? parsed.nodes : [];
  } catch {
    return [];
  }
}

/** Distinct, order-preserving list of agentIds referenced by the blueprint's nodes. */
function extractAgentSlots(definition: string): string[] {
  const slots: string[] = [];
  const seen = new Set<string>();
  for (const node of parseDefinitionNodes(definition)) {
    const agentId = node?.agentId ?? node?.data?.agentId;
    if (typeof agentId === 'string' && agentId.trim() && !seen.has(agentId)) {
      seen.add(agentId);
      slots.push(agentId);
    }
  }
  return slots;
}

function agentDisplayName(agent: AgentConfig): string {
  if (agent.name && agent.name.trim()) return agent.name;
  const cfg: any = agent.config;
  if (cfg && typeof cfg === 'object' && typeof cfg.name === 'string' && cfg.name.trim()) {
    return cfg.name;
  }
  return agent.agentId;
}

export function ImportBlueprintDialog({ blueprint, open, onClose, onImported }: ImportBlueprintDialogProps) {
  const [apps, setApps] = useState<any[]>([]);
  const [selectedAppId, setSelectedAppId] = useState<string>('');
  const [newAppName, setNewAppName] = useState('');
  const [mode, setMode] = useState<'select' | 'create'>('select');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [agentMapping, setAgentMapping] = useState<Record<string, string>>({});

  const workflowId = blueprint?.workflowId;

  // Distinct agent slots referenced by this blueprint's nodes.
  const slots = useMemo(
    () => (blueprint ? extractAgentSlots(blueprint.definition) : []),
    [blueprint],
  );

  useEffect(() => {
    if (!open) return;
    appApiService
      .listApps('default-org')
      .then((result) => setApps(result.items || []))
      .catch(() => setApps([]));
  }, [open]);

  // Load the real-agent catalog and seed the slot→agent mapping when the dialog
  // opens for a blueprint. Placeholder slots start unmapped (force a choice);
  // real slots default to their current value.
  useEffect(() => {
    if (!open || !blueprint) return;
    const initial: Record<string, string> = {};
    for (const slot of extractAgentSlots(blueprint.definition)) {
      initial[slot] = isPlaceholderSlot(slot) ? '' : slot;
    }
    setAgentMapping(initial);
    agentConfigService
      .listAgentConfigs()
      .then(setAgents)
      .catch(() => setAgents([]));
  }, [open, workflowId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!blueprint) return null;

  const unmappedPlaceholders = slots.filter((slot) => isPlaceholderSlot(slot) && !agentMapping[slot]);
  const hasUnmappedPlaceholders = unmappedPlaceholders.length > 0;

  const optionsForSlot = (slot: string): Array<{ value: string; label: string }> => {
    const opts = agents.map((a) => ({ value: a.agentId, label: agentDisplayName(a) }));
    // "plus the current value": preserve a real (non-placeholder) slot's current
    // agentId as a selectable option even if it is not in the catalog.
    if (!isPlaceholderSlot(slot) && !agents.some((a) => a.agentId === slot)) {
      opts.unshift({ value: slot, label: `Current: ${slot}` });
    }
    return opts;
  };

  const handleImport = async () => {
    if (hasUnmappedPlaceholders) return;
    setLoading(true);
    setError(null);
    try {
      let appId = selectedAppId;

      if (mode === 'create' && newAppName.trim()) {
        const newApp = await appApiService.createApp({
          name: newAppName.trim(),
          orgId: 'default-org',
        });
        appId = newApp.appId;
      }

      if (!appId) {
        setError('Please select or create an app');
        setLoading(false);
        return;
      }

      const mapping: Record<string, string> = {};
      for (const slot of slots) {
        const chosen = agentMapping[slot];
        if (chosen) mapping[slot] = chosen;
      }

      await workflowApiService.importBlueprint(
        blueprint.workflowId,
        appId,
        undefined,
        slots.length ? mapping : undefined,
      );
      onImported?.();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to import blueprint');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Import Blueprint</DialogTitle>
          <DialogDescription>
            Import &quot;{blueprint.name}&quot; into an app
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Alert>
            <AlertDescription>
              This is a template blueprint. After import, you must re-map any placeholder agent IDs to real agents in your project before publishing.
            </AlertDescription>
          </Alert>

          <div className="flex gap-2">
            <Button
              variant={mode === 'select' ? 'default' : 'outline'}
              size="sm"
              className="text-xs h-7 px-3"
              onClick={() => setMode('select')}
            >
              Existing App
            </Button>
            <Button
              variant={mode === 'create' ? 'default' : 'outline'}
              size="sm"
              className="text-xs h-7 px-3"
              onClick={() => setMode('create')}
            >
              New App
            </Button>
          </div>

          {mode === 'select' && (
            <Select value={selectedAppId} onValueChange={setSelectedAppId} aria-label="Select app">
              <SelectTrigger className="w-full" aria-label="Select app">
                <SelectValue placeholder="Select an app..." />
              </SelectTrigger>
              <SelectContent>
                {apps.map((app) => (
                  <SelectItem key={app.appId} value={app.appId}>
                    {app.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {mode === 'create' && (
            <Input
              type="text"
              value={newAppName}
              onChange={(e) => setNewAppName(e.target.value)}
              placeholder="New app name"
              aria-label="New app name"
            />
          )}

          {slots.length > 0 && (
            <div className="flex flex-col gap-3 border-t border-border pt-3">
              <div>
                <p className="text-foreground text-sm font-medium">Map agent slots</p>
                <p className="text-muted-foreground text-xs">
                  Assign each blueprint agent slot to a real agent in your project.
                </p>
              </div>

              {slots.map((slot) => {
                const placeholder = isPlaceholderSlot(slot);
                return (
                  <div key={slot} className="flex flex-col gap-1" data-testid={`agent-slot-${slot}`}>
                    <label className="text-xs text-muted-foreground flex items-center gap-2">
                      <span className="font-mono">{slot}</span>
                      {placeholder && (
                        <span className="text-destructive">placeholder — must map</span>
                      )}
                    </label>
                    <Select
                      value={agentMapping[slot] ?? ''}
                      onValueChange={(value) =>
                        setAgentMapping((prev) => ({ ...prev, [slot]: value }))
                      }
                      aria-label={`Map agent slot ${slot}`}
                    >
                      <SelectTrigger className="w-full" aria-label={`Map agent slot ${slot}`}>
                        <SelectValue placeholder="Select a real agent..." />
                      </SelectTrigger>
                      <SelectContent>
                        {optionsForSlot(slot).map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}

              {hasUnmappedPlaceholders && (
                <p className="text-destructive text-xs" role="alert">
                  All agent slots must be mapped to a real agent before import.
                </p>
              )}
            </div>
          )}

          {error && <p className="text-destructive text-xs">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleImport}
            disabled={loading || hasUnmappedPlaceholders}
          >
            {loading ? 'Importing...' : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
