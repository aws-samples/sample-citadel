/**
 * Condition validation utilities.
 *
 * Shared between ConditionEditorPanel and EdgeConditionSheet.
 * CIT-291
 */

import type { EdgeCondition } from '../types/workflow';

/** Regex for valid dot-notation field paths (e.g. result.route, _meta.field_name). */
const FIELD_REGEX = /^[A-Za-z_][A-Za-z0-9_.]*$/;

/**
 * Validates that a field string is a valid dot-notation path.
 */
export function validateConditionField(field: string): boolean {
  return field.length > 0 && FIELD_REGEX.test(field);
}

/**
 * Returns true when the condition is structurally valid and ready to apply.
 * - field must be non-empty and match FIELD_REGEX
 * - value is required for all operators except 'exists'
 * - value of 0 is valid (falsy but intentional)
 */
export function isConditionValid(condition: EdgeCondition): boolean {
  if (!validateConditionField(condition.field)) return false;
  if (condition.operator === 'exists') return true;
  // value must be present and non-empty-string (0 is OK)
  if (condition.value === '' || condition.value === undefined || condition.value === null) return false;
  return true;
}
