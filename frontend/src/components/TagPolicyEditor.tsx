/**
 * TagPolicyEditor — admin-only editor for an organisation's tag policy.
 *
 * Lists required keys (each with optional allowed values), supports add/remove,
 * and enforces client-side shape limits:
 *   • max 10 keys
 *   • key max 64 chars
 *   • allowed-values string max 256 chars
 *   • no duplicate keys
 *
 * Save calls `updateTagPolicy`; load via `getTagPolicy` (null → empty-state
 * message). After save, displays the stored version/updatedBy/updatedAt.
 */
import { useState, useEffect, useCallback } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Badge } from './ui/badge';
import { Plus, Trash2 } from 'lucide-react';
import { tagPolicyService, TagPolicy, TagPolicyRule } from '../services/tagPolicyService';

const MAX_KEYS = 10;
const MAX_KEY_LENGTH = 64;
const MAX_VALUES_LENGTH = 256;

export interface TagPolicyEditorProps {
  orgId: string;
  isAdmin: boolean;
}

interface RuleRow {
  key: string;
  allowedValues: string; // comma-separated
}

function rulesToRows(rules: TagPolicyRule[]): RuleRow[] {
  return rules.map((r) => ({
    key: r.key,
    allowedValues: r.allowedValues?.join(', ') ?? '',
  }));
}

function rowsToRules(rows: RuleRow[]): TagPolicyRule[] {
  return rows
    .filter((r) => r.key.trim() !== '')
    .map((r) => ({
      key: r.key.trim(),
      allowedValues:
        r.allowedValues.trim() === ''
          ? undefined
          : r.allowedValues
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean),
    }));
}

export function TagPolicyEditor({ orgId, isAdmin }: TagPolicyEditorProps) {
  const [rows, setRows] = useState<RuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [policy, setPolicy] = useState<TagPolicy | null>(null);
  const [duplicateKey, setDuplicateKey] = useState<string | null>(null);

  const loadPolicy = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await tagPolicyService.getTagPolicy(orgId);
      setPolicy(result);
      setRows(result ? rulesToRows(result.requiredKeys) : []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load tag policy';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    if (isAdmin) {
      loadPolicy();
    }
  }, [isAdmin, loadPolicy]);

  if (!isAdmin) return null;

  if (loading) return <p className="text-muted-foreground text-sm">Loading tag policy…</p>;

  const handleAddRow = () => {
    if (rows.length >= MAX_KEYS) return;
    setRows([...rows, { key: '', allowedValues: '' }]);
  };

  const handleRemoveRow = (index: number) => {
    setRows(rows.filter((_, i) => i !== index));
    setDuplicateKey(null);
  };

  const handleKeyChange = (index: number, value: string) => {
    if (value.length > MAX_KEY_LENGTH) return;
    const updated = [...rows];
    updated[index] = { ...updated[index], key: value };
    setRows(updated);
    setDuplicateKey(null);
  };

  const handleValuesChange = (index: number, value: string) => {
    if (value.length > MAX_VALUES_LENGTH) return;
    const updated = [...rows];
    updated[index] = { ...updated[index], allowedValues: value };
    setRows(updated);
  };

  const hasDuplicateKeys = (): string | null => {
    const seen = new Set<string>();
    for (const row of rows) {
      const k = row.key.trim().toLowerCase();
      if (k === '') continue;
      if (seen.has(k)) return row.key.trim();
      seen.add(k);
    }
    return null;
  };

  const handleSave = async () => {
    const dup = hasDuplicateKeys();
    if (dup) {
      setDuplicateKey(dup);
      setError(`Duplicate key: "${dup}"`);
      return;
    }
    try {
      setSaving(true);
      setError(null);
      setDuplicateKey(null);
      const result = await tagPolicyService.updateTagPolicy({
        orgId,
        requiredKeys: rowsToRules(rows),
        expectedVersion: policy?.version,
      });
      setPolicy(result);
      setRows(rulesToRows(result.requiredKeys));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save tag policy';
      setError(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 mt-3" data-testid="tag-policy-editor">
      <div className="flex items-center justify-between">
        <Label className="text-foreground font-medium text-sm">Tag Policy</Label>
        {rows.length < MAX_KEYS && (
          <Button size="sm" variant="outline" onClick={handleAddRow} data-testid="add-rule-btn">
            <Plus className="size-3 mr-1" />
            Add Rule
          </Button>
        )}
      </div>

      <p className="text-muted-foreground text-xs">
        Policy violations are refused when enforcement is <strong>strict</strong> and logged in <strong>shadow</strong> mode.
      </p>

      {!policy && rows.length === 0 && (
        <p className="text-muted-foreground text-sm" data-testid="empty-policy-msg">
          No tag policy. Records in this organisation need no tags.
        </p>
      )}

      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2" data-testid={`rule-row-${i}`}>
          <Input
            placeholder="Key"
            value={row.key}
            onChange={(e) => handleKeyChange(i, e.target.value)}
            className="flex-1 bg-card border-border text-foreground text-sm"
            maxLength={MAX_KEY_LENGTH}
            aria-label={`Rule key ${i}`}
          />
          <Input
            placeholder="Allowed values (comma-separated)"
            value={row.allowedValues}
            onChange={(e) => handleValuesChange(i, e.target.value)}
            className="flex-2 bg-card border-border text-foreground text-sm"
            maxLength={MAX_VALUES_LENGTH}
            aria-label={`Rule values ${i}`}
          />
          <Button
            size="sm"
            variant="outline"
            className="border-destructive/50 text-destructive hover:bg-destructive/10"
            onClick={() => handleRemoveRow(i)}
            aria-label={`Remove rule ${i}`}
          >
            <Trash2 className="size-3" />
          </Button>
        </div>
      ))}

      {error && (
        <p className="text-destructive text-xs" data-testid="policy-error">
          {error}
        </p>
      )}

      {duplicateKey && (
        <p className="text-destructive text-xs" data-testid="duplicate-key-error">
          Duplicate key: &quot;{duplicateKey}&quot;
        </p>
      )}

      {(rows.length > 0 || policy) && (
        <Button size="sm" onClick={handleSave} disabled={saving} data-testid="save-policy-btn">
          {saving ? 'Saving…' : 'Save Tag Policy'}
        </Button>
      )}

      {policy && (
        <div className="flex items-center gap-2 flex-wrap" data-testid="policy-meta">
          <Badge variant="secondary">v{policy.version}</Badge>
          <span className="text-muted-foreground text-xs">
            Updated by {policy.updatedBy} at {new Date(policy.updatedAt).toLocaleString()}
          </span>
        </div>
      )}
    </div>
  );
}
