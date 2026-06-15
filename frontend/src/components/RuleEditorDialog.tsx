/**
 * RuleEditorDialog
 *
 * Inline constitutional rule editor for the governance Constitution
 * page. Wires three admin-only mutations:
 *
 *   - add    → append a new rule to a layer
 *   - update → replace an existing rule at a specific index
 *   - delete → remove a rule at a specific index (typed-match DELETE)
 *
 * Layered safety gates:
 *   1. Admin-only (parent page already checks; the resolver enforces).
 *   2. Acknowledgement checkbox using the verbatim shared constant.
 *   3. JSON-validity check on the value field (client-side; resolver
 *      re-parses the value before storing).
 *   4. For delete: typed-match `DELETE` confirmation.
 *
 * Colour discipline: every status colour comes from Tailwind tokens
 * (`text-destructive`, `text-muted-foreground`, etc.) so theme-mode
 * inversion stays correct. No hex literals.
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Checkbox } from './ui/checkbox';
import { Label } from './ui/label';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import {
  governanceService,
  CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT,
  ConstitutionalLayer,
  ConstitutionalOperator,
  ConstitutionalRule,
  ConstitutionalRuleInput,
  ConstitutionalRuleMutationResult,
} from '../services/governanceService';

export type RuleEditorMode = 'add' | 'update' | 'delete';

export interface RuleEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: RuleEditorMode;
  layer: ConstitutionalLayer;
  /** Required for update / delete; ignored for add. */
  ruleIndex?: number;
  /** Pre-fill source for update mode. */
  existingRule?: ConstitutionalRule;
  onCommitted: (result: ConstitutionalRuleMutationResult) => void;
}

const OPERATOR_OPTIONS: ReadonlyArray<{
  value: ConstitutionalOperator;
  label: string;
}> = [
  { value: 'eq', label: 'eq (equals)' },
  { value: 'neq', label: 'neq (not equal)' },
  { value: 'exists', label: 'exists' },
  { value: 'not_exists', label: 'not_exists' },
  { value: 'gt', label: 'gt (greater than)' },
  { value: 'lt', label: 'lt (less than)' },
];

const FIELD_MAX_LENGTH = 256;
const TYPED_DELETE_TOKEN = 'DELETE';

function isExistsOperator(op: string): boolean {
  return op === 'exists' || op === 'not_exists';
}

function isJsonParseable(text: string): boolean {
  if (text.length === 0) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function RuleEditorDialog({
  open,
  onOpenChange,
  mode,
  layer,
  ruleIndex,
  existingRule,
  onCommitted,
}: RuleEditorDialogProps) {
  const isDeleteMode = mode === 'delete';
  const isUpdateMode = mode === 'update';

  // Pre-fill from existingRule for update; reset for add. Delete mode
  // never edits these — the dialog only renders the read-only summary.
  const initialField = isUpdateMode ? existingRule?.field ?? '' : '';
  const initialOperator: ConstitutionalOperator = isUpdateMode
    ? (existingRule?.operator as ConstitutionalOperator) ?? 'eq'
    : 'eq';
  const initialValue =
    isUpdateMode && existingRule?.value !== null
      ? existingRule?.value ?? ''
      : '';

  const [field, setField] = useState(initialField);
  const [operator, setOperator] =
    useState<ConstitutionalOperator>(initialOperator);
  const [valueText, setValueText] = useState(initialValue);
  const [acknowledged, setAcknowledged] = useState(false);
  const [typedMatch, setTypedMatch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset every gate when the dialog opens. We never want a stale typed
  // value or acknowledgement carried across separate edits — this also
  // re-runs the pre-fill when `existingRule` changes between renders.
  useEffect(() => {
    if (!open) return;
    setField(isUpdateMode ? existingRule?.field ?? '' : '');
    setOperator(
      isUpdateMode
        ? ((existingRule?.operator as ConstitutionalOperator) ?? 'eq')
        : 'eq',
    );
    setValueText(
      isUpdateMode && existingRule?.value !== null
        ? existingRule?.value ?? ''
        : '',
    );
    setAcknowledged(false);
    setTypedMatch('');
    setSubmitError(null);
    setSubmitting(false);
  }, [open, mode, existingRule, isUpdateMode]);

  const valueRequired = !isExistsOperator(operator);
  const valueOk = !valueRequired || isJsonParseable(valueText);
  const fieldOk =
    field.length > 0 && field.length <= FIELD_MAX_LENGTH;

  const editGatesOk = fieldOk && valueOk && acknowledged;
  const deleteGatesOk = typedMatch === TYPED_DELETE_TOKEN && acknowledged;
  const allGatesOk = isDeleteMode ? deleteGatesOk : editGatesOk;
  const confirmDisabled = !allGatesOk || submitting;

  const title = useMemo(() => {
    if (mode === 'add') return `Add rule to ${layer.layerId}`;
    if (mode === 'update') {
      return `Update rule ${ruleIndex ?? '?'} in ${layer.layerId}`;
    }
    return `Delete rule ${ruleIndex ?? '?'} from ${layer.layerId}`;
  }, [mode, layer.layerId, ruleIndex]);

  const description = useMemo(() => {
    if (mode === 'delete') {
      return 'This rule is evaluated at engine step 8. Deleting it removes a constitutional invariant — confirm carefully.';
    }
    return 'This rule is evaluated at engine step 8. The value field accepts JSON-encoded primitives (e.g. true, 42, "gold").';
  }, [mode]);

  const buildInput = (): ConstitutionalRuleInput => ({
    field,
    operator,
    value: valueRequired ? valueText : null,
  });

  const handleConfirm = async () => {
    if (confirmDisabled) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      let result: ConstitutionalRuleMutationResult;
      if (mode === 'add') {
        result = await governanceService.addConstitutionalRule(
          layer.layerId,
          buildInput(),
        );
      } else if (mode === 'update') {
        if (typeof ruleIndex !== 'number') {
          throw new Error('ruleIndex is required for update mode');
        }
        result = await governanceService.updateConstitutionalRule(
          layer.layerId,
          ruleIndex,
          buildInput(),
        );
      } else {
        if (typeof ruleIndex !== 'number') {
          throw new Error('ruleIndex is required for delete mode');
        }
        result = await governanceService.deleteConstitutionalRule(
          layer.layerId,
          ruleIndex,
        );
      }
      onCommitted(result);
      onOpenChange(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Rule edit failed';
      setSubmitError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    if (submitting) return;
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="rule-editor-dialog"
        data-mode={mode}
        data-layer-id={layer.layerId}
      >
        <DialogHeader>
          <DialogTitle data-testid="rule-editor-title">{title}</DialogTitle>
          <DialogDescription data-testid="rule-editor-description">
            {description}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          {isDeleteMode && existingRule && (
            <Card
              className="rounded-md p-3 text-xs gap-0"
              data-testid="rule-editor-delete-summary"
            >
              <p className="text-muted-foreground mb-1">Rule being deleted</p>
              <p className="font-mono text-foreground">
                <span data-testid="rule-editor-delete-field">
                  {existingRule.field}
                </span>{' '}
                <span data-testid="rule-editor-delete-operator">
                  {existingRule.operator}
                </span>
                {existingRule.value !== null && (
                  <>
                    {' '}
                    <span
                      className="text-muted-foreground"
                      data-testid="rule-editor-delete-value"
                    >
                      {existingRule.value}
                    </span>
                  </>
                )}
              </p>
            </Card>
          )}

          {!isDeleteMode && (
            <>
              <div className="flex flex-col gap-1">
                <Label
                  htmlFor="rule-editor-field"
                  className="text-xs text-muted-foreground"
                >
                  Field (max {FIELD_MAX_LENGTH} chars)
                </Label>
                <Input
                  id="rule-editor-field"
                  value={field}
                  onChange={(e) =>
                    setField(e.target.value.slice(0, FIELD_MAX_LENGTH))
                  }
                  placeholder="e.g. pii_present"
                  className="font-mono"
                  aria-label="Rule field"
                  data-testid="rule-editor-field-input"
                  disabled={submitting}
                  maxLength={FIELD_MAX_LENGTH}
                  autoComplete="off"
                />
              </div>

              <div className="flex flex-col gap-1">
                <Label
                  htmlFor="rule-editor-operator"
                  className="text-xs text-muted-foreground"
                >
                  Operator
                </Label>
                <Select
                  value={operator}
                  onValueChange={(v) =>
                    setOperator(v as ConstitutionalOperator)
                  }
                  disabled={submitting}
                >
                  <SelectTrigger
                    id="rule-editor-operator"
                    data-testid="rule-editor-operator-trigger"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OPERATOR_OPTIONS.map((opt) => (
                      <SelectItem
                        key={opt.value}
                        value={opt.value}
                        data-testid={`rule-editor-operator-option-${opt.value}`}
                      >
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {valueRequired && (
                <div className="flex flex-col gap-1">
                  <Label
                    htmlFor="rule-editor-value"
                    className="text-xs text-muted-foreground"
                  >
                    Value (JSON-encoded)
                  </Label>
                  <Input
                    id="rule-editor-value"
                    value={valueText}
                    onChange={(e) => setValueText(e.target.value)}
                    placeholder='e.g. true, 42, "gold"'
                    className="font-mono"
                    aria-label="Rule value"
                    data-testid="rule-editor-value-input"
                    disabled={submitting}
                    autoComplete="off"
                  />
                  {valueText.length > 0 && !valueOk && (
                    <p
                      className="text-destructive text-xs"
                      data-testid="rule-editor-value-error"
                    >
                      Value must be valid JSON (true / 42 / &quot;text&quot;).
                    </p>
                  )}
                </div>
              )}
            </>
          )}

          {isDeleteMode && (
            <div className="flex flex-col gap-1">
              <Label
                htmlFor="rule-editor-typed-match"
                className="text-xs text-muted-foreground"
              >
                Type &quot;DELETE&quot; to confirm
              </Label>
              <Input
                id="rule-editor-typed-match"
                value={typedMatch}
                onChange={(e) => setTypedMatch(e.target.value)}
                placeholder='Type "DELETE" to confirm'
                className="font-mono"
                aria-label="Typed delete confirmation"
                data-testid="rule-editor-typed-match-input"
                disabled={submitting}
                autoComplete="off"
              />
            </div>
          )}

          <div className="flex items-start gap-2">
            <Checkbox
              id="rule-editor-ack-checkbox"
              checked={acknowledged}
              onCheckedChange={(v) => setAcknowledged(v === true)}
              data-testid="rule-editor-ack-checkbox"
              disabled={submitting}
            />
            <Label
              htmlFor="rule-editor-ack-checkbox"
              className="text-sm text-foreground leading-snug"
              data-testid="rule-editor-ack-label"
            >
              {CONSTITUTIONAL_RULE_ACKNOWLEDGEMENT_TEXT}
            </Label>
          </div>

          {submitError && (
            <Alert variant="destructive" data-testid="rule-editor-error">
              <AlertTitle>Rule edit failed</AlertTitle>
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={submitting}
            data-testid="rule-editor-cancel"
          >
            Cancel
          </Button>
          <Button
            variant={isDeleteMode ? 'destructive' : 'default'}
            onClick={handleConfirm}
            disabled={confirmDisabled}
            data-testid="rule-editor-confirm"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {isDeleteMode ? 'Deleting…' : 'Saving…'}
              </>
            ) : (
              <>{isDeleteMode ? 'Delete rule' : 'Save rule'}</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default RuleEditorDialog;
