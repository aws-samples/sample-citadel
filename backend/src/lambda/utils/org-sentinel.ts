/**
 * Org value an org-less Cognito caller lands on.
 *
 * Single source of truth shared by registry-agent-record-resolver.ts's
 * createApp/createWorkflow org-less-caller handling and
 * intake-orchestration-resolver.ts's resolveOrgId fallback chain, so both
 * paths agree on one literal instead of drifting onto separately hardcoded
 * copies ('default' — the UI's `selectedOrganization || 'default'`
 * fallback, AppBuilderWizard.tsx).
 *
 * Deliberately kept in its own leaf module (no other imports) rather than
 * re-exported from registry-agent-record-resolver.ts: tests that
 * `jest.mock('../registry-agent-record-resolver', () => ({ ... }))` replace
 * that module's entire export surface, which silently turned this constant
 * into `undefined` for any consumer importing it from that module while it
 * was mocked. Importing it from this leaf module instead means it survives
 * such mocks unaffected.
 */
export const ORGLESS_CALLER_ORG = "default";
