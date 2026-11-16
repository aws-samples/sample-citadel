/**
 * ConditionEditorPanel — field validation tests
 * TDD Red Phase — tests written before implementation.
 *
 * CIT-291: validateConditionField regex and isConditionValid helper.
 */

import {
  validateConditionField,
  isConditionValid,
} from '../../utils/conditionValidation';
import type { EdgeCondition } from '../../types/workflow';

describe('validateConditionField', () => {
  it('accepts simple dot-path like result.route', () => {
    expect(validateConditionField('result.route')).toBe(true);
  });

  it('accepts single identifier like status', () => {
    expect(validateConditionField('status')).toBe(true);
  });

  it('accepts underscored path like _meta.field_name', () => {
    expect(validateConditionField('_meta.field_name')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(validateConditionField('')).toBe(false);
  });

  it('rejects string starting with digit', () => {
    expect(validateConditionField('123abc')).toBe(false);
  });

  it('rejects string with spaces', () => {
    expect(validateConditionField('result route')).toBe(false);
  });

  it('rejects string with special characters', () => {
    expect(validateConditionField('result[0]')).toBe(false);
  });
});

describe('isConditionValid', () => {
  it('returns true for valid equals condition', () => {
    const cond: EdgeCondition = { field: 'result.route', operator: 'equals', value: 'branch-a' };
    expect(isConditionValid(cond)).toBe(true);
  });

  it('returns false when field is empty', () => {
    const cond: EdgeCondition = { field: '', operator: 'equals', value: 'branch-a' };
    expect(isConditionValid(cond)).toBe(false);
  });

  it('returns false when field is invalid (starts with number)', () => {
    const cond: EdgeCondition = { field: '1field', operator: 'equals', value: 'v' };
    expect(isConditionValid(cond)).toBe(false);
  });

  it('returns false when value is empty for non-exists operator', () => {
    const cond: EdgeCondition = { field: 'result.ok', operator: 'equals', value: '' };
    expect(isConditionValid(cond)).toBe(false);
  });

  it('returns true for exists operator even with empty value', () => {
    const cond: EdgeCondition = { field: 'result.ok', operator: 'exists', value: '' };
    expect(isConditionValid(cond)).toBe(true);
  });

  it('returns true when value is 0 (falsy but valid)', () => {
    const cond: EdgeCondition = { field: 'result.count', operator: 'equals', value: 0 };
    expect(isConditionValid(cond)).toBe(true);
  });
});
