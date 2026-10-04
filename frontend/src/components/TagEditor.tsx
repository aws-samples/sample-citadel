/**
 * TagEditor — key=value tag editor with optional policy enforcement.
 *
 * Props:
 *   value:    Record<string, string> — current tag map
 *   onChange: (tags: Record<string, string>) => void
 *   policy?:  TagPolicy | null — when present, pre-seeds required keys and
 *             constrains allowed values
 *   errors?:  TagViolation[] — backend violations rendered inline
 *
 * Client-side format limits:
 *   - Max 10 keys
 *   - Key max length 64 chars
 *   - Value max length 256 chars
 */

import { useCallback, useMemo } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import type { TagPolicy } from '../services/tagPolicyService';
import type { TagViolation } from '../lib/tag-policy-errors';

const MAX_KEYS = 10;
const MAX_KEY_LENGTH = 64;
const MAX_VALUE_LENGTH = 256;

export interface TagEditorProps {
  value: Record<string, string>;
  onChange: (tags: Record<string, string>) => void;
  policy?: TagPolicy | null;
  errors?: TagViolation[];
}

interface TagRow {
  key: string;
  value: string;
  /** Whether this key is required by the policy (key is read-only). */
  required: boolean;
  /** When the policy constrains allowed values for this key. */
  allowedValues?: string[];
}

export function TagEditor({ value, onChange, policy, errors }: TagEditorProps) {
  const rows = useMemo(() => buildRows(value, policy), [value, policy]);

  /** Identify required keys that are missing from the current value. */
  const missingRequired = useMemo(() => {
    if (!policy) return [] as string[];
    return policy.requiredKeys
      .filter((r) => !(r.key in value))
      .map((r) => r.key);
  }, [value, policy]);

  const violationMap = useMemo(() => {
    const map = new Map<string, TagViolation>();
    if (errors) {
      for (const v of errors) map.set(v.key, v);
    }
    return map;
  }, [errors]);

  const atLimit = Object.keys(value).length >= MAX_KEYS;

  const handleKeyChange = useCallback(
    (oldKey: string, newKey: string) => {
      if (newKey.length > MAX_KEY_LENGTH) return;
      const next = { ...value };
      const val = next[oldKey] ?? '';
      delete next[oldKey];
      next[newKey] = val;
      onChange(next);
    },
    [value, onChange],
  );

  const handleValueChange = useCallback(
    (key: string, newValue: string) => {
      if (newValue.length > MAX_VALUE_LENGTH) return;
      onChange({ ...value, [key]: newValue });
    },
    [value, onChange],
  );

  const handleAdd = useCallback(() => {
    if (atLimit) return;
    // Generate a unique placeholder key.
    let idx = 1;
    while (`key${idx}` in value) idx++;
    onChange({ ...value, [`key${idx}`]: '' });
  }, [value, onChange, atLimit]);

  const handleRemove = useCallback(
    (key: string) => {
      const next = { ...value };
      delete next[key];
      onChange(next);
    },
    [value, onChange],
  );

  return (
    <div data-testid="tag-editor" className="flex flex-col gap-2">
      <Label>Tags</Label>

      {rows.map((row) => {
        const violation = violationMap.get(row.key);
        return (
          <div key={row.key} className="flex items-start gap-2">
            {/* Key */}
            <div className="flex-1">
              <Input
                data-testid={`tag-key-${row.key}`}
                value={row.key}
                readOnly={row.required}
                disabled={row.required}
                maxLength={MAX_KEY_LENGTH}
                placeholder="key"
                onChange={(e) => handleKeyChange(row.key, e.target.value)}
                aria-label={`Tag key: ${row.key}`}
              />
            </div>

            {/* Value */}
            <div className="flex-1">
              {row.allowedValues && row.allowedValues.length > 0 ? (
                <Select
                  value={row.value}
                  onValueChange={(v) => handleValueChange(row.key, v)}
                >
                  <SelectTrigger data-testid={`tag-value-select-${row.key}`} aria-label={`Tag value for ${row.key}`}>
                    <SelectValue placeholder="Select value" />
                  </SelectTrigger>
                  <SelectContent>
                    {row.allowedValues.map((av) => (
                      <SelectItem key={av} value={av}>
                        {av}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  data-testid={`tag-value-${row.key}`}
                  value={row.value}
                  maxLength={MAX_VALUE_LENGTH}
                  placeholder="value"
                  onChange={(e) => handleValueChange(row.key, e.target.value)}
                  aria-label={`Tag value for ${row.key}`}
                />
              )}
              {violation && (
                <p data-testid={`tag-error-${row.key}`} className="text-sm text-destructive mt-1">
                  {violation.type === 'MISSING_KEY'
                    ? `Required key "${row.key}" is missing`
                    : `Invalid value "${violation.suppliedValue ?? ''}" for key "${row.key}"`}
                </p>
              )}
            </div>

            {/* Remove button — not shown for required keys */}
            {!row.required ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-testid={`tag-remove-${row.key}`}
                onClick={() => handleRemove(row.key)}
                aria-label={`Remove tag ${row.key}`}
              >
                ✕
              </Button>
            ) : (
              <div className="w-9" /> /* spacer to keep alignment */
            )}
          </div>
        );
      })}

      {/* Missing required keys warning */}
      {missingRequired.length > 0 && (
        <p data-testid="missing-required" className="text-sm text-destructive">
          Missing required tags: {missingRequired.join(', ')}
        </p>
      )}

      {/* Format limit warnings */}
      {atLimit && (
        <p data-testid="tag-limit-reached" className="text-sm text-muted-foreground">
          Maximum of {MAX_KEYS} tags reached
        </p>
      )}

      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="tag-add"
        disabled={atLimit}
        onClick={handleAdd}
      >
        Add tag
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function buildRows(
  value: Record<string, string>,
  policy?: TagPolicy | null,
): TagRow[] {
  const policyMap = new Map<string, string[] | undefined>();
  if (policy) {
    for (const rule of policy.requiredKeys) {
      policyMap.set(rule.key, rule.allowedValues ?? undefined);
    }
  }

  const rows: TagRow[] = [];
  const seen = new Set<string>();

  // Policy-required keys first (stable order from policy).
  if (policy) {
    for (const rule of policy.requiredKeys) {
      rows.push({
        key: rule.key,
        value: value[rule.key] ?? '',
        required: true,
        allowedValues: rule.allowedValues ?? undefined,
      });
      seen.add(rule.key);
    }
  }

  // User-defined keys.
  for (const [k, v] of Object.entries(value)) {
    if (seen.has(k)) continue;
    rows.push({
      key: k,
      value: v,
      required: false,
      allowedValues: policyMap.get(k) ?? undefined,
    });
  }

  return rows;
}
