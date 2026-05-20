/**
 * Wizard validation utilities for the App Builder Wizard.
 * Pure functions for step-by-step validation of wizard data.
 */

export interface WizardStepData {
  name?: string;
  description?: string;
  agents?: string[];
  workflows?: string[];
  permissions?: Array<{ actions: string[]; resources: string[] }>;
  configSchema?: string;
  configValues?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate app name — accept 3-100 chars, reject outside range.
 */
export function validateAppName(name: string): ValidationResult {
  const errors: string[] = [];

  if (name.length < 3) {
    errors.push('Name must be at least 3 characters');
  }
  if (name.length > 100) {
    errors.push('Name must be at most 100 characters');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate wizard step data — check required fields per step.
 *
 * Steps:
 *  0 = Name (name required, 3-100 chars)
 *  1 = Agents (at least one agent selected)
 *  2 = Workflows (at least one workflow selected)
 *  3 = Permissions (no required fields — optional step)
 *  4 = Configuration (no required fields — optional step)
 *  5 = Review (always valid — summary step)
 */
export function validateWizardStep(step: number, data: WizardStepData): ValidationResult {
  switch (step) {
    case 0: {
      const nameResult = validateAppName(data.name ?? '');
      const errors = [...nameResult.errors];
      if (data.description && data.description.length > 500) {
        errors.push('Description must be at most 500 characters');
      }
      return { valid: errors.length === 0, errors };
    }
    case 1: {
      const errors: string[] = [];
      if (!data.agents || data.agents.length === 0) {
        errors.push('Select at least one agent');
      }
      return { valid: errors.length === 0, errors };
    }
    case 2: {
      const errors: string[] = [];
      if (!data.workflows || data.workflows.length === 0) {
        errors.push('Select at least one workflow');
      }
      return { valid: errors.length === 0, errors };
    }
    case 3:
      return { valid: true, errors: [] };
    case 4:
      return { valid: true, errors: [] };
    case 5:
      return { valid: true, errors: [] };
    default:
      return { valid: false, errors: ['Unknown wizard step'] };
  }
}
