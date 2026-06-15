/**
 * CounterfactualPanel
 *
 * Side panel docked right (~520px wide) that lets an admin operator
 * edit the fields of a baseline `DispatchRequest` and re-evaluate it
 * against the cached client-side `GovernanceEngine`. The result is
 * decomposed into a `DecisionTrace` via `decomposeFinding` and bubbled
 * up through `onCommit` so the parent page can render the alternative
 * pipeline canvas alongside the baseline.
 *
 * Layered safety gates:
 *   1. Admin-only — the parent Tracer page only renders the trigger
 *      button when `isAdmin === true`. The panel itself does not re-
 *      check because the engine is computed client-side and contains
 *      no production-affecting side effects.
 *   2. JSON validation — `context` and `agentInput` are textareas; the
 *      Re-evaluate button is disabled while either fails JSON.parse,
 *      and an inline error chip surfaces the parse failure verbatim.
 *
 * Field provenance: the baseline finding does not carry the original
 * dispatch's `actionType`, `domain`, `agentUseId`, `context`, or
 * `agentInput` — only the requesting/target agent IDs and workflow
 * ID survive in the ledger projection. The panel pre-fills the
 * inferable fields (requesting/target/workflow) and starts the rest
 * blank or with `{}` so the operator types in the counterfactual
 * scenario explicitly. `workflowId` and `agentUseId` are disabled to
 * keep the ID space stable across baseline ↔ alternative.
 *
 * Colour discipline: every visual state uses Tailwind tokens
 * (`text-destructive`, `text-muted-foreground`, etc.) so theme-mode
 * inversion stays correct. No literal hex.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from './ui/sheet';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';
import {
  GovernanceEngine,
  type DispatchRequest,
  type GovernanceFinding,
} from '@/lib/governance-engine';
import type { DecisionTrace } from '@/services/governanceService';
import { decomposeFinding } from '@/pages/governance/tracerDecompose';

export interface CounterfactualCommit {
  request: DispatchRequest;
  finding: GovernanceFinding;
  trace: DecisionTrace;
}

export interface CounterfactualPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Baseline finding to seed the form with. Field provenance: only
   * `requestingAgent`, `targetAgent`, and `workflowId` can be lifted
   * verbatim; the rest start empty / `{}` (see file header).
   */
  baselineFinding: {
    findingId: string;
    workflowId: string;
    requestingAgent: string;
    targetAgent: string;
  };
  /**
   * Engine instance built by `useGovernanceEngine`. The panel calls
   * `engine.evaluate(editedRequest)` synchronously on Re-evaluate.
   */
  engine: GovernanceEngine;
  /**
   * Bubbled when the operator commits a successful re-evaluation. The
   * parent Tracer page splits its canvas into baseline + alternative
   * and renders the diff banner per step.
   */
  onCommit: (commit: CounterfactualCommit) => void;
}

interface FormState {
  requestingAgentId: string;
  targetAgentId: string;
  actionType: string;
  domain: string;
  workflowId: string;
  agentUseId: string;
  contextJson: string;
  agentInputJson: string;
}

function initialFormState(
  baseline: CounterfactualPanelProps['baselineFinding'],
): FormState {
  return {
    requestingAgentId: baseline.requestingAgent,
    targetAgentId: baseline.targetAgent,
    actionType: '',
    domain: '',
    workflowId: baseline.workflowId,
    agentUseId: '',
    contextJson: '{}',
    agentInputJson: '{}',
  };
}

interface ParseResult {
  context?: Record<string, unknown>;
  agentInput?: Record<string, unknown>;
  contextError: string | null;
  agentInputError: string | null;
}

function parseJsonField(
  raw: string,
): { parsed: Record<string, unknown> | null; error: string | null } {
  if (raw.trim().length === 0) {
    return { parsed: {}, error: null };
  }
  try {
    const value = JSON.parse(raw);
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      return {
        parsed: null,
        error: 'Value must be a JSON object (got null, array, or primitive).',
      };
    }
    return { parsed: value as Record<string, unknown>, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Invalid JSON';
    return { parsed: null, error: msg };
  }
}

function parseFormJsonFields(form: FormState): ParseResult {
  const ctx = parseJsonField(form.contextJson);
  const inp = parseJsonField(form.agentInputJson);
  return {
    context: ctx.parsed ?? undefined,
    agentInput: inp.parsed ?? undefined,
    contextError: ctx.error,
    agentInputError: inp.error,
  };
}

export function CounterfactualPanel({
  open,
  onOpenChange,
  baselineFinding,
  engine,
  onCommit,
}: CounterfactualPanelProps) {
  const [form, setForm] = useState<FormState>(() =>
    initialFormState(baselineFinding),
  );
  const [submitError, setSubmitError] = useState<string | null>(null);

  // When the baseline finding changes (operator pivoted to a different
  // finding then reopened the panel), reset the form so the new
  // baseline values are reflected.
  useEffect(() => {
    if (!open) return;
    setForm(initialFormState(baselineFinding));
    setSubmitError(null);
  }, [
    open,
    baselineFinding.findingId,
    baselineFinding.requestingAgent,
    baselineFinding.targetAgent,
    baselineFinding.workflowId,
  ]);

  const parseResult = useMemo(() => parseFormJsonFields(form), [form]);

  const reEvaluateDisabled =
    parseResult.contextError !== null ||
    parseResult.agentInputError !== null ||
    form.requestingAgentId.trim().length === 0 ||
    form.targetAgentId.trim().length === 0;

  const updateField = <K extends keyof FormState>(
    key: K,
    value: FormState[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (submitError) setSubmitError(null);
  };

  const handleReEvaluate = () => {
    if (reEvaluateDisabled) return;
    if (!parseResult.context || !parseResult.agentInput) return;

    const editedRequest: DispatchRequest = {
      requestingAgentId: form.requestingAgentId.trim(),
      targetAgentId: form.targetAgentId.trim(),
      actionType: form.actionType.trim(),
      domain: form.domain.trim(),
      workflowId: form.workflowId,
      agentUseId: form.agentUseId,
      context: parseResult.context,
      agentInput: parseResult.agentInput,
    };

    let finding: GovernanceFinding;
    try {
      finding = engine.evaluate(editedRequest);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Engine evaluation failed';
      setSubmitError(msg);
      return;
    }

    let trace: DecisionTrace;
    try {
      trace = decomposeFinding(finding);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : 'Failed to decompose alternative finding';
      setSubmitError(msg);
      return;
    }

    onCommit({ request: editedRequest, finding, trace });
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[520px] sm:max-w-[520px] flex flex-col"
        data-testid="counterfactual-panel"
      >
        <SheetHeader>
          <SheetTitle data-testid="counterfactual-panel-title">
            Counterfactual: edit and re-evaluate
          </SheetTitle>
          <SheetDescription>
            Edit the dispatch request and re-evaluate against the current
            governance state. The result renders alongside the baseline
            with a diff banner per step.
          </SheetDescription>
        </SheetHeader>

        <div
          className="flex-1 overflow-y-auto px-4 py-2 flex flex-col gap-4"
          data-testid="counterfactual-panel-body"
        >
          <div className="flex flex-col gap-1">
            <Label
              htmlFor="counterfactual-requesting-agent"
              className="text-xs text-muted-foreground"
            >
              Requesting agent ID
            </Label>
            <Input
              id="counterfactual-requesting-agent"
              data-testid="counterfactual-requesting-agent"
              className="font-mono"
              value={form.requestingAgentId}
              onChange={(e) => updateField('requestingAgentId', e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label
              htmlFor="counterfactual-target-agent"
              className="text-xs text-muted-foreground"
            >
              Target agent ID
            </Label>
            <Input
              id="counterfactual-target-agent"
              data-testid="counterfactual-target-agent"
              className="font-mono"
              value={form.targetAgentId}
              onChange={(e) => updateField('targetAgentId', e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label
              htmlFor="counterfactual-action-type"
              className="text-xs text-muted-foreground"
            >
              Action type
            </Label>
            <Input
              id="counterfactual-action-type"
              data-testid="counterfactual-action-type"
              value={form.actionType}
              onChange={(e) => updateField('actionType', e.target.value)}
              placeholder="invoke_agent"
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label
              htmlFor="counterfactual-domain"
              className="text-xs text-muted-foreground"
            >
              Domain
            </Label>
            <Input
              id="counterfactual-domain"
              data-testid="counterfactual-domain"
              value={form.domain}
              onChange={(e) => updateField('domain', e.target.value)}
              placeholder="payment"
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label
              htmlFor="counterfactual-workflow-id"
              className="text-xs text-muted-foreground"
            >
              Workflow ID (locked)
            </Label>
            <Input
              id="counterfactual-workflow-id"
              data-testid="counterfactual-workflow-id"
              value={form.workflowId}
              disabled
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label
              htmlFor="counterfactual-agent-use-id"
              className="text-xs text-muted-foreground"
            >
              Agent use ID (locked)
            </Label>
            <Input
              id="counterfactual-agent-use-id"
              data-testid="counterfactual-agent-use-id"
              value={form.agentUseId}
              disabled
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label
              htmlFor="counterfactual-context"
              className="text-xs text-muted-foreground"
            >
              Context (JSON)
            </Label>
            <Textarea
              id="counterfactual-context"
              data-testid="counterfactual-context"
              value={form.contextJson}
              onChange={(e) => updateField('contextJson', e.target.value)}
              rows={5}
              className="font-mono text-xs"
              aria-invalid={parseResult.contextError !== null}
            />
            {parseResult.contextError !== null && (
              <p
                className="text-destructive text-xs"
                role="alert"
                data-testid="counterfactual-context-error"
              >
                Context JSON: {parseResult.contextError}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <Label
              htmlFor="counterfactual-agent-input"
              className="text-xs text-muted-foreground"
            >
              Agent input (JSON)
            </Label>
            <Textarea
              id="counterfactual-agent-input"
              data-testid="counterfactual-agent-input"
              value={form.agentInputJson}
              onChange={(e) => updateField('agentInputJson', e.target.value)}
              rows={5}
              className="font-mono text-xs"
              aria-invalid={parseResult.agentInputError !== null}
            />
            {parseResult.agentInputError !== null && (
              <p
                className="text-destructive text-xs"
                role="alert"
                data-testid="counterfactual-agent-input-error"
              >
                Agent input JSON: {parseResult.agentInputError}
              </p>
            )}
          </div>

          {submitError !== null && (
            <p
              className="text-destructive text-xs"
              role="alert"
              data-testid="counterfactual-submit-error"
            >
              {submitError}
            </p>
          )}
        </div>

        <div className="border-t border-border p-4 flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            data-testid="counterfactual-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={handleReEvaluate}
            disabled={reEvaluateDisabled}
            data-testid="counterfactual-reevaluate"
          >
            Re-evaluate
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default CounterfactualPanel;
