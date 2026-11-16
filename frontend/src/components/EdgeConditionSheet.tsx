/**
 * EdgeConditionSheet Component
 *
 * Right-side Sheet for editing an edge's conditional branching expression.
 * Embeds ConditionEditorPanel with local draft state; Apply writes the
 * condition + visual styling, Remove clears everything.
 *
 * CIT-291
 */

import { useState, useEffect, useCallback, memo } from 'react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from './ui/sheet';
import { Button } from './ui/button';
import { ConditionEditorPanel } from './ConditionEditorPanel';
import { isConditionValid } from '../utils/conditionValidation';
import type { WorkflowEdge, WorkflowNode, EdgeCondition } from '../types/workflow';

export interface EdgeConditionSheetProps {
  edge: WorkflowEdge | null;
  nodes: WorkflowNode[];
  isOpen: boolean;
  onClose: () => void;
  onApply: (condition: EdgeCondition) => void;
  onRemove: () => void;
}

const DEFAULT_CONDITION: EdgeCondition = {
  field: '',
  operator: 'equals',
  value: '',
};

/**
 * Coerce the value for greaterThan/lessThan operators: if the string parses
 * as a finite number, store the number; otherwise keep the string.
 * For all other operators, pass the raw draft value through.
 */
function coerceValue(draft: EdgeCondition): EdgeCondition {
  if (draft.operator === 'greaterThan' || draft.operator === 'lessThan') {
    const str = String(draft.value);
    const num = Number(str);
    if (str !== '' && isFinite(num)) {
      return { ...draft, value: num };
    }
  }
  return draft;
}

export const EdgeConditionSheet = memo(function EdgeConditionSheet({
  edge,
  nodes,
  isOpen,
  onClose,
  onApply,
  onRemove,
}: EdgeConditionSheetProps) {
  const [draft, setDraft] = useState<EdgeCondition>(DEFAULT_CONDITION);
  const [editing, setEditing] = useState(false);

  // When the sheet opens or edge changes, sync local draft
  useEffect(() => {
    if (edge) {
      const existing = edge.data?.condition;
      if (existing) {
        setDraft({ ...existing, value: existing.value ?? '' });
        setEditing(true);
      } else {
        setDraft(DEFAULT_CONDITION);
        setEditing(false);
      }
    }
  }, [edge]);

  const sourceLabel =
    nodes.find((n) => n.id === edge?.source)?.data.label ?? edge?.source ?? '';
  const targetLabel =
    nodes.find((n) => n.id === edge?.target)?.data.label ?? edge?.target ?? '';

  const handleApply = useCallback(() => {
    onApply(coerceValue(draft));
  }, [draft, onApply]);

  const handleRemove = useCallback(() => {
    onRemove();
  }, [onRemove]);

  const handleAdd = useCallback(() => {
    setDraft(DEFAULT_CONDITION);
    setEditing(true);
  }, []);

  const valid = isConditionValid(draft);

  if (!edge) return null;

  return (
    <Sheet open={isOpen} onOpenChange={(open: boolean) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-md overflow-y-auto"
        aria-label="Edge condition editor"
      >
        <SheetHeader>
          <SheetTitle>Edge Condition</SheetTitle>
          <SheetDescription>
            {sourceLabel} → {targetLabel}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col py-6 gap-4 px-4">
          {editing ? (
            <ConditionEditorPanel
              condition={draft}
              onChange={setDraft}
              edgePreview
            />
          ) : (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <p className="text-sm text-muted-foreground">
                No condition: this edge always fires
              </p>
              <Button variant="outline" onClick={handleAdd} aria-label="Add condition">
                Add Condition
              </Button>
            </div>
          )}
        </div>

        {editing && (
          <SheetFooter className="gap-2">
            {edge.data?.condition && (
              <Button
                variant="destructive"
                onClick={handleRemove}
                aria-label="Remove condition"
              >
                Remove Condition
              </Button>
            )}
            <Button
              onClick={handleApply}
              disabled={!valid}
              aria-label="Apply condition"
            >
              Apply
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
});
