/**
 * useWorkflowPersistence Hook
 * Auto-save with debounce, conflict resolution, and offline fallback.
 * Replaces localStorage auto-save with server-side persistence.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { workflowApiService } from '../services/workflowApiService';

export function useWorkflowPersistence(workflowId: string | null) {
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [conflict, setConflict] = useState(false);
  const [workflow, setWorkflow] = useState<any>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workflowIdRef = useRef(workflowId);

  // Keep workflowId ref in sync
  useEffect(() => {
    workflowIdRef.current = workflowId;
  }, [workflowId]);

  const load = useCallback(async () => {
    if (!workflowId) return null;
    const wf = await workflowApiService.getWorkflow(workflowId);
    setWorkflow(wf);
    return wf;
  }, [workflowId]);

  const save = useCallback((data: any) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setIsSaving(true);
      try {
        const result = await workflowApiService.updateWorkflow(data);
        setLastSaved(new Date());
        setWorkflow(result);
        setConflict(false);
      } catch (err: any) {
        if (err.message?.includes('Conflict')) {
          setConflict(true);
          await load();
        } else {
          // Offline fallback — persist to localStorage
          localStorage.setItem(
            `workflow-${data.workflowId}`,
            JSON.stringify(data)
          );
        }
      } finally {
        setIsSaving(false);
      }
    }, 3000);
  }, [load]);

  // Load workflow on mount
  useEffect(() => {
    load();
  }, [load]);

  // Retry pending localStorage saves when coming back online
  useEffect(() => {
    if (!workflowId) return;

    const handleOnline = async () => {
      const key = `workflow-${workflowId}`;
      const pending = localStorage.getItem(key);
      if (!pending) return;

      try {
        const data = JSON.parse(pending);
        await workflowApiService.updateWorkflow(data);
        localStorage.removeItem(key);
      } catch {
        // Still offline or another error — leave in localStorage
      }
    };

    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [workflowId]);

  return { save, load, isSaving, lastSaved, conflict, workflow };
}
