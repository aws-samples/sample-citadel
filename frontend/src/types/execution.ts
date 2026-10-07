/**
 * Execution and ApprovalRequest types matching backend GraphQL schema (CIT-030).
 */

export interface ApprovalRequest {
  nodeId: string;
  requestType: string;
  reason?: string | null;
  requestedBy?: string | null;
  requestedAt?: string | null;
  expiresAt?: string | null;
  decidedBy?: string | null;
  decidedAt?: string | null;
  decision?: string | null;
}

export interface Execution {
  executionId: string;
  workflowId: string;
  appId?: string | null;
  orgId: string;
  status: string;
  workflowVersion?: number | null;
  currentNode?: string | null;
  nodeResults?: string | null;
  input?: string | null;
  output?: string | null;
  startedAt: string;
  completedAt?: string | null;
  triggeredBy: string;
  error?: string | null;
  usageTotals?: string | null;
  approvalRequests?: ApprovalRequest[] | null;
}
