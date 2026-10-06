/**
 * Normalises execution status strings so comparisons work regardless of
 * whether the backend returns lowercase ('running') or legacy fixtures
 * use uppercase ('RUNNING').
 */

export function normalizeExecutionStatus(status: string): string {
  return status.toLowerCase();
}

export function isRunning(status: string): boolean {
  return normalizeExecutionStatus(status) === 'running';
}

export function isAwaitingApproval(status: string): boolean {
  return normalizeExecutionStatus(status) === 'awaiting_approval';
}

export function isTerminal(status: string): boolean {
  const s = normalizeExecutionStatus(status);
  return s === 'completed' || s === 'succeeded' || s === 'failed' || s === 'cancelled';
}
