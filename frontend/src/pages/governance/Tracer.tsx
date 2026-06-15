/**
 * Governance Decision Flow Tracer
 *
 * Static visualisation of the engine's 8-step pipeline for any single
 * governance finding. Reads ?findingId=<id> from the URL or accepts a
 * pasted ID. No live tail in this wave (ships subscriptions).
 *
 * The pipeline canvas uses @xyflow/react (the first new npm dependency in
 * the governance UI). Pan/zoom is intentionally disabled — operators
 * compare nodes side-by-side, not navigate a graph.
 *
 * Reason-string parsing on the frontend is decorative only — the backend
 * resolver is the source of truth for arbitrationPattern / scopeReduction
 * / terminalStepNumber. Reason tokens render as monospaced badges
 * mirroring Ledger.tsx (intentionally duplicated here, not imported, to
 * avoid coupling the two pages — Ledger.tsx is the contract source).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  ReactFlow,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Clipboard, ExternalLink, Pencil, Pin, PinOff, Radio } from 'lucide-react';
import { PageContainer } from '../../components/PageContainer';
import { GovernanceBreadcrumbs } from '../../components/governance/GovernanceBreadcrumbs';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import { Skeleton } from '../../components/ui/skeleton';
import { Switch } from '../../components/ui/switch';
import { Slider } from '../../components/ui/slider';
import { Card } from '../../components/ui/card';
import {
  governanceService,
  DecisionTrace,
  DecisionTraceStep,
  GovernanceFinding,
} from '../../services/governanceService';
import { useGovernanceFindingStream } from '../../hooks/useGovernanceFindingStream';
import { useGovernanceEngine } from '../../hooks/useGovernanceEngine';
import { useOrganization } from '../../contexts/OrganizationContext';
import {
  CounterfactualPanel,
  type CounterfactualCommit,
} from '../../components/CounterfactualPanel';
import { detectConcurrencyGroup, type ConcurrencyGroup } from './tracerUtils';

// ---------------------------------------------------------------------------
// Token / status helpers (reused from Ledger.tsx in spirit, duplicated here
// to keep the two pages decoupled — see the file-level comment).
// ---------------------------------------------------------------------------

function ReasonTokens({ tokens }: { tokens: string[] }) {
  if (tokens.length === 0) {
    return (
      <span className="text-muted-foreground text-xs" data-testid="tracer-reason-empty">
        no reason tokens
      </span>
    );
  }
  return (
    <div
      className="flex flex-wrap items-center gap-1"
      data-testid="tracer-reason-tokens"
    >
      {tokens.map((token, i) => (
        // TODO(wave-3-tail): token-click filtering (filter ledger to this
        // token) lands. is read-only.
        <span
          key={`${i}-${token}`}
          className="font-mono text-xs px-1.5 py-0.5 rounded bg-muted text-foreground"
          data-testid={`tracer-reason-token-${i}`}
        >
          {token}
        </span>
      ))}
    </div>
  );
}

function decisionVariant(
  decision: string,
): 'success' | 'destructive' | 'warning' | 'secondary' {
  switch (decision) {
    case 'permit':
      return 'success';
    case 'deny':
      return 'destructive';
    case 'escalate':
      return 'warning';
    default:
      return 'secondary';
  }
}

// ---------------------------------------------------------------------------
// Node renderer
// ---------------------------------------------------------------------------

interface PipelineNodeData extends Record<string, unknown> {
  step: DecisionTraceStep;
  selected: boolean;
  ghosted: boolean;
  constitutionalLayer: string | null;
}

function pipelineStepBackground(status: string): string {
  // Map node status → tailwind utility classes. No literal hex colours.
  switch (status) {
    case 'matched':
      return 'bg-chart-4/20';
    case 'permitted':
      return 'bg-chart-2/25';
    case 'denied':
      return 'bg-destructive/15';
    case 'escalated':
      return 'bg-amber-500/15';
    case 'overridden':
      return 'bg-destructive/20';
    case 'pass-through':
      return 'bg-muted/60';
    case 'skipped':
      return 'bg-muted/30';
    default:
      return 'bg-muted/40';
  }
}

function pipelineStepBorder(status: string): string {
  switch (status) {
    case 'matched':
    case 'permitted':
      return 'border-chart-2/50 border-solid';
    case 'denied':
      return 'border-destructive/60 border-solid';
    case 'escalated':
      return 'border-amber-500/60 border-solid';
    case 'overridden':
      return 'border-destructive border-2 shadow-[0_0_12px_var(--color-destructive)]';
    case 'pass-through':
      return 'border-border border-dashed';
    case 'skipped':
      return 'border-border/40 border-dashed';
    default:
      return 'border-border';
  }
}

function statusBadgeVariant(
  status: string,
): 'success' | 'destructive' | 'warning' | 'secondary' | 'outline' {
  switch (status) {
    case 'matched':
    case 'permitted':
      return 'success';
    case 'denied':
    case 'overridden':
      return 'destructive';
    case 'escalated':
      return 'warning';
    case 'pass-through':
      return 'secondary';
    case 'skipped':
      return 'outline';
    default:
      return 'secondary';
  }
}

function PipelineStepNode({ data }: NodeProps<Node<PipelineNodeData>>) {
  const { step, selected, ghosted, constitutionalLayer } = data;
  const bg = pipelineStepBackground(step.status);
  const border = pipelineStepBorder(step.status);
  const opacity = ghosted ? 'opacity-40' : '';
  const ring = selected ? 'ring-2 ring-primary' : '';

  return (
    <div
      className={`rounded-lg border p-3 w-[200px] ${bg} ${border} ${opacity} ${ring}`}
      data-testid={`tracer-step-node-${step.stepNumber}`}
      data-step-status={step.status}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <div className="flex items-center gap-2 mb-2">
        <span
          className="size-6 rounded-full bg-background flex items-center justify-center text-xs font-semibold border border-border"
          data-testid={`tracer-step-num-${step.stepNumber}`}
        >
          {step.stepNumber}
        </span>
        <Badge
          variant={statusBadgeVariant(step.status)}
          className="text-[10px] capitalize"
        >
          {step.status}
        </Badge>
      </div>
      <p className="text-xs font-semibold text-foreground leading-tight mb-1">
        {step.name}
      </p>
      <p className="text-[10px] text-muted-foreground leading-snug line-clamp-2">
        {step.detail}
      </p>
      {step.status === 'overridden' && constitutionalLayer && (
        <p
          className="text-[10px] text-destructive font-mono mt-1 truncate"
          data-testid={`tracer-step-${step.stepNumber}-override-layer`}
        >
          {constitutionalLayer}
        </p>
      )}
      <Handle type="source" position={Position.Right} className="!opacity-0" />
    </div>
  );
}

const nodeTypes = { pipelineStepNode: PipelineStepNode };

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

const HORIZONTAL_GAP = 220; // 200px node + 20px gap
const MAIN_ROW_Y = 80;
const STEP2_GHOST_Y = -60;

function buildNodesAndEdges(trace: DecisionTrace): {
  nodes: Node<PipelineNodeData>[];
  edges: Edge[];
} {
  // Step 1..8 columns. Step 2 renders as a ghost above the main row;
  // edges run 1 → 3 → 4 → 5 → 6 → 7 → 8 with a dashed bypass marker.
  const layoutOrder = [1, 3, 4, 5, 6, 7, 8];
  const x = (idx: number) => idx * HORIZONTAL_GAP;

  const stepById = new Map<number, DecisionTraceStep>();
  for (const s of trace.steps) stepById.set(s.stepNumber, s);

  // Constitutional layer name (parsed from reasonTokens) — only when
  // step 8 is overridden. Used in the node subtitle and the side panel.
  const constitutionalLayer =
    trace.constitutionalOverride && trace.reasonTokens.length > 1
      ? trace.reasonTokens[1]
      : null;

  const nodes: Node<PipelineNodeData>[] = [];

  // Main row: step 1 then 3..8.
  layoutOrder.forEach((stepNumber, idx) => {
    const step = stepById.get(stepNumber);
    if (!step) return;
    nodes.push({
      id: `step-${stepNumber}`,
      type: 'pipelineStepNode',
      position: { x: x(idx), y: MAIN_ROW_Y },
      data: {
        step,
        selected: false,
        ghosted: false,
        constitutionalLayer,
      },
      // ReactFlow renders the node renderer; selectability stays default
      // (so click → node selection events fire), but we disable drag to
      // keep the layout static (no pan/zoom either, see ReactFlow props).
      draggable: false,
      selectable: true,
    });
  });

  // Ghost step 2 above the main row, between step 1 and step 3.
  const step2 = stepById.get(2);
  if (step2) {
    nodes.push({
      id: 'step-2',
      type: 'pipelineStepNode',
      position: { x: x(0) + HORIZONTAL_GAP / 2, y: STEP2_GHOST_Y },
      data: {
        step: step2,
        selected: false,
        ghosted: true,
        constitutionalLayer: null,
      },
      draggable: false,
      selectable: true,
    });
  }

  const edges: Edge[] = [];
  // Main row edges 1→3→4→5→6→7→8.
  for (let i = 0; i < layoutOrder.length - 1; i++) {
    const a = layoutOrder[i];
    const b = layoutOrder[i + 1];
    const isOverrideEdge =
      a === 7 && b === 8 && trace.constitutionalOverride;
    edges.push({
      id: `e-${a}-${b}`,
      source: `step-${a}`,
      target: `step-${b}`,
      // Inline style is required by ReactFlow's edge API; we use Tailwind
      // CSS variables (defined in the project's theme) so the colour stays
      // tokenised. Per the design rules, no literal colour values.
      style: {
        strokeWidth: isOverrideEdge ? 2.5 : 1.5,
        stroke: isOverrideEdge
          ? 'var(--color-destructive)'
          : 'var(--color-border)',
      },
      data: { override: isOverrideEdge },
    });
  }

  // Bypass edge: 1 -> 3 also has a dashed visual cue from the ghost step
  // 2 marker. We render it as a separate dashed edge from step 2 to step 3
  // so the operator sees the bypass relationship explicitly.
  if (step2) {
    edges.push({
      id: 'e-1-2',
      source: 'step-1',
      target: 'step-2',
      style: {
        strokeDasharray: '4 4',
        strokeWidth: 1,
        stroke: 'var(--color-muted-foreground)',
      },
      data: { ghost: true },
    });
    edges.push({
      id: 'e-2-3',
      source: 'step-2',
      target: 'step-3',
      style: {
        strokeDasharray: '4 4',
        strokeWidth: 1,
        stroke: 'var(--color-muted-foreground)',
      },
      data: { ghost: true },
    });
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------

function prettyJson(json: string | null): string {
  if (!json) return '';
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

interface SidePanelProps {
  step: DecisionTraceStep | null;
  trace: DecisionTrace;
  onClose: () => void;
}

function SidePanel({ step, trace, onClose }: SidePanelProps) {
  if (!step) {
    return (
      <Card
        className="p-4 w-[400px] shrink-0"
        data-testid="tracer-side-panel-empty"
      >
        <p className="text-muted-foreground text-sm">
          Click a step to see its inputs, outputs, and detail.
        </p>
      </Card>
    );
  }

  const isStep6 = step.stepNumber === 6;
  const isStep8 = step.stepNumber === 8;
  const overrideLayer =
    isStep8 && trace.reasonTokens.length > 1 ? trace.reasonTokens[1] : null;
  const overrideField =
    isStep8 && trace.reasonTokens.length > 3 ? trace.reasonTokens[3] : null;

  return (
    <Card
      className="p-4 w-[400px] shrink-0 overflow-y-auto gap-0"
      data-testid="tracer-side-panel"
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-muted-foreground text-xs">Step {step.stepNumber}</p>
          <h3 className="text-foreground text-base font-semibold">{step.name}</h3>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>

      <div className="mb-3">
        <Badge
          variant={statusBadgeVariant(step.status)}
          className="capitalize"
          data-testid="tracer-side-panel-status"
        >
          {step.status}
        </Badge>
      </div>

      <p className="text-xs text-muted-foreground mb-3">{step.detail}</p>

      <details className="mb-3" open>
        <summary className="text-xs font-semibold text-foreground cursor-pointer mb-1">
          Inputs
        </summary>
        <pre
          className="text-[10px] font-mono bg-muted/40 p-2 rounded overflow-x-auto"
          data-testid="tracer-side-panel-inputs"
        >
          {prettyJson(step.inputs)}
        </pre>
      </details>

      {step.outputs !== null && (
        <details className="mb-3" open>
          <summary className="text-xs font-semibold text-foreground cursor-pointer mb-1">
            Outputs
          </summary>
          <pre
            className="text-[10px] font-mono bg-muted/40 p-2 rounded overflow-x-auto"
            data-testid="tracer-side-panel-outputs"
          >
            {prettyJson(step.outputs)}
          </pre>
        </details>
      )}

      {isStep6 && (trace.arbitrationPattern || trace.scopeReduction) && (
        <div
          className="text-xs flex flex-col gap-1 border-t border-border pt-3 mt-3"
          data-testid="tracer-side-panel-step6-meta"
        >
          {trace.arbitrationPattern && (
            <p>
              <span className="text-muted-foreground">Pattern:</span>{' '}
              <span className="font-mono">{trace.arbitrationPattern}</span>
            </p>
          )}
          {trace.scopeReduction && (
            <p>
              <span className="text-muted-foreground">Scope reduction:</span>{' '}
              <span className="font-mono">{trace.scopeReduction}</span>
            </p>
          )}
        </div>
      )}

      {isStep8 && trace.constitutionalOverride && (
        <div
          className="text-xs flex flex-col gap-1 border-t border-border pt-3 mt-3"
          data-testid="tracer-side-panel-step8-meta"
        >
          {overrideLayer && (
            <p>
              <span className="text-muted-foreground">Layer:</span>{' '}
              <span className="font-mono">{overrideLayer}</span>
            </p>
          )}
          {overrideField && (
            <p>
              <span className="text-muted-foreground">Field:</span>{' '}
              <span className="font-mono">{overrideField}</span>
            </p>
          )}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState({ onOpenLedger }: { onOpenLedger: () => void }) {
  return (
    <Card
      className="p-8 max-w-3xl gap-0"
      data-testid="tracer-empty-state"
    >
      <h3 className="text-foreground text-lg font-semibold mb-2">
        Decision flow tracer
      </h3>
      <p className="text-muted-foreground text-sm mb-4">
        Load a finding to inspect the engine's 8-step pipeline. Each finding
        captures one dispatch decision; the tracer reconstructs the path
        through case-law, covering-unit discovery, scope selection,
        composition arbitration, and constitutional review.
      </p>
      <ol className="list-decimal pl-5 flex flex-col gap-1 text-xs text-muted-foreground mb-6">
        <li>Case-law lookup — first match in precedence order short-circuits.</li>
        <li>(Reserved scaffold — replaced by step 6.)</li>
        <li>Covering-unit discovery for the requesting agent.</li>
        <li>Residual-authority denial when no unit covers the action.</li>
        <li>Tightest-scope selection (lex tiebreak on unit_id).</li>
        <li>Composition evaluation (four arbitration patterns).</li>
        <li>Single-domain permit when no contract governs.</li>
        <li>Constitutional review can override any permit.</li>
      </ol>
      <Button onClick={onOpenLedger} data-testid="tracer-open-ledger">
        <ExternalLink className="size-3" />
        Open ledger
      </Button>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Pipeline canvas
// ---------------------------------------------------------------------------

interface PipelineCanvasProps {
  trace: DecisionTrace;
  selectedStepNumber: number | null;
  onSelectStep: (stepNumber: number | null) => void;
}

function PipelineCanvas({
  trace,
  selectedStepNumber,
  onSelectStep,
}: PipelineCanvasProps) {
  const { nodes, edges } = useMemo(() => {
    const built = buildNodesAndEdges(trace);
    // Apply selection state to node data (so the renderer can ring it).
    return {
      nodes: built.nodes.map((n) => ({
        ...n,
        data: {
          ...n.data,
          selected: n.data.step.stepNumber === selectedStepNumber,
        },
      })),
      edges: built.edges,
    };
  }, [trace, selectedStepNumber]);

  return (
    <Card
      className="p-0 gap-0 h-[280px] relative"
      data-testid="tracer-pipeline-canvas"
      data-constitutional-override={
        trace.constitutionalOverride ? 'true' : 'false'
      }
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        // Pan/zoom intentionally disabled per the spec —
        // operators compare nodes side-by-side, not navigate.
        // may reconsider when the time-machine scrubber lands.
        panOnDrag={false}
        panOnScroll={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_evt, node) => {
          const data = node.data as PipelineNodeData;
          onSelectStep(data.step.stepNumber);
        }}
        fitView
        fitViewOptions={{ padding: 0.15 }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Terminal decision card
// ---------------------------------------------------------------------------

function TerminalDecisionCard({
  trace,
  onViewInLedger,
  pinned,
  onTogglePin,
  pinControlsVisible,
}: {
  trace: DecisionTrace;
  onViewInLedger: () => void;
  pinned: boolean;
  onTogglePin: () => void;
  pinControlsVisible: boolean;
}) {
  const { finding, terminalDecision, terminalStepNumber } = trace;
  return (
    <Card
      className="p-4 flex-row items-center flex-wrap"
      data-testid="tracer-terminal-card"
      data-pinned={pinned ? 'true' : 'false'}
    >
      <div>
        <p className="text-muted-foreground text-xs mb-1">Decision</p>
        <Badge
          variant={decisionVariant(terminalDecision)}
          className="capitalize text-sm"
          data-testid="tracer-terminal-decision-badge"
        >
          {terminalDecision}
        </Badge>
      </div>
      <div>
        <p className="text-muted-foreground text-xs mb-1">Reached at</p>
        <p
          className="text-foreground text-sm font-mono"
          data-testid="tracer-terminal-step"
        >
          step {terminalStepNumber}
        </p>
      </div>
      <div>
        <p className="text-muted-foreground text-xs mb-1">Workflow</p>
        <p className="text-foreground text-sm font-mono">
          {finding.workflowId}
        </p>
      </div>
      <div>
        <p className="text-muted-foreground text-xs mb-1">Agents</p>
        <p className="text-foreground text-sm font-mono">
          {finding.requestingAgent} → {finding.targetAgent}
        </p>
      </div>
      <div className="ml-auto flex items-center gap-2">
        {pinControlsVisible && (
          <Button
            variant={pinned ? 'default' : 'outline'}
            size="sm"
            onClick={onTogglePin}
            data-testid="tracer-pin-button"
            aria-pressed={pinned}
            aria-label={pinned ? 'Unpin current finding' : 'Pin current finding'}
          >
            {pinned ? (
              <PinOff className="size-3" />
            ) : (
              <Pin className="size-3" />
            )}
            {pinned ? 'Pinned' : 'Pin'}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={onViewInLedger}
          data-testid="tracer-view-in-ledger"
        >
          <ExternalLink className="size-3" />
          View finding in ledger
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// live tail constants + helpers
// ---------------------------------------------------------------------------

/**
 * Live tail buffer cap. Sized to ~200 findings to scope the time-machine
 * scrubber to the most recent activity. The hook trims older entries
 * automatically when the cap is reached.
 */
const LIVE_BUFFER_SIZE = 200;

/**
 * Time-machine scrubber window. Findings older than this are still in
 * the buffer (until evicted by capacity) but the scrubber only addresses
 * the most-recent SCRUBBER_WINDOW_MS slice.
 */
const SCRUBBER_WINDOW_MS = 60_000;

/**
 * Pipeline replay throttle. Cap displayed updates to 10 per second to
 * avoid overwhelming the React Flow render path during a deny-storm.
 */
const REPLAY_THROTTLE_MS = 100;

/**
 * opacity ladder for ghost pipeline canvases. Index N is
 * applied to the (N+1)-th most recent ghost, so the most recent ghost is
 * the most opaque (0.5) and the oldest visible ghost is barely visible
 * (0.15). Inline numeric `opacity` is used here rather than Tailwind
 * opacity utilities because we have a fixed 4-step ladder that doesn't
 * map cleanly onto Tailwind's preset scale; numeric is acceptable per
 * the wave-3.d constraints (no inline colour literals; opacity is fine).
 */
const GHOST_OPACITIES: ReadonlyArray<number> = [0.5, 0.35, 0.2, 0.15];

/**
 * pixel offset between stacked ghost canvases. Each ghost is
 * shifted (idx+1) * GHOST_OFFSET_PX in both x and y so the stack reads as
 * overlapping cards rather than perfectly aligned twins.
 */
const GHOST_OFFSET_PX = 8;

/**
 * localStorage key for the "Show ghosts" toggle. Persisted as
 * a boolean string ("true" / "false"); any other value (or a missing key)
 * is treated as the default ON.
 */
const GHOSTS_STORAGE_KEY = 'governance.tracer.showGhosts';

/**
 * Convert a buffered GovernanceFinding into a synthetic single-step
 * trace. The static-mode tracer fetches the full DecisionTrace from the
 * resolver, but live mode optimises for low-latency replay by
 * reconstructing a minimal trace from the finding's reason tokens.
 *
 * The synthetic trace renders the same pipeline canvas with status
 * colouring driven by the finding's terminal decision; the scrubber +
 * pin operate on these synthetic traces. Operators who need the full
 * 8-step trace can pin → click "View finding in ledger" → reopen the
 * tracer in static mode.
 */
function buildSyntheticTrace(finding: GovernanceFinding): DecisionTrace {
  const reasonTokens = (finding.reason ?? '').split(':').filter((t) => t.length > 0);
  const decision = finding.decision;
  const terminalStepNumber =
    decision === 'permit'
      ? 7
      : decision === 'deny'
        ? 4
        : decision === 'escalate'
          ? 6
          : 8;

  const passThrough = (
    n: number,
    name: string,
  ): DecisionTraceStep => ({
    stepNumber: n,
    name,
    status: 'pass-through',
    inputs: JSON.stringify({ findingId: finding.findingId }),
    outputs: null,
    detail: 'live tail synthetic step',
  });

  const terminalStep: DecisionTraceStep = {
    stepNumber: terminalStepNumber,
    name: 'Terminal',
    status:
      decision === 'permit'
        ? 'permitted'
        : decision === 'deny'
          ? 'denied'
          : decision === 'escalate'
            ? 'escalated'
            : 'pass-through',
    inputs: JSON.stringify({ findingId: finding.findingId }),
    outputs: JSON.stringify({ decision }),
    detail: finding.reason || 'no reason recorded',
  };

  const steps: DecisionTraceStep[] = [];
  for (let n = 1; n <= 8; n++) {
    if (n === terminalStepNumber) {
      steps.push(terminalStep);
    } else {
      steps.push(passThrough(n, `Step ${n}`));
    }
  }

  return {
    findingId: finding.findingId,
    finding,
    steps,
    terminalDecision: decision,
    terminalStepNumber,
    reasonTokens,
    constitutionalOverride: false,
    arbitrationPattern: null,
    scopeReduction: null,
  };
}

/**
 * Find the buffered finding closest to a target Unix timestamp (in ms).
 * The buffer is most-recent-first; we walk it linearly because 200
 * entries is too small to justify the overhead of a sorted index.
 */
function findClosestFindingByTimestampMs(
  buffer: GovernanceFinding[],
  targetMs: number,
): GovernanceFinding | null {
  if (buffer.length === 0) return null;
  let best = buffer[0];
  let bestDelta = Math.abs(timestampToMs(best.timestamp) - targetMs);
  for (const finding of buffer) {
    const delta = Math.abs(timestampToMs(finding.timestamp) - targetMs);
    if (delta < bestDelta) {
      best = finding;
      bestDelta = delta;
    }
  }
  return best;
}

/**
 * GovernanceFinding.timestamp is a GraphQL Float (Python ledger writes a
 * fractional Unix-seconds value). Convert to ms for slider arithmetic.
 */
function timestampToMs(ts: number): number {
  return Math.round(ts * 1000);
}

// ---------------------------------------------------------------------------
// live tail UI components
// ---------------------------------------------------------------------------

interface LiveTailHeaderProps {
  liveOn: boolean;
  onToggle: (next: boolean) => void;
  bufferLength: number;
  /** : ghost pipeline visibility toggle (only rendered when liveOn). */
  showGhosts: boolean;
  onToggleShowGhosts: (next: boolean) => void;
}

function LiveTailHeader({
  liveOn,
  onToggle,
  bufferLength,
  showGhosts,
  onToggleShowGhosts,
}: LiveTailHeaderProps) {
  return (
    <div
      className="flex items-center gap-3"
      data-testid="tracer-live-header"
    >
      <Switch
        id="tracer-live-toggle"
        checked={liveOn}
        onCheckedChange={onToggle}
        data-testid="tracer-live-toggle"
        aria-label="Toggle live tail mode"
      />
      <Label
        htmlFor="tracer-live-toggle"
        className="text-sm text-foreground flex items-center gap-1.5 cursor-pointer"
      >
        <Radio
          className={`size-3 ${liveOn ? 'text-chart-2' : 'text-muted-foreground'}`}
        />
        Live
      </Label>
      {liveOn && (
        <span
          className="text-muted-foreground text-xs"
          data-testid="tracer-live-buffer-indicator"
        >
          {bufferLength} {bufferLength === 1 ? 'finding' : 'findings'} in last 60s
        </span>
      )}
      {liveOn && (
        <div className="flex items-center gap-1.5">
          <Switch
            id="tracer-ghost-toggle"
            checked={showGhosts}
            onCheckedChange={onToggleShowGhosts}
            data-testid="tracer-ghost-toggle"
            aria-label="Toggle ghost pipelines"
          />
          <Label
            htmlFor="tracer-ghost-toggle"
            className="text-sm text-foreground cursor-pointer"
          >
            Show ghosts
          </Label>
        </div>
      )}
    </div>
  );
}

interface LiveScrubberProps {
  buffer: GovernanceFinding[];
  scrubMs: number | null;
  onScrub: (ms: number) => void;
  onResumeLive: () => void;
  pinnedTimestampMs: number | null;
}

function LiveScrubber({
  buffer,
  scrubMs,
  onScrub,
  onResumeLive,
  pinnedTimestampMs,
}: LiveScrubberProps) {
  // Use the buffer's actual time range when available, otherwise a
  // SCRUBBER_WINDOW_MS-wide window ending now. The slider expresses ms
  // since the window's start.
  const now = Date.now();
  const newest = buffer[0] ? timestampToMs(buffer[0].timestamp) : now;
  const oldest = buffer[buffer.length - 1]
    ? timestampToMs(buffer[buffer.length - 1].timestamp)
    : now - SCRUBBER_WINDOW_MS;
  const minMs = Math.min(oldest, newest - SCRUBBER_WINDOW_MS);
  const maxMs = newest;
  const value = scrubMs ?? maxMs;

  return (
    <Card
      className="p-3 flex-row items-center gap-3"
      data-testid="tracer-live-scrubber"
    >
      <span className="text-xs text-muted-foreground shrink-0">
        Time machine
      </span>
      <Slider
        className="flex-1"
        min={minMs}
        max={maxMs}
        step={100}
        value={[value]}
        onValueChange={(values) => onScrub(values[0])}
        data-testid="tracer-scrubber-slider"
        aria-label="Scrub through buffered findings"
        disabled={buffer.length === 0}
      />
      {pinnedTimestampMs !== null && (
        <span
          className="size-2 rounded-full bg-primary"
          data-testid="tracer-scrubber-pin-marker"
          title={`Pinned at ${new Date(pinnedTimestampMs).toLocaleTimeString()}`}
          aria-label="Pin marker"
        />
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={onResumeLive}
        data-testid="tracer-resume-live"
        disabled={buffer.length === 0}
      >
        Resume live
      </Button>
    </Card>
  );
}

function LiveEmptyState() {
  return (
    <div
      className="border border-border border-dashed rounded-lg p-8 flex items-center justify-center gap-3"
      data-testid="tracer-live-empty"
    >
      <span
        className="size-2 rounded-full bg-chart-2 animate-pulse"
        aria-hidden="true"
      />
      <p className="text-muted-foreground text-sm">
        Listening for governance decisions…
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ghost pipeline rendering
// ---------------------------------------------------------------------------

interface ConcurrencyBadgeProps {
  concurrentCount: number;
}

/**
 * Small badge that surfaces the total number of concurrent decisions in
 * the current 100ms window (foreground + ghosts). Renders only when at
 * least one ghost is present; the question-mark glyph carries a `title`
 * tooltip explaining what ghost pipelines are.
 *
 * The badge stays visible even when the operator hides the ghost
 * canvases via the "Show ghosts" toggle, so they always know contention
 * is happening and can opt back in.
 */
function ConcurrencyBadge({ concurrentCount }: ConcurrencyBadgeProps) {
  return (
    <Card
      className="absolute top-2 left-2 z-20 flex-row items-center gap-1 bg-background/90 rounded-md px-2 py-1 text-xs shadow-sm"
      data-testid="tracer-concurrency-badge"
      data-concurrent-count={concurrentCount}
    >
      <span className="text-foreground font-medium">
        {concurrentCount} concurrent decisions in this window
      </span>
      <span
        className="text-muted-foreground cursor-help select-none"
        title="Ghost pipelines visualise concurrent governance decisions evaluated within ~100ms of the foreground. They are not interactive."
        aria-label="What are ghost pipelines?"
      >
        ?
      </span>
    </Card>
  );
}

interface GhostCanvasProps {
  ghost: GovernanceFinding;
  index: number;
}

/**
 * One ghost pipeline canvas: a non-interactive copy of PipelineCanvas
 * positioned absolutely behind the foreground. Inline numeric opacity
 * implements the 0.5 → 0.15 ladder; pointer-events:none guarantees the
 * ghost cannot intercept clicks meant for the foreground (the foreground
 * sits at z-10, ghosts at z-1).
 *
 * Inline `transform` rather than Tailwind translate utilities because
 * the offset is dynamic per ghost index — Tailwind would require N
 * preset classes for N ghosts.
 */
function GhostCanvas({ ghost, index }: GhostCanvasProps) {
  const opacity = GHOST_OPACITIES[index] ?? GHOST_OPACITIES[GHOST_OPACITIES.length - 1];
  const offset = (index + 1) * GHOST_OFFSET_PX;
  const ghostTrace = useMemo(() => buildSyntheticTrace(ghost), [ghost]);
  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{
        opacity,
        transform: `translate(${offset}px, ${offset}px)`,
        zIndex: 1,
      }}
      data-testid={`tracer-ghost-canvas-${index}`}
      data-ghost-finding-id={ghost.findingId}
      aria-hidden="true"
    >
      <PipelineCanvas
        trace={ghostTrace}
        selectedStepNumber={null}
        onSelectStep={noopSelectStep}
      />
    </div>
  );
}

/** Stable no-op so GhostCanvas can pass a memo-friendly handler. */
const noopSelectStep = (_n: number | null) => {
  /* ghosts are not interactive — see GhostCanvas */
};

// ---------------------------------------------------------------------------
// counterfactual diff helpers
// ---------------------------------------------------------------------------

/**
 * Compare baseline + alternative trace step-by-step.
 *
 * Returns one entry per step (8 total). `changed` is true when the
 * baseline status and alternative status differ; the renderer uses
 * this to switch between the muted "Same as baseline" badge and the
 * red "Step changed" badge per the spec.
 */
interface CounterfactualStepDiff {
  stepNumber: number;
  baselineStatus: string;
  alternativeStatus: string;
  changed: boolean;
}

function computeStepDiffs(
  baseline: DecisionTrace,
  alternative: DecisionTrace,
): CounterfactualStepDiff[] {
  const out: CounterfactualStepDiff[] = [];
  for (let n = 1; n <= 8; n += 1) {
    const baselineStep = baseline.steps.find((s) => s.stepNumber === n);
    const alternativeStep = alternative.steps.find((s) => s.stepNumber === n);
    const baselineStatus = baselineStep?.status ?? 'skipped';
    const alternativeStatus = alternativeStep?.status ?? 'skipped';
    out.push({
      stepNumber: n,
      baselineStatus,
      alternativeStatus,
      changed: baselineStatus !== alternativeStatus,
    });
  }
  return out;
}

interface CounterfactualDiffBannerProps {
  baseline: DecisionTrace;
  alternative: DecisionTrace;
  onClear: () => void;
}

/**
 * The terminal-step diff banner is the most prominent piece of the
 * split view: a large badge above the canvas split summarising whether
 * the alternative changed the terminal decision (and at which step).
 * Per-step diffs render as a compact list below the banner.
 */
function CounterfactualDiffBanner({
  baseline,
  alternative,
  onClear,
}: CounterfactualDiffBannerProps) {
  const terminalChanged =
    baseline.terminalDecision !== alternative.terminalDecision ||
    baseline.terminalStepNumber !== alternative.terminalStepNumber;
  const stepDiffs = useMemo(
    () => computeStepDiffs(baseline, alternative),
    [baseline, alternative],
  );

  return (
    <Card
      className="p-4 mb-4 gap-3"
      data-testid="tracer-counterfactual-diff-banner"
      data-terminal-changed={terminalChanged ? 'true' : 'false'}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-muted-foreground text-xs mb-1">
            Counterfactual outcome
          </p>
          {terminalChanged ? (
            <p
              className="text-destructive text-base font-semibold"
              data-testid="tracer-counterfactual-terminal-changed"
            >
              Terminal changed: {baseline.terminalDecision} (step{' '}
              {baseline.terminalStepNumber}) → {alternative.terminalDecision}{' '}
              (step {alternative.terminalStepNumber})
            </p>
          ) : (
            <p
              className="text-muted-foreground text-base"
              data-testid="tracer-counterfactual-terminal-unchanged"
            >
              Terminal decision unchanged: {baseline.terminalDecision} at step{' '}
              {baseline.terminalStepNumber}
            </p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onClear}
          data-testid="tracer-counterfactual-clear"
        >
          Clear counterfactual
        </Button>
      </div>
      <div
        className="flex flex-wrap gap-1"
        data-testid="tracer-counterfactual-step-diffs"
      >
        {stepDiffs.map((diff) => (
          <span
            key={diff.stepNumber}
            className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
              diff.changed
                ? 'border-destructive/60 bg-destructive/15 text-destructive'
                : 'border-border bg-muted/40 text-muted-foreground'
            }`}
            data-testid={`tracer-counterfactual-step-diff-${diff.stepNumber}`}
            data-changed={diff.changed ? 'true' : 'false'}
          >
            {diff.changed
              ? `§ Step ${diff.stepNumber} changed: ${diff.baselineStatus} → ${diff.alternativeStatus}`
              : `Step ${diff.stepNumber}: same as baseline`}
          </span>
        ))}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function GovernanceTracer() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialFindingId = searchParams.get('findingId') ?? '';

  const [findingIdInput, setFindingIdInput] = useState(initialFindingId);
  const [activeFindingId, setActiveFindingId] = useState(initialFindingId);
  const [trace, setTrace] = useState<DecisionTrace | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedStepNumber, setSelectedStepNumber] = useState<number | null>(
    null,
  );

  // --- live tail state ---
  const [liveOn, setLiveOn] = useState<boolean>(false);
  // null = follow live (latest); number = scrubbed-to position in ms
  const [scrubMs, setScrubMs] = useState<number | null>(null);
  // Pinned finding ID in live mode. While pinned the displayed pipeline
  // does NOT auto-update even though the buffer continues to grow.
  const [pinnedFindingId, setPinnedFindingId] = useState<string | null>(null);
  // Replay throttle: track the last update ms so we can drop intermediate
  // replays under a deny-storm. The latest pending finding is held in a
  // ref so the trailing update fires after the throttle window expires.
  const lastReplayMsRef = useRef<number>(0);

  // --- ghost pipeline state ---
  // Default ON; restore from localStorage on initial mount. Stored as
  // 'true' / 'false' strings; any other value falls back to the default.
  const [showGhosts, setShowGhosts] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    try {
      const stored = window.localStorage.getItem(GHOSTS_STORAGE_KEY);
      if (stored === null) return true;
      return stored !== 'false';
    } catch {
      return true;
    }
  });

  // Persist the toggle on every change so the next mount restores it.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(GHOSTS_STORAGE_KEY, String(showGhosts));
    } catch {
      /* localStorage may be unavailable (SSR / quota); ignore */
    }
  }, [showGhosts]);

  // --- counterfactual evaluator state ---
  // The cached client-side governance engine. `null` while loading, or
  // when any of the four state queries failed.
  const { engine, loading: engineLoading } = useGovernanceEngine();
  const org = useOrganization();
  const isAdmin = !!org.isAdmin;
  // Side-panel open state. Independent of `trace` so the panel can stay
  // open while the operator scrolls through the form.
  const [counterfactualOpen, setCounterfactualOpen] = useState<boolean>(false);
  // Most-recent counterfactual commit. `null` when there is no
  // alternative pipeline rendered. Sequential evaluations replace this
  // value — there is no history pane in 5.B.2.
  const [counterfactualCommit, setCounterfactualCommit] =
    useState<CounterfactualCommit | null>(null);

  const stream = useGovernanceFindingStream({
    enabled: liveOn,
    bufferSize: LIVE_BUFFER_SIZE,
  });

  const fetchTrace = useCallback(async (id: string) => {
    if (!id.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const result = await governanceService.getDecisionTrace(id.trim());
      setTrace(result);
      if (!result) {
        setError(`No finding found for ID: ${id.trim()}`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load trace';
      setError(msg);
      setTrace(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-load on mount when ?findingId=... is present.
  useEffect(() => {
    if (initialFindingId) {
      fetchTrace(initialFindingId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- drive trace replay from the live buffer ---
  //
  // Three cases:
  //   1. liveOn && pinned       → freeze on the pinned finding.
  //   2. liveOn && scrubMs set  → render the buffered finding closest to scrubMs.
  //   3. liveOn && (no pin/scrub) → auto-replay the latest finding (throttled).
  //
  // Static mode (liveOn=false) leaves the resolver-driven trace alone.
  useEffect(() => {
    if (!liveOn) return;
    const buffer = stream.buffer;
    if (buffer.length === 0) return;

    // Pin freezes on the previously selected finding regardless of new
    // arrivals. Buffer continues to grow.
    if (pinnedFindingId !== null) return;

    // Scrubbed mode: render the closest finding to the slider position.
    if (scrubMs !== null) {
      const finding = findClosestFindingByTimestampMs(buffer, scrubMs);
      if (finding) setTrace(buildSyntheticTrace(finding));
      return;
    }

    // Live mode (auto-replay latest), throttled to REPLAY_THROTTLE_MS.
    const now = Date.now();
    const elapsed = now - lastReplayMsRef.current;
    if (elapsed < REPLAY_THROTTLE_MS) {
      // Schedule a trailing update so the most recent finding still
      // surfaces after the throttle window expires.
      const id = window.setTimeout(() => {
        lastReplayMsRef.current = Date.now();
        const head = stream.buffer[0];
        if (head && pinnedFindingId === null && scrubMs === null) {
          setTrace(buildSyntheticTrace(head));
        }
      }, REPLAY_THROTTLE_MS - elapsed);
      return () => window.clearTimeout(id);
    }
    lastReplayMsRef.current = now;
    setTrace(buildSyntheticTrace(buffer[0]));
    setError(null);
  }, [liveOn, stream.buffer, scrubMs, pinnedFindingId]);

  // Live errors flow into the page-level error banner so the operator
  // sees subscription issues without separate UI.
  useEffect(() => {
    if (stream.error) setError(stream.error);
  }, [stream.error]);

  const handleLoad = () => {
    const id = findingIdInput.trim();
    if (!id) return;
    setActiveFindingId(id);
    setSearchParams({ findingId: id });
    // Loading a specific finding implicitly drops out of live mode so the
    // operator's explicit lookup is not immediately overwritten by the
    // next live arrival.
    if (liveOn) {
      setLiveOn(false);
      setPinnedFindingId(null);
      setScrubMs(null);
    }
    fetchTrace(id);
  };

  const handlePaste = async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) setFindingIdInput(text.trim());
    } catch {
      // Clipboard access may be denied; the operator can still paste manually.
    }
  };

  const handleLiveToggle = useCallback((next: boolean) => {
    setLiveOn(next);
    if (!next) {
      // Leaving live mode resets the time-machine state so the next
      // toggle-on starts fresh.
      setScrubMs(null);
      setPinnedFindingId(null);
    }
  }, []);

  const handleResumeLive = useCallback(() => {
    setScrubMs(null);
    setPinnedFindingId(null);
  }, []);

  const handleTogglePin = useCallback(() => {
    if (!trace) return;
    setPinnedFindingId((prev) =>
      prev === trace.findingId ? null : trace.findingId,
    );
  }, [trace]);

  // --- counterfactual handlers ---
  //
  // Sequential commits replace each other; only the most recent
  // alternative is rendered (no history pane in 5.B.2). Loading a new
  // baseline finding or toggling live mode on clears the counterfactual
  // because the alternative is no longer comparable.
  const handleCounterfactualCommit = useCallback(
    (commit: CounterfactualCommit) => {
      setCounterfactualCommit(commit);
    },
    [],
  );

  const handleClearCounterfactual = useCallback(() => {
    setCounterfactualCommit(null);
  }, []);

  // Drop the counterfactual whenever the foreground trace changes so the
  // operator doesn't see a stale alternative compared against the wrong
  // baseline. Live-tail buffer additions update `trace` rapidly while
  // live mode is on; counterfactual evaluation is incompatible with
  // live mode per the 5.B.2 spec, so this also enforces the freeze.
  useEffect(() => {
    setCounterfactualCommit(null);
  }, [trace?.findingId, liveOn]);

  const selectedStep = useMemo(() => {
    if (!trace || selectedStepNumber === null) return null;
    return (
      trace.steps.find((s) => s.stepNumber === selectedStepNumber) ?? null
    );
  }, [trace, selectedStepNumber]);

  // recompute the concurrency group only when the buffer or
  // pinned finding changes. Static mode (liveOn=false) intentionally
  // bypasses this so the helper is never called with stale buffer data
  // from a previous live session and ghost canvases never render in
  // static mode (the spec disables them entirely there).
  const concurrencyGroup: ConcurrencyGroup | null = useMemo(() => {
    if (!liveOn) return null;
    return detectConcurrencyGroup(stream.buffer, pinnedFindingId);
  }, [liveOn, stream.buffer, pinnedFindingId]);

  const pinned = trace !== null && pinnedFindingId === trace.findingId;
  const pinnedTimestampMs = pinned && trace ? timestampToMs(trace.finding.timestamp) : null;

  // In live mode, the empty state shows when the stream has produced no
  // findings yet AND no static trace is loaded.
  const showLiveEmpty = liveOn && stream.buffer.length === 0 && trace === null;

  return (
    <PageContainer className="flex-1 flex flex-col bg-background">
      <GovernanceBreadcrumbs title="Decision flow tracer" />
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-foreground text-2xl font-semibold mb-2">
            Decision flow tracer
          </h2>
          <p className="text-muted-foreground text-sm">
            Visualize the 8-step governance engine pipeline for any finding.
            Paste a finding ID, follow a link from the ledger, or toggle Live
            to watch decisions stream in.
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {isAdmin && trace !== null && !liveOn && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCounterfactualOpen(true)}
              disabled={engineLoading || engine === null}
              data-testid="tracer-counterfactual-button"
              title={
                engineLoading || engine === null
                  ? 'Loading governance state…'
                  : 'Edit the dispatch request and re-evaluate against the current governance state'
              }
            >
              <Pencil className="size-3" />
              Edit and re-evaluate
            </Button>
          )}
          <LiveTailHeader
            liveOn={liveOn}
            onToggle={handleLiveToggle}
            bufferLength={stream.buffer.length}
            showGhosts={showGhosts}
            onToggleShowGhosts={setShowGhosts}
          />
        </div>
      </div>

      {/* Finding selector */}
      <div className="flex items-end gap-3 mb-6 flex-wrap">
        <div className="flex flex-col gap-1">
          <Label
            htmlFor="tracer-finding-input"
            className="text-xs text-muted-foreground"
          >
            Finding ID
          </Label>
          <div className="flex gap-2">
            <Input
              id="tracer-finding-input"
              data-testid="tracer-finding-input"
              value={findingIdInput}
              onChange={(e) => setFindingIdInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleLoad();
              }}
              placeholder="paste finding id…"
              className="w-[360px]"
            />
            <Button
              variant="outline"
              size="icon"
              onClick={handlePaste}
              data-testid="tracer-paste-button"
              aria-label="Paste from clipboard"
            >
              <Clipboard className="size-3" />
            </Button>
          </div>
        </div>
        <Button
          onClick={handleLoad}
          disabled={!findingIdInput.trim() || loading}
          data-testid="tracer-load-button"
        >
          {loading ? 'Loading…' : 'Load'}
        </Button>
      </div>

      {/* Body */}
      {!activeFindingId && !loading && !liveOn && (
        <EmptyState onOpenLedger={() => navigate('/governance/ledger')} />
      )}

      {showLiveEmpty && <LiveEmptyState />}

      {loading && (
        <div data-testid="tracer-loading">
          <Skeleton className="h-[60px] w-full mb-4" />
          <Skeleton className="h-[280px] w-full mb-4" />
          <Skeleton className="h-[80px] w-full" />
        </div>
      )}

      {error && (
        <div
          className="border border-destructive/40 rounded-lg p-4 mb-4 text-destructive text-sm"
          role="alert"
          data-testid="tracer-error"
        >
          {error}
        </div>
      )}

      {trace && !loading && (
        <>
          <div className="mb-4" data-testid="tracer-reason-breadcrumb">
            <p className="text-muted-foreground text-xs mb-1">Reason</p>
            <ReasonTokens tokens={trace.reasonTokens} />
          </div>

          {counterfactualCommit !== null && (
            <CounterfactualDiffBanner
              baseline={trace}
              alternative={counterfactualCommit.trace}
              onClear={handleClearCounterfactual}
            />
          )}

          <div className="flex gap-4 mb-4">
            <div
              className="flex-1 min-w-0 relative"
              data-testid="tracer-baseline-canvas"
            >
              {/*
                concurrency badge. Renders when the live tail
                detected at least one ghost in the same 100ms window. Stays
                visible even when ghosts are hidden (toggle off) so the
                operator always sees contention is happening.
              */}
              {liveOn &&
                concurrencyGroup &&
                concurrencyGroup.ghosts.length > 0 && (
                  <ConcurrencyBadge
                    concurrentCount={concurrencyGroup.ghosts.length + 1}
                  />
                )}
              {/*
                ghost pipeline canvases stacked behind the
                foreground. Reverse-rendered (most recent ghost on top of
                the older ones) and positioned absolutely with z-index 1;
                the foreground sits at z-10 and remains fully interactive.
              */}
              {liveOn &&
                showGhosts &&
                concurrencyGroup?.ghosts.map((ghost, idx) => (
                  <GhostCanvas
                    key={ghost.findingId}
                    ghost={ghost}
                    index={idx}
                  />
                ))}
              <div className="relative z-10">
                {counterfactualCommit !== null && (
                  <p
                    className="text-muted-foreground text-xs mb-1"
                    data-testid="tracer-baseline-canvas-label"
                  >
                    Baseline
                  </p>
                )}
                <PipelineCanvas
                  trace={trace}
                  selectedStepNumber={selectedStepNumber}
                  onSelectStep={setSelectedStepNumber}
                />
              </div>
            </div>
            {counterfactualCommit !== null && (
              <div
                className="flex-1 min-w-0 relative"
                data-testid="tracer-alternative-canvas"
              >
                <p
                  className="text-muted-foreground text-xs mb-1"
                  data-testid="tracer-alternative-canvas-label"
                >
                  Alternative
                </p>
                <PipelineCanvas
                  trace={counterfactualCommit.trace}
                  selectedStepNumber={null}
                  onSelectStep={noopSelectStep}
                />
              </div>
            )}
            {counterfactualCommit === null && (
              <SidePanel
                step={selectedStep}
                trace={trace}
                onClose={() => setSelectedStepNumber(null)}
              />
            )}
          </div>

          <TerminalDecisionCard
            trace={trace}
            onViewInLedger={() =>
              navigate(`/governance/ledger?findingId=${trace.findingId}`)
            }
            pinned={pinned}
            onTogglePin={handleTogglePin}
            pinControlsVisible={liveOn}
          />
        </>
      )}

      {/* Time machine scrubber — only visible in live mode */}
      {liveOn && (
        <div className="mt-4">
          <LiveScrubber
            buffer={stream.buffer}
            scrubMs={scrubMs}
            onScrub={(ms) => setScrubMs(ms)}
            onResumeLive={handleResumeLive}
            pinnedTimestampMs={pinnedTimestampMs}
          />
        </div>
      )}

      {/*
        counterfactual side panel. Mounted unconditionally
        when an engine + trace are available so the Sheet's open/close
        animation can run without a remount. The panel itself returns
        null when `open=false`, so the component tree stays small while
        idle.
      */}
      {trace !== null && engine !== null && (
        <CounterfactualPanel
          open={counterfactualOpen}
          onOpenChange={setCounterfactualOpen}
          baselineFinding={{
            findingId: trace.findingId,
            workflowId: trace.finding.workflowId,
            requestingAgent: trace.finding.requestingAgent,
            targetAgent: trace.finding.targetAgent,
          }}
          engine={engine}
          onCommit={handleCounterfactualCommit}
        />
      )}
    </PageContainer>
  );
}

export default GovernanceTracer;
