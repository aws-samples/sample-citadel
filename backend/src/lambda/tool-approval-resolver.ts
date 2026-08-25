/**
 * tool-approval-resolver.ts — AppSync resolver for `decideToolApproval`
 * (finding c947aa77): PRE-GRANT a single-use approval for a gated tool.
 *
 * Governance controls (all server-side, none caller-authorable):
 *   * PERMISSION: the dedicated `tool:approve` permission (architect / admin
 *     only — see utils/auth.ts). No tool approval without it.
 *   * ORG MATCH: the caller's org is derived server-side from the Cognito
 *     identity; a caller may only grant approvals FOR THEIR OWN org. An
 *     `orgId` in the input that differs from the caller's org is REJECTED
 *     (cross-org grant attempt). The persisted grant's orgId is ALWAYS the
 *     server-derived caller org, never the input value.
 *   * decidedBy: ALWAYS authContext.userId (Cognito) — there is deliberately
 *     no `decidedBy` field on the input type. A hostile caller that stuffs a
 *     `decidedBy` into the arguments cannot influence the persisted value.
 *
 * This is CHECK-AND-REFUSE v1 (decision 6ac67191): it pre-grants an approval
 * that a future run may consume once. It is NOT an in-flight / pause-and-
 * resume approval — see docs/APPROVAL_GATING.md.
 */
import { hasPermission } from "../utils/auth";
import { extractOrgFromEvent } from "../utils/auth-event";
import {
  writeToolApprovalGrant,
  type ToolApprovalGrantInput,
} from "./utils/tool-approval-grant-writer";
import type { AuthContext, GovernanceResolverEvent } from "../types";

interface DecideToolApprovalArgsInput {
  /** The org the approval is for. Optional; when present it MUST equal the
   * caller's server-derived org (cross-org grants are rejected). The
   * persisted value is always the server-derived caller org regardless. */
  orgId?: string;
  workflowDefinitionId: string;
  nodeId: string;
  toolName: string;
  validitySeconds?: number;
  justification?: string | null;
}

interface DecideToolApprovalArguments {
  input: DecideToolApprovalArgsInput;
}

type DecideToolApprovalEvent =
  GovernanceResolverEvent<DecideToolApprovalArguments>;

function authContextFromEvent(event: DecideToolApprovalEvent): AuthContext {
  const identity = event?.identity || {};
  const claimRole = identity["custom:role"] ?? identity.claims?.["custom:role"];
  return {
    userId: identity.sub || identity.username || "anonymous",
    username: identity.username,
    groups: identity["cognito:groups"] || [],
    roles: claimRole ? [claimRole as string] : [],
  };
}

export async function decideToolApproval(
  input: DecideToolApprovalArgsInput,
  authContext: AuthContext,
  callerOrgId: string,
): Promise<{ findingId: string; expiresAt: number; decidedBy: string }> {
  // PERMISSION gate — dedicated tool:approve (admin via bypass in auth.ts).
  if (!hasPermission(authContext, "tool:approve")) {
    throw new Error(
      "UnauthorizedError: tool:approve permission required to grant a tool approval",
    );
  }

  // ORG MATCH — a caller may only grant approvals for their own org. An
  // input orgId that differs from the server-derived caller org is a
  // cross-org attempt and is rejected. The persisted orgId is callerOrgId.
  if (input.orgId !== undefined && input.orgId !== callerOrgId) {
    throw new Error(
      "UnauthorizedError: cannot grant a tool approval for a different organization",
    );
  }

  if (!input.workflowDefinitionId || !input.nodeId || !input.toolName) {
    throw new Error(
      "ValidationError: workflowDefinitionId, nodeId and toolName are required",
    );
  }

  const grantInput: ToolApprovalGrantInput = {
    orgId: callerOrgId, // server-derived — never the caller-supplied orgId
    workflowDefinitionId: input.workflowDefinitionId,
    nodeId: input.nodeId,
    toolName: input.toolName,
    decidedBy: authContext.userId, // server-derived from Cognito — never input
    validitySeconds: input.validitySeconds,
    justification: input.justification ?? null,
  };

  const { findingId, expiresAt } = await writeToolApprovalGrant(grantInput);
  return { findingId, expiresAt, decidedBy: authContext.userId };
}

export const handler = async (
  event: DecideToolApprovalEvent,
): Promise<unknown> => {
  const fieldName = event?.info?.fieldName;
  const authContext = authContextFromEvent(event);
  if (fieldName !== "decideToolApproval") {
    throw new Error(`Unsupported field: ${fieldName}`);
  }
  const callerOrgId = await extractOrgFromEvent(event);
  if (!callerOrgId) {
    throw new Error(
      "ValidationError: caller organization could not be determined",
    );
  }
  return await decideToolApproval(
    event.arguments.input,
    authContext,
    callerOrgId,
  );
};
