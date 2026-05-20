/**
 * ImportBlueprintDialog Component
 * Dialog for selecting an existing app or creating a new one to import a blueprint into.
 *
 * Requirements: 7.5, 8.1, 8.2, 8.3, 8.7
 */

import { useState, useEffect } from 'react';
import type { BlueprintData } from './BlueprintCard';
import { workflowApiService } from '../services/workflowApiService';
import { appApiService } from '../services/appApiService';

interface ImportBlueprintDialogProps {
  blueprint: BlueprintData | null;
  open: boolean;
  onClose: () => void;
  onImported?: () => void;
}

export function ImportBlueprintDialog({ blueprint, open, onClose, onImported }: ImportBlueprintDialogProps) {
  const [apps, setApps] = useState<any[]>([]);
  const [selectedAppId, setSelectedAppId] = useState<string>('');
  const [newAppName, setNewAppName] = useState('');
  const [mode, setMode] = useState<'select' | 'create'>('select');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      appApiService.listApps('default-org').then((result) => {
        setApps(result.items || []);
      }).catch(() => {
        setApps([]);
      });
    }
  }, [open]);

  if (!open || !blueprint) return null;

  const handleImport = async () => {
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

      await workflowApiService.importBlueprint(blueprint.workflowId, appId);
      onImported?.();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to import blueprint');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-card border border-border rounded-lg w-full max-w-md mx-4">
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-foreground font-medium">Import Blueprint</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-sm"
            aria-label="Close import dialog"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-col p-4 gap-4">
          <p className="text-muted-foreground text-sm">
            Import &quot;{blueprint.name}&quot; into an app
          </p>

          <div className="flex gap-2">
            <button
              onClick={() => setMode('select')}
              className={`text-xs px-3 py-1.5 rounded ${
                mode === 'select' ? 'bg-primary text-foreground' : 'bg-accent text-muted-foreground'
              }`}
            >
              Existing App
            </button>
            <button
              onClick={() => setMode('create')}
              className={`text-xs px-3 py-1.5 rounded ${
                mode === 'create' ? 'bg-primary text-foreground' : 'bg-accent text-muted-foreground'
              }`}
            >
              New App
            </button>
          </div>

          {mode === 'select' && (
            <select
              value={selectedAppId}
              onChange={(e) => setSelectedAppId(e.target.value)}
              className="w-full bg-accent border border-border text-muted-foreground text-sm rounded px-3 py-2"
              aria-label="Select app"
            >
              <option value="">Select an app...</option>
              {apps.map((app) => (
                <option key={app.appId} value={app.appId}>
                  {app.name}
                </option>
              ))}
            </select>
          )}

          {mode === 'create' && (
            <input
              type="text"
              value={newAppName}
              onChange={(e) => setNewAppName(e.target.value)}
              placeholder="New app name"
              className="w-full bg-accent border border-border text-muted-foreground text-sm rounded px-3 py-2"
              aria-label="New app name"
            />
          )}

          {error && <p className="text-destructive text-xs">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-border">
          <button
            onClick={onClose}
            className="text-xs text-muted-foreground hover:text-foreground px-3 py-1.5"
          >
            Cancel
          </button>
          <button
            onClick={handleImport}
            disabled={loading}
            className="text-xs bg-primary hover:bg-primary text-foreground px-4 py-1.5 rounded disabled:opacity-50"
          >
            {loading ? 'Importing...' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}
