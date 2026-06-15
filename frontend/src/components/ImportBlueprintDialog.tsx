/**
 * ImportBlueprintDialog Component
 * Dialog for selecting an existing app or creating a new one to import a blueprint into.
 *
 * Requirements: 7.5, 8.1, 8.2, 8.3, 8.7
 */

import { useState, useEffect } from 'react';
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

  if (!blueprint) return null;

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
            <Select value={selectedAppId} onValueChange={setSelectedAppId}>
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
            disabled={loading}
          >
            {loading ? 'Importing...' : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
