import { useState, useCallback, useRef } from 'react';
import { approvalsService } from '../services/approvalsService';
import type { PendingApprovalItem, ApprovalDecision } from '../services/approvalsService';

const MAX_BATCH = 25;
const INTER_CALL_DELAY_MS = 250;

export type BulkItemStatus = 'pending' | 'succeeded' | 'conflict' | 'denied' | 'failed';

export interface BulkItemResult {
  recordId: string;
  name: string;
  status: BulkItemStatus;
  error?: string;
}

export interface UseBulkApprovalReturn {
  execute: (items: PendingApprovalItem[], decision: ApprovalDecision, reason?: string) => Promise<void>;
  results: BulkItemResult[];
  progress: { completed: number; total: number };
  isExecuting: boolean;
  retryFailed: () => Promise<void>;
  reset: () => void;
}

function classifyError(err: unknown): { status: 'conflict' | 'denied' | 'failed'; message: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes('conflict')) return { status: 'conflict', message: msg };
  if (lower.includes('denied') || lower.includes('unauthorized') || lower.includes('403') || lower.includes('forbidden'))
    return { status: 'denied', message: msg };
  return { status: 'failed', message: msg };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useBulkApproval(): UseBulkApprovalReturn {
  const [results, setResults] = useState<BulkItemResult[]>([]);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [isExecuting, setIsExecuting] = useState(false);

  // Keep the last batch context for retry
  const contextRef = useRef<{
    items: PendingApprovalItem[];
    decision: ApprovalDecision;
    reason?: string;
  } | null>(null);

  const processItems = useCallback(
    async (items: PendingApprovalItem[], decision: ApprovalDecision, reason?: string, existingResults?: BulkItemResult[]) => {
      if (items.length > MAX_BATCH) {
        throw new Error(`Batch size ${items.length} exceeds maximum of ${MAX_BATCH}`);
      }
      setIsExecuting(true);

      // Initialise results: keep existing succeeded items if provided (retry scenario)
      const initialResults: BulkItemResult[] = existingResults
        ? [...existingResults]
        : items.map((item) => ({
            recordId: item.recordId,
            name: item.displayName || item.name,
            status: 'pending' as BulkItemStatus,
          }));

      setResults(initialResults);
      const totalItems = initialResults.length;
      const alreadyCompleted = existingResults
        ? existingResults.filter((r) => r.status === 'succeeded').length
        : 0;
      setProgress({ completed: alreadyCompleted, total: totalItems });

      let completed = alreadyCompleted;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (i > 0) await delay(INTER_CALL_DELAY_MS);

        try {
          await approvalsService.decideApproval({
            recordId: item.recordId,
            recordType: item.recordType,
            decision,
            ...(item.version !== undefined ? { version: item.version } : {}),
            statusReason: reason,
          });

          completed++;
          setResults((prev) =>
            prev.map((r) => (r.recordId === item.recordId ? { ...r, status: 'succeeded' as BulkItemStatus } : r)),
          );
          setProgress({ completed, total: totalItems });
        } catch (err) {
          const classified = classifyError(err);
          completed++;
          setResults((prev) =>
            prev.map((r) =>
              r.recordId === item.recordId
                ? { ...r, status: classified.status, error: classified.message }
                : r,
            ),
          );
          setProgress({ completed, total: totalItems });
        }
      }

      setIsExecuting(false);
    },
    [],
  );

  const execute = useCallback(
    async (items: PendingApprovalItem[], decision: ApprovalDecision, reason?: string) => {
      contextRef.current = { items, decision, reason };
      await processItems(items, decision, reason);
    },
    [processItems],
  );

  const retryFailed = useCallback(async () => {
    if (!contextRef.current) return;
    const { items: allItems, decision, reason } = contextRef.current;

    // Find which items failed
    const failedIds = new Set(
      results.filter((r) => r.status !== 'succeeded').map((r) => r.recordId),
    );
    const failedItems = allItems.filter((item) => failedIds.has(item.recordId));
    if (failedItems.length === 0) return;

    // Keep succeeded results, reset failed ones
    const resetResults = results.map((r) =>
      failedIds.has(r.recordId) ? { ...r, status: 'pending' as BulkItemStatus, error: undefined } : r,
    );

    await processItems(failedItems, decision, reason, resetResults);
  }, [results, processItems]);

  const reset = useCallback(() => {
    setResults([]);
    setProgress({ completed: 0, total: 0 });
    setIsExecuting(false);
    contextRef.current = null;
  }, []);

  return { execute, results, progress, isExecuting, retryFailed, reset };
}
