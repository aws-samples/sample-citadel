/**
 * Approvals Service
 * Handles listing pending approvals and approve/reject decisions via GraphQL.
 */

import serverService from './server';
import { appApiService } from './appApiService';

// --- Types ---

export interface PendingApprovalItem {
  recordId: string;
  recordType: string;
  name: string;
  displayName: string;
  orgId: string;
  submittedAt: string;
  createdBy: string;
  status: string;
}

export interface PendingApprovalConnection {
  items: PendingApprovalItem[];
  nextToken?: string | null;
}

export type ApprovalDecision = 'APPROVED' | 'REJECTED';

export class NotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotSupportedError';
  }
}

/**
 * Whether tool approval/rejection is supported via the UI.
 * Currently no tool status mutation exists in the schema.
 */
export const supportsToolDecisions = false;

// --- GraphQL Documents ---

const LIST_PENDING_APPROVALS = `
  query ListPendingApprovals($limit: Int, $nextToken: String) {
    listPendingApprovals(limit: $limit, nextToken: $nextToken) {
      items {
        recordId
        recordType
        name
        displayName
        orgId
        submittedAt
        createdBy
        status
      }
      nextToken
    }
  }
`;

// --- Service ---

export const approvalsService = {
  /**
   * Fetch a page of pending approvals.
   */
  async listPendingApprovals(
    opts: { limit?: number; nextToken?: string } = {},
  ): Promise<PendingApprovalConnection> {
    const response = await serverService.query<{
      listPendingApprovals: PendingApprovalConnection;
    }>(LIST_PENDING_APPROVALS, {
      limit: opts.limit,
      nextToken: opts.nextToken,
    });
    return response.listPendingApprovals;
  },

  /**
   * Approve or reject a pending record.
   *
   * For agent records: delegates to appApiService.updateApp.
   * For tool records: throws NotSupportedError (no mutation exists yet).
   */
  async decideApproval(input: {
    recordId: string;
    recordType: string;
    decision: ApprovalDecision;
    version: number;
    statusReason?: string;
  }): Promise<void> {
    if (input.recordType === 'tool') {
      throw new NotSupportedError('tool approval via UI pending');
    }

    await appApiService.updateApp({
      appId: input.recordId,
      version: input.version,
      status: input.decision,
      statusReason: input.statusReason,
    });
  },
};
