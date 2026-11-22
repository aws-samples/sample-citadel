/**
 * userScopedStorage — shared localStorage key conventions for data that must
 * never leak between two signed-in users on the same browser profile.
 *
 * Two features currently remember state in localStorage keyed only by a
 * workflowId or a fixed string, with no user scoping and nothing clearing
 * them on sign-out:
 *   - RunWorkflowDialog's "remember last run input" (citadel:run-input:<workflowId>)
 *   - AgentBlueprints' canvas autosave draft (workflow-autosave)
 *
 * Both now namespace their key with the signed-in user's id (Cognito sub,
 * surfaced as OrganizationContext's currentUser.userId), and clearSignedOutUserStorage()
 * is called from the sign-out handler to remove every key under either
 * prefix so a subsequent user on the same browser never sees a prior user's
 * remembered input or draft.
 */

export const RUN_INPUT_PREFIX = 'citadel:run-input:';
export const WORKFLOW_AUTOSAVE_PREFIX = 'workflow-autosave:';

/** Build the per-user, per-workflow key for RunWorkflowDialog's remembered input. */
export function runInputStorageKey(userId: string, workflowId: string): string {
  return `${RUN_INPUT_PREFIX}${userId}:${workflowId}`;
}

/** Build the per-user key for AgentBlueprints' canvas autosave draft. */
export function workflowAutosaveStorageKey(userId: string): string {
  return `${WORKFLOW_AUTOSAVE_PREFIX}${userId}`;
}

/**
 * Remove every localStorage entry under either user-scoped prefix. Call on
 * sign-out so a different user signing in on the same browser never
 * restores the previous user's remembered run input or canvas draft.
 */
export function clearSignedOutUserStorage(): void {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.startsWith(RUN_INPUT_PREFIX) || key.startsWith(WORKFLOW_AUTOSAVE_PREFIX))) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      localStorage.removeItem(key);
    }
  } catch {
    // localStorage unavailable — nothing to clear.
  }
}
