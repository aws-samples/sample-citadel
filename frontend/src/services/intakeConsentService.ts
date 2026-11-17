/**
 * Intake consent gate — writes a short-lived consent record to the backend
 * before the user's message triggers a privileged post-fabrication tool.
 *
 * Consent buttons are bound to an explicit catalogue id defined in the
 * canonical consent_catalogue.json (service/agent_intake_single/tools/).
 * The frontend renders the catalogue label and records consent for the id;
 * model-authored label/value is never used for consent determination.
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
 * The privileged post-fabrication actions. The action string must match
 * both the backend enum and the Python tools/consent.py PRIVILEGED_ACTIONS.
 */
export type IntakeConsentAction =
  | 'activate_agents'
  | 'create_agent_app'
  | 'generate_process_blueprint'
  | 'import_blueprint_to_app'
  | 'plan_fabrication'
  | 'confirm_fabrication_plan'
  | 'retry_failed_fabrication';

export interface ConsentCatalogueEntry {
  label: string;
  confirmMessage: string;
  description: string;
}

/**
 * Server-defined consent action catalogue. This is the frontend copy of
 * service/agent_intake_single/tools/consent_catalogue.json. Parity with
 * the JSON source is enforced by a test.
 */
export const CONSENT_CATALOGUE: Record<IntakeConsentAction, ConsentCatalogueEntry> = {
  activate_agents: {
    label: 'Activate the agents',
    confirmMessage: 'Yes, activate the agents',
    description: 'Activate fabricated agents so they are ready to use',
  },
  create_agent_app: {
    label: 'Create the app',
    confirmMessage: 'Yes, create the app',
    description: 'Create a new Agent App to bring the agents together',
  },
  generate_process_blueprint: {
    label: 'Generate blueprint',
    confirmMessage: 'Yes, generate the blueprint',
    description: 'Generate and publish the process blueprint',
  },
  import_blueprint_to_app: {
    label: 'Add blueprint to app',
    confirmMessage: 'Yes, add the blueprint to the app',
    description: 'Import the published blueprint into the app as a workflow',
  },
  plan_fabrication: {
    label: 'Plan fabrication',
    confirmMessage: 'Yes, plan the fabrication',
    description: 'Analyse the design and produce a fabrication plan',
  },
  confirm_fabrication_plan: {
    label: 'Confirm fabrication plan',
    confirmMessage: 'Yes, confirm the fabrication plan',
    description: 'Save the confirmed plan and queue agents for build',
  },
  retry_failed_fabrication: {
    label: 'Retry failed builds',
    confirmMessage: 'Yes, retry the failed builds',
    description: 'Re-queue fabrication for agents whose build failed or stalled',
  },
};

/**
 * Look up a consent action by its explicit id.
 * Returns the catalogue entry if the id is known, null otherwise.
 */
export function consentActionForId(
  id: string,
): ConsentCatalogueEntry | null {
  return (CONSENT_CATALOGUE as Record<string, ConsentCatalogueEntry>)[id] ?? null;
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
