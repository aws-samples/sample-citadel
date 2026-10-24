/**
 * Intake consent gate — writes a short-lived consent record to the backend
 * before the user's message triggers a privileged post-fabrication tool.
 */
import serverService from './server';

const RECORD_INTAKE_CONSENT = `mutation RecordIntakeConsent($projectId: ID!, $action: String!) {
  recordIntakeConsent(projectId: $projectId, action: $action) {
    ok
    action
    expiresAt
  }
}`;

export interface IntakeConsentResult {
  ok: boolean;
  action: string;
  expiresAt: string;
}

/**
 * The four privileged post-fabrication actions. The action string must match
 * both the backend enum and the Python tools/consent.py PRIVILEGED_ACTIONS.
 */
export type IntakeConsentAction =
  | 'activate_agents'
  | 'create_agent_app'
  | 'generate_process_blueprint'
  | 'import_blueprint_to_app';

/**
 * Map from action button label substrings to the consent action that must be
 * recorded before the message is sent. Order matters: the first match wins.
 */
const CONSENT_LABEL_PATTERNS: readonly [RegExp, IntakeConsentAction][] = [
  [/activate/i, 'activate_agents'],
  [/create\b.*app|create\s+'[^']*'/i, 'create_agent_app'],
  [/generate.*blueprint/i, 'generate_process_blueprint'],
  [/add\b.*to\b|import/i, 'import_blueprint_to_app'],
];

/**
 * Determines whether an action button click requires a consent record.
 * Returns the action name if consent is needed, null otherwise.
 */
export function consentActionForLabel(label: string): IntakeConsentAction | null {
  for (const [pattern, action] of CONSENT_LABEL_PATTERNS) {
    if (pattern.test(label)) return action;
  }
  return null;
}

/**
 * Write a consent record to the backend. Must be called BEFORE sending
 * the user message that triggers the privileged tool.
 */
export async function recordIntakeConsent(
  projectId: string,
  action: IntakeConsentAction,
): Promise<IntakeConsentResult> {
  const response = await serverService.mutate<{
    recordIntakeConsent: IntakeConsentResult;
  }>(RECORD_INTAKE_CONSENT, { projectId, action });
  return response.recordIntakeConsent;
}
