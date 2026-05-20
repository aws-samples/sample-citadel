/**
 * ConditionEditorPanel Component
 *
 * Panel for editing conditional edge expressions. Provides field (dot-notation),
 * operator dropdown, and value input. Optionally renders a dashed edge preview
 * with condition label.
 *
 * Requirements: 16.6, 16.7
 */

import React from 'react';
import type { EdgeCondition } from '../types/workflow';

const OPERATORS: EdgeCondition['operator'][] = [
  'equals',
  'notEquals',
  'contains',
  'greaterThan',
  'lessThan',
  'exists',
];

export interface ConditionEditorPanelProps {
  condition: EdgeCondition;
  onChange: (updated: EdgeCondition) => void;
  edgePreview?: boolean;
}

export function ConditionEditorPanel({
  condition,
  onChange,
  edgePreview,
}: ConditionEditorPanelProps) {
  return (
    <div className="flex flex-col p-4 gap-3 bg-background rounded border border-border">
      <h3 className="text-sm font-semibold text-foreground">Edge Condition</h3>

      <div className="flex flex-col gap-2">
        <div>
          <label htmlFor="condition-field" className="block text-xs text-muted-foreground mb-1">
            Field
          </label>
          <input
            id="condition-field"
            className="w-full text-sm border border-border rounded px-2 py-1 bg-accent text-foreground"
            value={condition.field}
            onChange={(e) => onChange({ ...condition, field: e.target.value })}
            placeholder="e.g. result.status"
          />
        </div>

        <div>
          <label htmlFor="condition-operator" className="block text-xs text-muted-foreground mb-1">
            Operator
          </label>
          <select
            id="condition-operator"
            className="w-full text-sm border border-border rounded px-2 py-1 bg-accent text-foreground"
            value={condition.operator}
            onChange={(e) =>
              onChange({ ...condition, operator: e.target.value as EdgeCondition['operator'] })
            }
          >
            {OPERATORS.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="condition-value" className="block text-xs text-muted-foreground mb-1">
            Value
          </label>
          <input
            id="condition-value"
            className="w-full text-sm border border-border rounded px-2 py-1 bg-accent text-foreground"
            value={condition.value ?? ''}
            onChange={(e) => onChange({ ...condition, value: e.target.value })}
            placeholder="Expected value"
          />
        </div>
      </div>

      {edgePreview && (
        <div className="flex flex-col mt-3 gap-1">
          <div
            data-testid="conditional-edge-preview"
            className="border-dashed border-t-2 border-primary w-full"
          />
          <div
            data-testid="conditional-edge-label"
            className="text-xs text-primary text-center"
          >
            {condition.field} {condition.operator} {String(condition.value)}
          </div>
        </div>
      )}
    </div>
  );
}
