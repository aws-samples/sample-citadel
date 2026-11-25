/**
 * useWorkflowPersistence Hook
 * Auto-save with debounce, conflict resolution, and offline fallback.
 * Replaces localStorage auto-save with server-side persistence.
 *
 * Safety properties (CIT-291 bug A, orphaned-save-after-remount):
 *  - the debounce timer is cleared on unmount, so no updateWorkflow fires
 *    for a canvas instance that no longer exists.
 *  - the version sent is read at FIRE time via getVersion(), never the
 *    value captured when save() was scheduled, so a version bump that
 *    lands between scheduling and firing (hydration, a prior save
 *    response) is honoured instead of racing the server with a stale one.
 *  - at most one updateWorkflow call is in flight at a time; a change
 *    that arrives while a save is in flight is queued and re-fires once
 *    the in-flight response has applied its new version, so two rapid
 *    edits always produce two SEQUENTIAL saves, never concurrent ones.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { workflowApiService } from '../services/workflowApiService';

/** Shape accepted by save(): the fields updateWorkflow needs for an update. */
interface WorkflowSaveData {
  workflowId: string;
  version: number;
  name?: string;
  description?: string;
  definition?: string;
  configuration?: string;
  metadata?: string;
}

/** The server workflow record returned by getWorkflow/createWorkflow/updateWorkflow. */
interface WorkflowRecord {
  workflowId: string;
  version?: number;
  [key: string]: unknown;
}

export function useWorkflowPersistence(
  workflowId: string | null,
  getVersion?: () => number
) {
  const [isSaving, setIsSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [conflict, setConflict] = useState(false);
  const [workflow, setWorkflow] = useState<WorkflowRecord | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workflowIdRef = useRef(workflowId);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);
  const pendingDataRef = useRef<WorkflowSaveData | null>(null);
  const getVersionRef = useRef(getVersion);

  // Keep the latest getVersion callback available without re-creating save().
  useEffect(() => {
    getVersionRef.current = getVersion;
  }, [getVersion]);

  // Keep workflowId ref in sync
  useEffect(() => {
    workflowIdRef.current = workflowId;
  }, [workflowId]);

  const load = useCallback(async () => {
    if (!workflowId) return null;
    const wf = await workflowApiService.getWorkflow(workflowId);
    if (!mountedRef.current) return wf;
    setWorkflow(wf);
    return wf;
  }, [workflowId]);

  // Fires exactly one updateWorkflow call. If another change was queued
  // while this call was in flight, immediately starts the next one with
  // the freshest data/version once this call settles — this is what keeps
  // saves sequential rather than concurrent.
  const runSave = useCallback(async (data: WorkflowSaveData) => {
    inFlightRef.current = true;
    setIsSaving(true);
    try {
      const version = getVersionRef.current ? getVersionRef.current() : data.version;
      const payload = { ...data, version };
      const result = await workflowApiService.updateWorkflow(payload);
      if (!mountedRef.current) return;
      setLastSaved(new Date());
      setWorkflow(result);
      setConflict(false);
    } catch (err: unknown) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : '';
      if (message.includes('Conflict')) {
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
      if (mountedRef.current) setIsSaving(false);
      inFlightRef.current = false;

      // A later change arrived while this save was in flight — run it now,
      // using whatever version is current at this point (set from the
      // response just applied above via the workflow-version effect, or a
      // conflict reload).
      const queued = pendingDataRef.current;
      pendingDataRef.current = null;
      if (queued && mountedRef.current) {
        runSave(queued);
      }
    }
  }, [load]);

  const save = useCallback((data: WorkflowSaveData) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      if (!mountedRef.current) return;
      if (inFlightRef.current) {
        // Serialise: don't start a second concurrent update. Keep only the
        // latest pending change — it supersedes anything queued before it.
        pendingDataRef.current = data;
        return;
      }
      runSave(data);
    }, 3000);
  }, [runSave]);

  // Load workflow on mount
  useEffect(() => {
    load();
  }, [load]);

  // Track mount state and clear any pending debounce timer on unmount so an
  // orphaned save can never fire for an instance that no longer exists.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      pendingDataRef.current = null;
    };
  }, []);

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
