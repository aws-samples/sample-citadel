/**
 * Governance Authority Graph
 *
 * Static, read-only visualisation of the per-app authority topology:
 * agents (squares), authority units (circles, coloured by domain), and
 * composition contracts (diamonds). Edges encode binding (agent → unit),
 * delegation (unit → unit), and composition (agent ↔ agent).
 *
 * Admin-only — non-admins see an empty state and the page makes no fetch.
 *
 * Layout uses `d3-force` for initial node positions: charge + link +
 * center + collide forces run for ~300 iterations OFF-SCREEN, then the
 * resulting positions are committed to ReactFlow nodes. ReactFlow handles
 * pan/zoom from there. No continuous animation — the simulation is a
 * one-shot computation memoised on the filter set + raw data identity.
 *
 * This page is read-only. Blast-radius interactivity ships in 4.B, the
 * delegation diff scrubber in 4.C, and constitutional layer / case-law
 * nodes in 4.C / 4.D. None are wired here.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ReactFlow,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { PageContainer } from '../../components/PageContainer';
import { GovernanceBreadcrumbs } from '../../components/governance/GovernanceBreadcrumbs';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Label } from '../../components/ui/label';
import { Skeleton } from '../../components/ui/skeleton';
import { Switch } from '../../components/ui/switch';
import { Slider } from '../../components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '../../components/ui/tabs';
import { useOrganization } from '../../contexts/OrganizationContext';
import {
  governanceService,
  AuthorityUnit,
  CompositionContract,
  RevokeImpactReport,
  AuthorityGraphHistorySettings,
  AuthorityGraphSnapshotSummary,
  AuthorityGraphSnapshot,
} from '../../services/governanceService';
import { AuthorityGraphHistorySettingsDialog } from '../../components/AuthorityGraphHistorySettingsDialog';
import { computeGraphDelta, GraphDelta } from './graphDelta';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REGISTRY_ALL = '__ALL__';
const DOMAIN_ALL = '__ALL__';
const GLOBAL_REGISTRY_ID = '*GLOBAL*';
const RENDER_NODE_CAP = 500;
const SIMULATION_ITERATIONS = 300;
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 480;

// blast-radius mode persistence keys + window options.
const BLAST_RADIUS_STORAGE_KEY = 'governance.graph.blastRadius';
const BLAST_RADIUS_WINDOW_STORAGE_KEY = 'governance.graph.blastRadius.window';

interface BlastRadiusWindowOption {
  value: string;
  label: string;
  /** Window length in seconds. */
  seconds: number;
}

const BLAST_RADIUS_WINDOW_OPTIONS: readonly BlastRadiusWindowOption[] = [
  { value: '1h', label: 'Last 1h', seconds: 3600 },
  { value: '6h', label: 'Last 6h', seconds: 6 * 3600 },
  { value: '24h', label: 'Last 24h', seconds: 24 * 3600 },
] as const;

const DEFAULT_BLAST_RADIUS_WINDOW = '1h';

// Stable hash → chart-1..chart-5 Tailwind tokens for domain colouring.
// Collisions are intentional — five buckets is enough for visual grouping
// without inflating the palette beyond the project's chart token set.
const DOMAIN_PALETTE = [
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
] as const;

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function domainPaletteToken(domain: string): string {
  if (!domain) return DOMAIN_PALETTE[0];
  return DOMAIN_PALETTE[hashString(domain) % DOMAIN_PALETTE.length];
}

// ---------------------------------------------------------------------------
// Node + edge types
// ---------------------------------------------------------------------------

type GraphNodeKind = 'agent' | 'unit' | 'contract';

interface AgentNodeData extends Record<string, unknown> {
  kind: 'agent';
  agentId: string;
  unitCount: number;
}

interface UnitNodeData extends Record<string, unknown> {
  kind: 'unit';
  unit: AuthorityUnit;
  paletteToken: string;
  isWildcard: boolean;
}

interface ContractNodeData extends Record<string, unknown> {
  kind: 'contract';
  contract: CompositionContract;
}

type GraphNodeData = AgentNodeData | UnitNodeData | ContractNodeData;

interface GraphEdgeMeta {
  edgeKind: 'binding' | 'delegation' | 'composition';
  conflictResolution?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Node renderers
// ---------------------------------------------------------------------------

function riskBorderClass(rating: string): string {
  switch (rating) {
    case 'high':
      return 'border-destructive border-2';
    case 'medium':
      return 'border-amber-500 border-2';
    default:
      return 'border-muted-foreground/40 border';
  }
}

function AgentNode({ data }: NodeProps<Node<AgentNodeData>>) {
  return (
    <div
      className="rounded-md bg-card border border-foreground/30 px-3 py-2 text-xs font-mono text-foreground min-w-[80px] text-center"
      data-testid={`graph-agent-node-${data.agentId}`}
      data-node-kind="agent"
    >
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <span className="truncate inline-block max-w-[120px]">
        {data.agentId === '*' ? 'Wildcard agent' : data.agentId}
      </span>
      <Handle type="source" position={Position.Right} className="!opacity-0" />
    </div>
  );
}

function UnitNode({ data }: NodeProps<Node<UnitNodeData>>) {
  // Background colour token (e.g. `chart-1`) is mapped to a Tailwind
  // utility via a fixed lookup so Tailwind's JIT can pick the class up
  // statically; no inline colour literals.
  const bgClassByToken: Record<string, string> = {
    'chart-1': 'bg-chart-1/30',
    'chart-2': 'bg-chart-2/30',
    'chart-3': 'bg-chart-3/30',
    'chart-4': 'bg-chart-4/30',
    'chart-5': 'bg-chart-5/30',
  };
  const bg = bgClassByToken[data.paletteToken] ?? 'bg-muted/40';
  const border = riskBorderClass(data.unit.riskRating);
  const halo = data.isWildcard ? 'ring-4 ring-primary/40 animate-pulse' : '';
  return (
    <div
      className={`rounded-full ${bg} ${border} ${halo} size-16 flex items-center justify-center text-[10px] font-mono text-foreground`}
      data-testid={`graph-unit-node-${data.unit.unitId}`}
      data-node-kind="unit"
      data-domain={data.unit.scope.domain}
      data-risk={data.unit.riskRating}
      data-wildcard={data.isWildcard ? 'true' : 'false'}
      title={`${data.unit.unitId} (${data.unit.scope.domain})`}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <span className="truncate px-1">{data.unit.scope.domain}</span>
      <Handle type="source" position={Position.Right} className="!opacity-0" />
    </div>
  );
}

function ContractNode({ data }: NodeProps<Node<ContractNodeData>>) {
  // Diamond = rotated square via inline `transform` (necessary because
  // Tailwind has no preset diamond shape utility). The inner content is
  // counter-rotated to stay upright. No colour literals — `bg-card` and
  // `border-chart-4` are the design tokens.
  return (
    <div
      className="size-12 bg-card border border-chart-4 flex items-center justify-center"
      style={{ transform: 'rotate(45deg)' }}
      data-testid={`graph-contract-node-${data.contract.contractId}`}
      data-node-kind="contract"
      title={`${data.contract.contractId} (${data.contract.partyA} ↔ ${data.contract.partyB})`}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <span
        className="text-[9px] font-mono text-foreground"
        style={{ transform: 'rotate(-45deg)' }}
      >
        ⋄
      </span>
      <Handle type="source" position={Position.Right} className="!opacity-0" />
    </div>
  );
}

const nodeTypes = {
  agentNode: AgentNode,
  unitNode: UnitNode,
  contractNode: ContractNode,
};

// ---------------------------------------------------------------------------
// Force layout
// ---------------------------------------------------------------------------

interface SimNode extends SimulationNodeDatum {
  id: string;
  kind: GraphNodeKind;
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  id: string;
}

/**
 * Run d3-force off-screen for SIMULATION_ITERATIONS ticks and return a
 * map of node id → { x, y }. The simulation is fully synchronous — no
 * animation, no follow-up ticks. Re-running on filter change is the
 * caller's responsibility (we memoise on identity in the component).
 */
function computeLayout(
  nodeIds: { id: string; kind: GraphNodeKind }[],
  links: { id: string; source: string; target: string }[],
): Map<string, { x: number; y: number }> {
  if (nodeIds.length === 0) return new Map();
  const simNodes: SimNode[] = nodeIds.map((n) => ({
    id: n.id,
    kind: n.kind,
  }));
  const simLinks: SimLink[] = links.map((l) => ({
    id: l.id,
    source: l.source,
    target: l.target,
  }));
  const sim = forceSimulation<SimNode>(simNodes)
    .force(
      'link',
      forceLink<SimNode, SimLink>(simLinks)
        .id((d) => d.id)
        .distance(120)
        .strength(0.5),
    )
    .force('charge', forceManyBody().strength(-220))
    .force('center', forceCenter(CANVAS_WIDTH / 2, CANVAS_HEIGHT / 2))
    .force('collide', forceCollide(40))
    .stop();
  for (let i = 0; i < SIMULATION_ITERATIONS; i++) sim.tick();
  const result = new Map<string, { x: number; y: number }>();
  for (const n of simNodes) {
    result.set(n.id, {
      x: typeof n.x === 'number' ? n.x : CANVAS_WIDTH / 2,
      y: typeof n.y === 'number' ? n.y : CANVAS_HEIGHT / 2,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Build nodes + edges from the filtered data
// ---------------------------------------------------------------------------

interface BuildResult {
  nodes: Node<GraphNodeData>[];
  edges: Edge[];
  totalNodeCount: number;
  truncated: boolean;
}

function isWildcardUnit(unit: AuthorityUnit): boolean {
  return unit.agentId === '*' || unit.registryId === GLOBAL_REGISTRY_ID;
}

function buildGraph(
  units: AuthorityUnit[],
  contracts: CompositionContract[],
): BuildResult {
  // 1. Collect distinct agent IDs from units.bound + contracts.parties.
  const agentIds = new Set<string>();
  for (const u of units) agentIds.add(u.agentId);
  for (const c of contracts) {
    agentIds.add(c.partyA);
    agentIds.add(c.partyB);
  }

  // 2. Compute unit counts per agent (for the side panel and node sizing).
  const agentUnitCounts = new Map<string, number>();
  for (const u of units) {
    agentUnitCounts.set(u.agentId, (agentUnitCounts.get(u.agentId) ?? 0) + 1);
  }

  // 3. Determine total node count BEFORE truncation so the page can
  //    render the truncation notice with the full N.
  const totalNodeCount = agentIds.size + units.length + contracts.length;

  // 4. Apply the render cap. Order: agents first (smallest set), then
  //    units (most numerous), then contracts. The cap is per-render — the
  //    underlying data is preserved and a notice is shown.
  let remaining = RENDER_NODE_CAP;
  const renderedAgents: string[] = [];
  const renderedUnits: AuthorityUnit[] = [];
  const renderedContracts: CompositionContract[] = [];
  for (const id of agentIds) {
    if (remaining <= 0) break;
    renderedAgents.push(id);
    remaining--;
  }
  for (const u of units) {
    if (remaining <= 0) break;
    renderedUnits.push(u);
    remaining--;
  }
  for (const c of contracts) {
    if (remaining <= 0) break;
    renderedContracts.push(c);
    remaining--;
  }
  const truncated = totalNodeCount > RENDER_NODE_CAP;

  // 5. Build node descriptors (without positions yet).
  const nodes: Node<GraphNodeData>[] = [];
  const renderedAgentSet = new Set(renderedAgents);
  const renderedUnitIdSet = new Set(renderedUnits.map((u) => u.unitId));

  for (const agentId of renderedAgents) {
    nodes.push({
      id: `agent-${agentId}`,
      type: 'agentNode',
      position: { x: 0, y: 0 },
      data: {
        kind: 'agent',
        agentId,
        unitCount: agentUnitCounts.get(agentId) ?? 0,
      },
      draggable: false,
      selectable: true,
    });
  }
  for (const unit of renderedUnits) {
    nodes.push({
      id: `unit-${unit.unitId}`,
      type: 'unitNode',
      position: { x: 0, y: 0 },
      data: {
        kind: 'unit',
        unit,
        paletteToken: domainPaletteToken(unit.scope.domain),
        isWildcard: isWildcardUnit(unit),
      },
      draggable: false,
      selectable: true,
    });
  }
  for (const contract of renderedContracts) {
    nodes.push({
      id: `contract-${contract.contractId}`,
      type: 'contractNode',
      position: { x: 0, y: 0 },
      data: { kind: 'contract', contract },
      draggable: false,
      selectable: true,
    });
  }

  // 6. Build edges. Skip any edge whose endpoints are missing from the
  //    rendered set (so the truncation notice is the only visible
  //    indication of dropped data).
  const edges: Edge[] = [];

  // Binding: agent → unit
  for (const u of renderedUnits) {
    if (!renderedAgentSet.has(u.agentId)) continue;
    edges.push({
      id: `bind-${u.agentId}-${u.unitId}`,
      source: `agent-${u.agentId}`,
      target: `unit-${u.unitId}`,
      style: {
        strokeWidth: 1,
        stroke: 'var(--color-muted-foreground)',
      },
      data: { edgeKind: 'binding' } as GraphEdgeMeta,
    });
  }

  // Delegation: unit → unit (when delegationSource is in the rendered set)
  for (const u of renderedUnits) {
    if (!u.delegationSource) continue;
    if (!renderedUnitIdSet.has(u.delegationSource)) continue;
    edges.push({
      id: `deleg-${u.delegationSource}-${u.unitId}`,
      source: `unit-${u.delegationSource}`,
      target: `unit-${u.unitId}`,
      style: {
        strokeWidth: 1.5,
        strokeDasharray: '5 3',
        stroke: 'var(--color-muted-foreground)',
      },
      data: { edgeKind: 'delegation' } as GraphEdgeMeta,
    });
  }

  // Composition: party-A ↔ party-B (rendered as one directed edge from
  // partyA to partyB; the conflict-resolution colouring carries the
  // intent across both ends).
  for (const c of renderedContracts) {
    if (!renderedAgentSet.has(c.partyA) || !renderedAgentSet.has(c.partyB)) {
      continue;
    }
    edges.push({
      id: `comp-${c.contractId}`,
      source: `agent-${c.partyA}`,
      target: `agent-${c.partyB}`,
      style: {
        strokeWidth: 2,
        stroke: compositionEdgeColour(c.conflictResolution),
      },
      data: {
        edgeKind: 'composition',
        conflictResolution: c.conflictResolution,
      } as GraphEdgeMeta,
    });
  }

  return { nodes, edges, totalNodeCount, truncated };
}

function compositionEdgeColour(conflictResolution: string): string {
  switch (conflictResolution) {
    case 'halt_and_escalate':
      return 'var(--color-amber-500, var(--color-chart-5))';
    case 'default_deny':
      return 'var(--color-destructive)';
    case 'precedence_resolution':
      return 'var(--color-chart-4)';
    default:
      return 'var(--color-border)';
  }
}

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------

function safeParseObject(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  } catch {
    /* fallthrough */
  }
  return {};
}

// ---------------------------------------------------------------------------
// Blast-radius detail
// ---------------------------------------------------------------------------

interface BlastRadiusDetailProps {
  unitId: string;
  report: RevokeImpactReport | null;
  loading: boolean;
  error: string | null;
  windowLabel?: string;
  onClear?: () => void;
  onRerun?: () => void;
  windowChanged?: boolean;
  onViewInLedger: (unitId: string) => void;
}

function formatTimestamp(secondsEpoch: number): string {
  if (!Number.isFinite(secondsEpoch) || secondsEpoch <= 0) return '—';
  return new Date(secondsEpoch * 1000).toISOString();
}

function BlastRadiusDetail({
  unitId,
  report,
  loading,
  error,
  windowLabel,
  onClear,
  onRerun,
  windowChanged = false,
  onViewInLedger,
}: BlastRadiusDetailProps) {
  return (
    <section
      className="mt-4 pt-4 border-t border-border"
      data-testid="graph-blast-radius-section"
    >
      <div className="flex items-start justify-between mb-2">
        <div>
          <p className="text-muted-foreground text-xs">Blast radius</p>
          <h4
            className="text-foreground text-sm font-semibold font-mono break-all"
            data-testid="graph-blast-radius-header"
            // Tooltip explaining the approximation per spec.
            title="Computed from recent ledger permits where this unit was the matched scope. Engine re-evaluation is not performed."
          >
            Blast radius for {unitId}
          </h4>
        </div>
        {onClear && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onClear}
            data-testid="graph-blast-radius-clear"
          >
            Clear
          </Button>
        )}
      </div>

      {loading ? (
        <div data-testid="graph-blast-radius-loading">
          <Skeleton className="h-16 w-full" />
        </div>
      ) : error ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
          data-testid="graph-blast-radius-error"
        >
          <p className="font-mono">{error}</p>
          {onRerun && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRerun}
              className="mt-2"
            >
              Retry
            </Button>
          )}
        </div>
      ) : !report ? (
        <p className="text-xs text-muted-foreground">No blast-radius data.</p>
      ) : report.totalPermits === 0 ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="graph-blast-radius-zero"
        >
          No permits selected this unit in the {windowLabel ?? 'last 1h'}.
          Revocation would not affect any recent dispatches.
        </p>
      ) : (
        <>
          <div
            className="grid grid-cols-3 gap-2 text-xs mb-3"
            data-testid="graph-blast-radius-stats"
          >
            <div>
              <p className="text-muted-foreground">Permits</p>
              <p
                className="text-foreground font-mono font-semibold"
                data-testid="graph-blast-radius-total-permits"
              >
                {report.totalPermits}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Workflows</p>
              <p
                className="text-foreground font-mono font-semibold"
                data-testid="graph-blast-radius-distinct-workflows"
              >
                {report.distinctWorkflows}
              </p>
            </div>
            <div>
              <p className="text-muted-foreground">Agent pairs</p>
              <p
                className="text-foreground font-mono font-semibold"
                data-testid="graph-blast-radius-distinct-pairs"
              >
                {report.distinctAgentPairs}
              </p>
            </div>
          </div>

          <p
            className="text-xs text-muted-foreground mb-2"
            data-testid="graph-blast-radius-count-chip"
          >
            {report.totalPermits} permit
            {report.totalPermits === 1 ? '' : 's'} would have been denied
          </p>

          <div className="flex items-center justify-between mb-2 text-xs">
            <span className="text-muted-foreground">
              Window: {windowLabel ?? 'last 1h'}
            </span>
            {windowChanged && onRerun && (
              <Button
                size="sm"
                variant="outline"
                onClick={onRerun}
                data-testid="graph-blast-radius-rerun"
              >
                <RefreshCw className="size-3" />
                Re-run
              </Button>
            )}
          </div>

          {report.truncated && (
            <div
              className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-500 mb-3"
              data-testid="graph-blast-radius-truncated"
            >
              5000+ permits in window; results truncated
            </div>
          )}

          <Tabs defaultValue="workflows" className="w-full">
            <TabsList className="w-full">
              <TabsTrigger
                value="workflows"
                data-testid="graph-blast-radius-tab-workflows"
              >
                Workflows
              </TabsTrigger>
              <TabsTrigger
                value="pairs"
                data-testid="graph-blast-radius-tab-pairs"
              >
                Agent pairs
              </TabsTrigger>
            </TabsList>
            <TabsContent value="workflows">
              <ul
                className="text-[11px] font-mono text-foreground flex flex-col gap-1 max-h-[200px] overflow-y-auto"
                data-testid="graph-blast-radius-workflows"
              >
                {report.workflows.map((w) => (
                  <li
                    key={w.workflowId}
                    className="flex items-center justify-between gap-2"
                    data-testid={`graph-blast-radius-workflow-${w.workflowId}`}
                  >
                    <div className="min-w-0 flex-1 truncate">
                      <span className="text-foreground">{w.workflowId}</span>{' '}
                      <span className="text-muted-foreground">
                        ({w.permitCount}, {formatTimestamp(w.lastTimestamp)})
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onViewInLedger(w.workflowId)}
                      data-testid={`graph-blast-radius-workflow-view-${w.workflowId}`}
                      aria-label={`View workflow ${w.workflowId} in ledger`}
                    >
                      <ExternalLink className="size-3" />
                    </Button>
                  </li>
                ))}
              </ul>
            </TabsContent>
            <TabsContent value="pairs">
              <ul
                className="text-[11px] font-mono text-foreground flex flex-col gap-1 max-h-[200px] overflow-y-auto"
                data-testid="graph-blast-radius-pairs"
              >
                {report.agentPairs.map((p) => (
                  <li
                    key={`${p.requestingAgent}|${p.targetAgent}`}
                    className="flex items-center justify-between gap-2"
                    data-testid={`graph-blast-radius-pair-${p.requestingAgent}-${p.targetAgent}`}
                  >
                    <div className="min-w-0 flex-1 truncate">
                      <span className="text-foreground">
                        {p.requestingAgent} → {p.targetAgent}
                      </span>{' '}
                      <span className="text-muted-foreground">
                        ({p.permitCount})
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </TabsContent>
          </Tabs>
        </>
      )}
    </section>
  );
}

interface SidePanelProps {
  selection: { nodeId: string; data: GraphNodeData } | null;
  units: AuthorityUnit[];
  contracts: CompositionContract[];
  onClose: () => void;
  onViewInLedger: (unitId: string) => void;
  // blast-radius mode props. When `blastRadiusEnabled` is
  // false, the panel renders behaviour exactly. When true and
  // the selection is a unit, the blast-radius detail mode is appended
  // beneath the unit metadata.
  blastRadiusEnabled?: boolean;
  blastRadiusWindowLabel?: string;
  blastRadiusReport?: RevokeImpactReport | null;
  blastRadiusLoading?: boolean;
  blastRadiusError?: string | null;
  onClearBlastRadius?: () => void;
  onRerunBlastRadius?: () => void;
  blastRadiusWindowChanged?: boolean;
}

function SidePanel({
  selection,
  units,
  contracts,
  onClose,
  onViewInLedger,
  blastRadiusEnabled = false,
  blastRadiusWindowLabel,
  blastRadiusReport = null,
  blastRadiusLoading = false,
  blastRadiusError = null,
  onClearBlastRadius,
  onRerunBlastRadius,
  blastRadiusWindowChanged = false,
}: SidePanelProps) {
  if (!selection) {
    return (
      <Card
        className="p-4 w-[360px] shrink-0 gap-0"
        data-testid="graph-side-panel-empty"
      >
        <p className="text-muted-foreground text-sm">
          Click a node to see its details.
        </p>
      </Card>
    );
  }

  const data = selection.data;

  if (data.kind === 'unit') {
    const u = data.unit;
    const conditions = safeParseObject(u.scope.conditions);
    const limits = safeParseObject(u.scope.limits);
    return (
      <Card
        className="p-4 w-[360px] shrink-0 overflow-y-auto gap-0"
        data-testid="graph-side-panel-unit"
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="text-muted-foreground text-xs">Authority unit</p>
            <h3 className="text-foreground text-base font-semibold font-mono break-all">
              {u.unitId}
            </h3>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        <dl className="text-xs flex flex-col gap-1 mb-3">
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Agent</dt>
            <dd className="text-foreground font-mono truncate">{u.agentId}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Decision type</dt>
            <dd className="text-foreground font-mono">{u.scope.decisionType}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Domain</dt>
            <dd className="text-foreground font-mono">{u.scope.domain}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Risk</dt>
            <dd
              className="text-foreground font-mono"
              data-testid="graph-side-panel-unit-risk"
            >
              {u.riskRating}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Registry</dt>
            <dd className="text-foreground font-mono truncate">
              {u.registryId ?? '—'}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Expires</dt>
            <dd className="text-foreground font-mono">
              {u.expiryTimestamp
                ? new Date(u.expiryTimestamp * 1000).toISOString()
                : 'never'}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Delegation source</dt>
            <dd className="text-foreground font-mono truncate">
              {u.delegationSource ?? '—'}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Re-delegate</dt>
            <dd className="text-foreground font-mono">
              {u.canRedelegate ? 'yes' : 'no'}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Revoked</dt>
            <dd className="text-foreground font-mono">
              {u.revoked ? 'yes' : 'no'}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Valid</dt>
            <dd
              className="text-foreground font-mono"
              data-testid="graph-side-panel-unit-valid"
            >
              {u.isValid ? 'yes' : 'no'}
            </dd>
          </div>
        </dl>

        <details className="mb-3" open>
          <summary className="text-xs font-semibold text-foreground cursor-pointer mb-1">
            Conditions
          </summary>
          <pre
            className="text-[10px] font-mono bg-muted/40 p-2 rounded overflow-x-auto"
            data-testid="graph-side-panel-unit-conditions"
          >
            {JSON.stringify(conditions, null, 2)}
          </pre>
        </details>

        <details className="mb-3" open>
          <summary className="text-xs font-semibold text-foreground cursor-pointer mb-1">
            Limits
          </summary>
          <pre
            className="text-[10px] font-mono bg-muted/40 p-2 rounded overflow-x-auto"
            data-testid="graph-side-panel-unit-limits"
          >
            {JSON.stringify(limits, null, 2)}
          </pre>
        </details>

        <Button
          variant="outline"
          size="sm"
          onClick={() => onViewInLedger(u.unitId)}
          data-testid="graph-side-panel-unit-view-ledger"
        >
          <ExternalLink className="size-3" />
          View in ledger
        </Button>

        {blastRadiusEnabled && (
          <BlastRadiusDetail
            unitId={u.unitId}
            report={blastRadiusReport}
            loading={blastRadiusLoading}
            error={blastRadiusError}
            windowLabel={blastRadiusWindowLabel}
            onClear={onClearBlastRadius}
            onRerun={onRerunBlastRadius}
            windowChanged={blastRadiusWindowChanged}
            onViewInLedger={onViewInLedger}
          />
        )}
      </Card>
    );
  }

  if (data.kind === 'agent') {
    const boundUnits = units.filter((u) => u.agentId === data.agentId);
    const involvedContracts = contracts.filter(
      (c) => c.partyA === data.agentId || c.partyB === data.agentId,
    );
    return (
      <Card
        className="p-4 w-[360px] shrink-0 overflow-y-auto gap-0"
        data-testid="graph-side-panel-agent"
      >
        <div className="flex items-start justify-between mb-3">
          <div>
            <p className="text-muted-foreground text-xs">Agent</p>
            <h3 className="text-foreground text-base font-semibold font-mono break-all">
              {data.agentId}
            </h3>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>

        <p className="text-xs text-muted-foreground mb-2">
          {boundUnits.length} bound unit{boundUnits.length === 1 ? '' : 's'}
        </p>
        <ul
          className="text-xs flex flex-col gap-1 mb-3"
          data-testid="graph-side-panel-agent-units"
        >
          {boundUnits.map((u) => (
            <li
              key={u.unitId}
              className="font-mono text-foreground truncate"
              data-testid={`graph-side-panel-agent-unit-${u.unitId}`}
            >
              {u.unitId} <span className="text-muted-foreground">({u.scope.domain})</span>
            </li>
          ))}
          {boundUnits.length === 0 && (
            <li className="text-muted-foreground">No bound units.</li>
          )}
        </ul>

        <p className="text-xs text-muted-foreground mb-2">
          {involvedContracts.length} contract
          {involvedContracts.length === 1 ? '' : 's'}
        </p>
        <ul
          className="text-xs flex flex-col gap-1"
          data-testid="graph-side-panel-agent-contracts"
        >
          {involvedContracts.map((c) => (
            <li key={c.contractId} className="font-mono text-foreground truncate">
              {c.contractId}{' '}
              <span className="text-muted-foreground">
                ({c.partyA} ↔ {c.partyB})
              </span>
            </li>
          ))}
          {involvedContracts.length === 0 && (
            <li className="text-muted-foreground">No contracts.</li>
          )}
        </ul>
      </Card>
    );
  }

  // Contract
  const c = data.contract;
  const partyAUnits = units.filter((u) => u.agentId === c.partyA);
  const partyBUnits = units.filter((u) => u.agentId === c.partyB);
  return (
    <Card
      className="p-4 w-[360px] shrink-0 overflow-y-auto gap-0"
      data-testid="graph-side-panel-contract"
    >
      <div className="flex items-start justify-between mb-3">
        <div>
          <p className="text-muted-foreground text-xs">Composition contract</p>
          <h3 className="text-foreground text-base font-semibold font-mono break-all">
            {c.contractId}
          </h3>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>

      <dl className="text-xs flex flex-col gap-1 mb-3">
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Party A</dt>
          <dd className="text-foreground font-mono truncate">{c.partyA}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Party B</dt>
          <dd className="text-foreground font-mono truncate">{c.partyB}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Precedence</dt>
          <dd className="text-foreground font-mono">{c.authorityPrecedence}</dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Conflict resolution</dt>
          <dd
            className="text-foreground font-mono"
            data-testid="graph-side-panel-contract-conflict"
          >
            {c.conflictResolution}
          </dd>
        </div>
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Escalation path</dt>
          <dd className="text-foreground font-mono truncate">
            {c.escalationPath ?? '—'}
          </dd>
        </div>
      </dl>

      {c.invariants.length > 0 && (
        <details className="mb-3" open>
          <summary className="text-xs font-semibold text-foreground cursor-pointer mb-1">
            Invariants ({c.invariants.length})
          </summary>
          <ul className="text-[11px] font-mono text-foreground list-disc pl-5">
            {c.invariants.map((inv, i) => (
              <li key={i}>{inv}</li>
            ))}
          </ul>
        </details>
      )}
      {c.stopRights.length > 0 && (
        <details className="mb-3" open>
          <summary className="text-xs font-semibold text-foreground cursor-pointer mb-1">
            Stop rights ({c.stopRights.length})
          </summary>
          <ul className="text-[11px] font-mono text-foreground list-disc pl-5">
            {c.stopRights.map((sr, i) => (
              <li key={i}>{sr}</li>
            ))}
          </ul>
        </details>
      )}

      <p className="text-xs text-muted-foreground mb-1 mt-2">
        Party A units ({partyAUnits.length})
      </p>
      <ul
        className="text-[11px] font-mono text-foreground flex flex-col gap-0.5 mb-2"
        data-testid="graph-side-panel-contract-partyA-units"
      >
        {partyAUnits.map((u) => (
          <li key={u.unitId} className="truncate">
            {u.unitId} <span className="text-muted-foreground">({u.scope.domain})</span>
          </li>
        ))}
        {partyAUnits.length === 0 && (
          <li className="text-muted-foreground">No units.</li>
        )}
      </ul>

      <p className="text-xs text-muted-foreground mb-1">
        Party B units ({partyBUnits.length})
      </p>
      <ul
        className="text-[11px] font-mono text-foreground flex flex-col gap-0.5"
        data-testid="graph-side-panel-contract-partyB-units"
      >
        {partyBUnits.map((u) => (
          <li key={u.unitId} className="truncate">
            {u.unitId} <span className="text-muted-foreground">({u.scope.domain})</span>
          </li>
        ))}
        {partyBUnits.length === 0 && (
          <li className="text-muted-foreground">No units.</li>
        )}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function GovernanceGraph() {
  const navigate = useNavigate();
  const org = useOrganization();
  const isAdmin = !!org.isAdmin;

  const [units, setUnits] = useState<AuthorityUnit[]>([]);
  const [contracts, setContracts] = useState<CompositionContract[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Filters
  const [registryFilter, setRegistryFilter] = useState<string>(REGISTRY_ALL);
  const [domainFilter, setDomainFilter] = useState<string>(DOMAIN_ALL);
  const [includeRevoked, setIncludeRevoked] = useState(false);

  // blast-radius mode. Toggle + time-window are persisted to
  // localStorage so the operator's preference survives page reloads.
  const [blastRadiusEnabled, setBlastRadiusEnabledState] = useState<boolean>(
    () => {
      try {
        return (
          typeof window !== 'undefined' &&
          window.localStorage?.getItem(BLAST_RADIUS_STORAGE_KEY) === 'true'
        );
      } catch {
        return false;
      }
    },
  );
  const [blastRadiusWindow, setBlastRadiusWindowState] = useState<string>(
    () => {
      try {
        if (typeof window === 'undefined') return DEFAULT_BLAST_RADIUS_WINDOW;
        const raw =
          window.localStorage?.getItem(BLAST_RADIUS_WINDOW_STORAGE_KEY) ??
          DEFAULT_BLAST_RADIUS_WINDOW;
        const valid = BLAST_RADIUS_WINDOW_OPTIONS.some(
          (o) => o.value === raw,
        );
        return valid ? raw : DEFAULT_BLAST_RADIUS_WINDOW;
      } catch {
        return DEFAULT_BLAST_RADIUS_WINDOW;
      }
    },
  );

  function setBlastRadiusEnabled(next: boolean): void {
    setBlastRadiusEnabledState(next);
    try {
      window.localStorage?.setItem(
        BLAST_RADIUS_STORAGE_KEY,
        next ? 'true' : 'false',
      );
    } catch {
      /* localStorage unavailable; in-memory only. */
    }
  }

  function setBlastRadiusWindow(next: string): void {
    setBlastRadiusWindowState(next);
    try {
      window.localStorage?.setItem(BLAST_RADIUS_WINDOW_STORAGE_KEY, next);
    } catch {
      /* localStorage unavailable; in-memory only. */
    }
  }

  // The unit currently subject to the blast-radius highlight (independent
  // of the side-panel selection so we can track the highlighted unit
  // across re-renders even if the user clicks Close on the panel).
  const [blastRadiusUnitId, setBlastRadiusUnitId] = useState<string | null>(
    null,
  );
  const [blastRadiusReport, setBlastRadiusReport] =
    useState<RevokeImpactReport | null>(null);
  const [blastRadiusLoading, setBlastRadiusLoading] = useState(false);
  const [blastRadiusError, setBlastRadiusError] = useState<string | null>(null);
  // Window selected at the time of the active fetch — used to detect when
  // the operator changes the window without auto-firing a new fetch (the
  // re-run button surfaces and the user explicitly opts in).
  const [blastRadiusReportWindow, setBlastRadiusReportWindow] =
    useState<string | null>(null);

  // Selection
  const [selection, setSelection] = useState<{
    nodeId: string;
    data: GraphNodeData;
  } | null>(null);

  // authority graph history settings card.
  const [historySettings, setHistorySettings] =
    useState<AuthorityGraphHistorySettings | null>(null);
  const [historySettingsLoading, setHistorySettingsLoading] = useState(false);
  const [historySettingsError, setHistorySettingsError] = useState<
    string | null
  >(null);
  const [historySettingsDialogOpen, setHistorySettingsDialogOpen] =
    useState(false);
  const [historyReloadKey, setHistoryReloadKey] = useState(0);

  // time scrubber state. The scrubber is admin-only and
  // only renders when history is enabled AND at least one snapshot
  // exists in the listing. `scrubberSnapshotId === null` means the
  // operator is viewing live data (the scrubber's `Now` slot).
  const [snapshotSummaries, setSnapshotSummaries] = useState<
    AuthorityGraphSnapshotSummary[]
  >([]);
  const [scrubberSnapshotId, setScrubberSnapshotId] = useState<string | null>(
    null,
  );
  const [scrubberSnapshot, setScrubberSnapshot] =
    useState<AuthorityGraphSnapshot | null>(null);
  const [scrubberSnapshotLoading, setScrubberSnapshotLoading] = useState(false);
  const [scrubberSnapshotError, setScrubberSnapshotError] = useState<
    string | null
  >(null);
  const [showDeltaVsNow, setShowDeltaVsNow] = useState(true);

  // Fetch the history settings in parallel with the graph data on
  // every page mount + after a successful save (via historyReloadKey).
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    setHistorySettingsLoading(true);
    setHistorySettingsError(null);
    governanceService
      .getAuthorityGraphHistorySettings()
      .then((s) => {
        if (cancelled) return;
        setHistorySettings(s);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          err instanceof Error
            ? err.message
            : 'Failed to load authority graph history settings';
        setHistorySettingsError(msg);
      })
      .finally(() => {
        if (!cancelled) setHistorySettingsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, historyReloadKey]);

  // Fetch admin-only data on mount + filter change
  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const args = {
      registryId:
        registryFilter !== REGISTRY_ALL ? registryFilter : null,
      includeRevoked,
    };
    Promise.all([
      governanceService.listAuthorityUnits(args),
      governanceService.listCompositionContracts(),
    ])
      .then(([u, c]) => {
        if (cancelled) return;
        setUnits(u);
        setContracts(c);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          err instanceof Error ? err.message : 'Failed to load authority graph';
        setError(msg);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, registryFilter, includeRevoked, reloadKey]);

  // fetch snapshot summaries when history is enabled. Only
  // fires when `historySettings.enabled` is true; otherwise the
  // scrubber is hidden entirely so there is no point in scanning the
  // snapshots table. Refetches on `historyReloadKey` change so a
  // freshly-saved settings card update refreshes the
  // listing alongside the settings.
  useEffect(() => {
    if (!isAdmin) return;
    if (!historySettings?.enabled) {
      setSnapshotSummaries([]);
      return;
    }
    let cancelled = false;
    governanceService
      .listAuthorityGraphSnapshots()
      .then((s) => {
        if (cancelled) return;
        setSnapshotSummaries(s);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // The card-level error is enough — the scrubber simply hides
        // when no summaries are available; we log to console so an
        // admin investigating in DevTools sees the underlying cause.
        console.error('listAuthorityGraphSnapshots failed', err);
        setSnapshotSummaries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, historySettings?.enabled, historyReloadKey]);

  // fetch the per-snapshot detail when the scrubber is
  // moved off `Now`. Clearing `scrubberSnapshotId` (operator clicks
  // Now) drops the historical snapshot and re-renders against the
  // live data without a fetch.
  useEffect(() => {
    if (!isAdmin) return;
    if (!scrubberSnapshotId) {
      setScrubberSnapshot(null);
      setScrubberSnapshotError(null);
      return;
    }
    let cancelled = false;
    setScrubberSnapshotLoading(true);
    setScrubberSnapshotError(null);
    governanceService
      .getAuthorityGraphSnapshot(scrubberSnapshotId)
      .then((s) => {
        if (cancelled) return;
        setScrubberSnapshot(s);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg =
          err instanceof Error
            ? err.message
            : 'Failed to load historical snapshot';
        setScrubberSnapshotError(msg);
        setScrubberSnapshot(null);
      })
      .finally(() => {
        if (!cancelled) setScrubberSnapshotLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, scrubberSnapshotId]);

  // When viewing a historical snapshot, blast-radius mode is forcibly
  // disabled (the ledger findings used for blast-radius are
  // time-current; mixing them with historical units would mislead).
  useEffect(() => {
    if (scrubberSnapshotId && blastRadiusEnabled) {
      setBlastRadiusEnabled(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubberSnapshotId]);

  // blast-radius fetch helper. Wrapped in useCallback-style
  // closure (inline arrow assigned to a stable name via the dep array)
  // so the effect-driven rerun on time-window change can call it.
  function fetchBlastRadiusFor(unitId: string, windowValue: string): void {
    const opt = BLAST_RADIUS_WINDOW_OPTIONS.find(
      (o) => o.value === windowValue,
    );
    if (!opt) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const sinceTs = nowSec - opt.seconds;
    setBlastRadiusLoading(true);
    setBlastRadiusError(null);
    setBlastRadiusReportWindow(windowValue);
    governanceService
      .getRevokeImpact({ unitId, sinceTs, untilTs: nowSec })
      .then((report) => {
        setBlastRadiusReport(report);
      })
      .catch((err: unknown) => {
        const msg =
          err instanceof Error ? err.message : 'Failed to load blast radius';
        setBlastRadiusError(msg);
        setBlastRadiusReport(null);
      })
      .finally(() => {
        setBlastRadiusLoading(false);
      });
  }

  function handleClearBlastRadius(): void {
    setBlastRadiusUnitId(null);
    setBlastRadiusReport(null);
    setBlastRadiusError(null);
    setBlastRadiusReportWindow(null);
  }

  // When the operator turns blast-radius mode OFF, drop any active
  // highlight + report so the graph snaps back to the neutral
  // state.
  useEffect(() => {
    if (!blastRadiusEnabled) {
      handleClearBlastRadius();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blastRadiusEnabled]);

  // Apply the domain filter client-side. The registry filter is server-side
  // (it changes the listAuthorityUnits args). includeRevoked is server-side.
  //
  // when a historical snapshot is selected the source of
  // truth for the graph rendering is the snapshot's `authorityUnits` /
  // `compositionContracts`, NOT the live data. Filters still apply to
  // the snapshot view client-side so operators can drill into a domain
  // within the historical scene.
  const renderUnits = useMemo<AuthorityUnit[]>(() => {
    if (scrubberSnapshotId && scrubberSnapshot) {
      return scrubberSnapshot.authorityUnits;
    }
    return units;
  }, [scrubberSnapshotId, scrubberSnapshot, units]);

  const renderContracts = useMemo<CompositionContract[]>(() => {
    if (scrubberSnapshotId && scrubberSnapshot) {
      return scrubberSnapshot.compositionContracts;
    }
    return contracts;
  }, [scrubberSnapshotId, scrubberSnapshot, contracts]);

  const filteredUnits = useMemo(() => {
    if (domainFilter === DOMAIN_ALL) return renderUnits;
    return renderUnits.filter((u) => u.scope.domain === domainFilter);
  }, [renderUnits, domainFilter]);

  // delta vs Now. The Set membership drives ghost-marker
  // rendering for added units / contracts when the toggle is ON.
  const graphDelta = useMemo<GraphDelta | null>(() => {
    if (!scrubberSnapshotId || !scrubberSnapshot) return null;
    return computeGraphDelta(
      scrubberSnapshot.authorityUnits,
      scrubberSnapshot.compositionContracts,
      units,
      contracts,
    );
  }, [scrubberSnapshotId, scrubberSnapshot, units, contracts]);

  // Domains derived from the loaded units (post-server-filter, pre-domain
  // filter). Sorted for stable render order.
  const availableDomains = useMemo(() => {
    const set = new Set<string>();
    for (const u of units) set.add(u.scope.domain);
    return Array.from(set).sort();
  }, [units]);

  // Registry IDs derived from the loaded units. Includes '*GLOBAL*' if any
  // unit has it. The `__ALL__` sentinel is added by the Select renderer.
  const availableRegistries = useMemo(() => {
    const set = new Set<string>();
    for (const u of units) {
      if (u.registryId !== null) set.add(u.registryId);
    }
    return Array.from(set).sort();
  }, [units]);

  // Build nodes + edges and run the d3-force simulation.
  // Memoised on the filtered data identity so unrelated re-renders don't
  // re-run the simulation.
  const built = useMemo(() => {
    return buildGraph(filteredUnits, renderContracts);
  }, [filteredUnits, renderContracts]);

  const positionedNodes = useMemo(() => {
    if (built.nodes.length === 0) return built.nodes;
    const layoutInputs = built.nodes.map((n) => ({
      id: n.id,
      kind: (n.data as GraphNodeData).kind,
    }));
    const layoutLinks = built.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
    }));
    const layout = computeLayout(layoutInputs, layoutLinks);
    return built.nodes.map((n) => {
      const pos = layout.get(n.id);
      if (!pos) return n;
      return { ...n, position: { x: pos.x, y: pos.y } };
    });
  }, [built]);

  // apply destructive border + thick stroke to the unit
  // currently in the blast-radius highlight; fade non-incident edges to
  // 30% opacity and re-stroke incident edges with the destructive token.
  // The ReactFlow node already encodes its own `riskBorderClass`; the
  // highlight is overlaid via a `data-blast-radius-selected` attribute
  // and a Tailwind ring class on the wrapper div, kept token-based.
  const highlightedNodeId = blastRadiusEnabled && blastRadiusUnitId
    ? `unit-${blastRadiusUnitId}`
    : null;

  const displayNodes = useMemo(() => {
    let result = positionedNodes;
    if (blastRadiusEnabled && blastRadiusUnitId) {
      result = result.map((n) => {
        if (n.id !== highlightedNodeId) return n;
        // Inject a `ring-destructive` className to mark the highlighted
        // unit. Token-based — no inline colour literals. The class is
        // applied to the ReactFlow node wrapper, so the inner UnitNode
        // renderer continues to own its own border styling.
        return {
          ...n,
          className: 'ring-4 ring-destructive/60 rounded-full',
        };
      });
    }
    // overlay added-since units as faded ghost markers
    // when the operator is scrubbed back AND the `Show delta vs Now`
    // toggle is ON. Ghost markers carry `data-ghost-marker` so tests
    // and CSS can target them; the chart-2 token + dashed border
    // (added through the wrapper className) keeps colours token-based.
    if (
      scrubberSnapshotId &&
      scrubberSnapshot &&
      showDeltaVsNow &&
      graphDelta
    ) {
      const ghosts: Node<GraphNodeData>[] = [];
      let ghostIdx = 0;
      for (const u of units) {
        if (!graphDelta.addedUnits.has(u.unitId)) continue;
        ghosts.push({
          id: `ghost-unit-${u.unitId}`,
          type: 'unitNode',
          position: {
            x: CANVAS_WIDTH - 80,
            y: 40 + ghostIdx * 70,
          },
          data: {
            kind: 'unit',
            unit: u,
            paletteToken: domainPaletteToken(u.scope.domain),
            isWildcard: false,
          },
          className:
            'opacity-50 ring-2 ring-dashed ring-chart-2/60 rounded-full',
          draggable: false,
          selectable: false,
        });
        ghostIdx += 1;
      }
      if (ghosts.length > 0) {
        result = [...result, ...ghosts];
      }
    }
    return result;
  }, [
    positionedNodes,
    blastRadiusEnabled,
    blastRadiusUnitId,
    highlightedNodeId,
    scrubberSnapshotId,
    scrubberSnapshot,
    showDeltaVsNow,
    graphDelta,
    units,
  ]);

  const displayEdges = useMemo(() => {
    let edges = built.edges;
    if (blastRadiusEnabled && blastRadiusUnitId) {
      const targetNodeId = `unit-${blastRadiusUnitId}`;
      edges = edges.map((e) => {
        const incident = e.source === targetNodeId || e.target === targetNodeId;
        if (incident) {
          return {
            ...e,
            style: {
              ...(e.style ?? {}),
              stroke: 'var(--color-destructive)',
              strokeWidth: 4,
              opacity: 1,
            },
          };
        }
        return {
          ...e,
          style: {
            ...(e.style ?? {}),
            opacity: 0.3,
          },
        };
      });
    }
    return edges;
  }, [built.edges, blastRadiusEnabled, blastRadiusUnitId]);

  // Stats line
  const renderedAgents = positionedNodes.filter(
    (n) => (n.data as GraphNodeData).kind === 'agent',
  ).length;
  const renderedUnits = positionedNodes.filter(
    (n) => (n.data as GraphNodeData).kind === 'unit',
  ).length;
  const renderedContracts = positionedNodes.filter(
    (n) => (n.data as GraphNodeData).kind === 'contract',
  ).length;
  const distinctDomains = new Set(
    filteredUnits.map((u) => u.scope.domain),
  ).size;

  if (!isAdmin) {
    return (
      <PageContainer className="flex-1 flex flex-col bg-background">
        <GovernanceBreadcrumbs title="Authority graph" />
        <div className="mb-6">
          <h2 className="text-foreground text-2xl font-semibold mb-2">
            Authority graph
          </h2>
          <p className="text-muted-foreground text-sm">
            Visualize agents, authority units, and composition contracts.
            Click any node for details.
          </p>
        </div>
        <div
          className="rounded-lg border border-chart-2/40 bg-chart-2/20 p-6 text-sm text-foreground"
          data-testid="graph-admin-only"
        >
          Admin only — authority graph requires admin access
        </div>
      </PageContainer>
    );
  }

  const showRegistrySelector =
    availableRegistries.length > 1 || registryFilter !== REGISTRY_ALL;

  return (
    <PageContainer className="flex-1 flex flex-col bg-background">
      <GovernanceBreadcrumbs title="Authority graph" />
      <div className="mb-6">
        <h2 className="text-foreground text-2xl font-semibold mb-2">
          Authority graph
        </h2>
        <p className="text-muted-foreground text-sm">
          Visualize agents, authority units, and composition contracts. Click
          any node for details.
        </p>
      </div>

      {/* authority graph history settings card. Admin-only;
          this whole page is already admin-gated above. */}
      <Card
        className="mb-3 flex-row flex-wrap items-center gap-3 px-3 py-2"
        data-testid="authority-graph-history-card"
      >
        {historySettings ? (
          <>
            <span
              className={
                historySettings.enabled
                  ? 'rounded-md bg-chart-2/30 text-foreground px-2 py-0.5 text-xs font-mono'
                  : 'rounded-md bg-muted text-muted-foreground px-2 py-0.5 text-xs font-mono'
              }
              data-testid="authority-graph-history-status-pill"
              data-history-enabled={historySettings.enabled ? 'true' : 'false'}
            >
              History: {historySettings.enabled ? 'ENABLED' : 'DISABLED'}
            </span>
            {historySettings.enabled ? (
              <span
                className="text-xs text-muted-foreground"
                data-testid="authority-graph-history-detail"
              >
                Last snapshot: {historySettings.lastSnapshotAt ?? '—'} •{' '}
                {historySettings.snapshotCountInWindow} snapshots in window •{' '}
                {historySettings.storageEstimate ?? '—'}
              </span>
            ) : (
              <span
                className="text-xs text-muted-foreground"
                data-testid="authority-graph-history-detail"
              >
                Time scrubber requires history. Click Configure
                to enable.
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setHistorySettingsDialogOpen(true)}
              data-testid="authority-graph-history-configure"
              className="ml-auto"
            >
              Configure
            </Button>
          </>
        ) : historySettingsLoading ? (
          <span
            className="text-xs text-muted-foreground"
            data-testid="authority-graph-history-loading"
          >
            Loading history settings…
          </span>
        ) : historySettingsError ? (
          <span
            className="text-xs text-destructive"
            data-testid="authority-graph-history-error"
          >
            {historySettingsError}
          </span>
        ) : null}
      </Card>

      {historySettings && (
        <AuthorityGraphHistorySettingsDialog
          open={historySettingsDialogOpen}
          onOpenChange={setHistorySettingsDialogOpen}
          currentSettings={historySettings}
          onSaved={() => {
            // Refetch settings so the card reflects the freshly written
            // values + recomputed snapshot count.
            setHistoryReloadKey((k) => k + 1);
          }}
        />
      )}

      <div
        className="flex flex-wrap items-center gap-4 mb-3"
        data-testid="graph-filter-bar"
      >
        {showRegistrySelector && (
          <div className="flex items-center gap-2">
            <Label htmlFor="graph-registry-trigger" className="text-xs">
              Registry
            </Label>
            <Select
              value={registryFilter}
              onValueChange={(v) => setRegistryFilter(v)}
            >
              <SelectTrigger
                id="graph-registry-trigger"
                className="w-[180px]"
                data-testid="graph-registry-select"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={REGISTRY_ALL}>All registries</SelectItem>
                <SelectItem value={GLOBAL_REGISTRY_ID}>
                  *GLOBAL* (platform-wide)
                </SelectItem>
                {availableRegistries
                  .filter((r) => r !== GLOBAL_REGISTRY_ID)
                  .map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Label htmlFor="graph-domain-trigger" className="text-xs">
            Domain
          </Label>
          <Select
            value={domainFilter}
            onValueChange={(v) => setDomainFilter(v)}
          >
            <SelectTrigger
              id="graph-domain-trigger"
              className="w-[160px]"
              data-testid="graph-domain-select"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DOMAIN_ALL}>All domains</SelectItem>
              {availableDomains.map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <Switch
            id="graph-include-revoked"
            checked={includeRevoked}
            onCheckedChange={(c) => setIncludeRevoked(c)}
            data-testid="graph-include-revoked-toggle"
            aria-label="Include revoked units"
          />
          <Label htmlFor="graph-include-revoked" className="text-xs">
            Include revoked
          </Label>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => setReloadKey((k) => k + 1)}
          data-testid="graph-refresh"
        >
          <RefreshCw className="size-3" />
          Refresh
        </Button>

        <div className="flex items-center gap-2">
          <Switch
            id="graph-blast-radius-mode"
            checked={blastRadiusEnabled}
            onCheckedChange={(c) => setBlastRadiusEnabled(c)}
            disabled={!!scrubberSnapshotId}
            data-testid="graph-blast-radius-toggle"
            aria-label="Blast-radius mode"
            title={
              scrubberSnapshotId
                ? 'Blast-radius is disabled when viewing a historical snapshot.'
                : undefined
            }
          />
          <Label htmlFor="graph-blast-radius-mode" className="text-xs">
            Blast-radius mode
          </Label>
        </div>

        {blastRadiusEnabled && !scrubberSnapshotId && (
          <div className="flex items-center gap-2">
            <Label htmlFor="graph-blast-radius-window-trigger" className="text-xs">
              Window
            </Label>
            <Select
              value={blastRadiusWindow}
              onValueChange={(v) => setBlastRadiusWindow(v)}
            >
              <SelectTrigger
                id="graph-blast-radius-window-trigger"
                className="w-[140px]"
                data-testid="graph-blast-radius-window-select"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BLAST_RADIUS_WINDOW_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* time scrubber bar (admin-only). Visible when
          history is enabled AND at least one snapshot exists. Hidden
          state surfaces an inline notice so the operator knows why the
          scrubber is missing. */}
      {isAdmin &&
        (historySettings?.enabled && snapshotSummaries.length > 0 ? (
          <Card
            className="mb-3 gap-2 px-3 py-2"
            data-testid="graph-time-scrubber"
            data-scrubber-active={scrubberSnapshotId ? 'true' : 'false'}
          >
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-semibold text-foreground">
                Time-machine
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setScrubberSnapshotId(null)}
                disabled={scrubberSnapshotId === null}
                data-testid="graph-scrubber-now"
              >
                Now
              </Button>
              <Slider
                min={0}
                max={snapshotSummaries.length}
                step={1}
                value={[
                  scrubberSnapshotId === null
                    ? snapshotSummaries.length
                    : Math.max(
                        0,
                        snapshotSummaries.findIndex(
                          (s) => s.snapshotId === scrubberSnapshotId,
                        ),
                      ),
                ]}
                onValueChange={([idx]) => {
                  if (idx >= snapshotSummaries.length) {
                    setScrubberSnapshotId(null);
                  } else {
                    const s = snapshotSummaries[idx];
                    if (s) setScrubberSnapshotId(s.snapshotId);
                  }
                }}
                className="flex-1 min-w-[160px]"
                data-testid="graph-scrubber-slider"
                aria-label="Authority graph time scrubber"
              />
              <span
                className="text-xs text-muted-foreground font-mono"
                data-testid="graph-scrubber-position"
                title={
                  scrubberSnapshotId
                    ? new Date(
                        (snapshotSummaries.find(
                          (s) => s.snapshotId === scrubberSnapshotId,
                        )?.timestamp ?? 0) * 1000,
                      ).toISOString()
                    : 'Now (live data)'
                }
              >
                {scrubberSnapshotId
                  ? `viewing snapshot ${
                      snapshotSummaries.findIndex(
                        (s) => s.snapshotId === scrubberSnapshotId,
                      ) + 1
                    } of ${snapshotSummaries.length}`
                  : `Now • ${snapshotSummaries.length} snapshot${
                      snapshotSummaries.length === 1 ? '' : 's'
                    } available`}
              </span>
            </div>
            {scrubberSnapshotId && (
              <div className="flex items-center gap-2">
                <Switch
                  id="graph-scrubber-show-delta"
                  checked={showDeltaVsNow}
                  onCheckedChange={(c) => setShowDeltaVsNow(c)}
                  data-testid="graph-scrubber-show-delta"
                  aria-label="Show delta vs Now"
                />
                <Label
                  htmlFor="graph-scrubber-show-delta"
                  className="text-xs"
                >
                  Show delta vs Now
                </Label>
              </div>
            )}
            {scrubberSnapshotLoading && (
              <span
                className="text-xs text-muted-foreground"
                data-testid="graph-scrubber-loading"
              >
                Loading historical snapshot…
              </span>
            )}
            {scrubberSnapshotError && (
              <span
                className="text-xs text-destructive"
                data-testid="graph-scrubber-error"
              >
                {scrubberSnapshotError}
              </span>
            )}
          </Card>
        ) : historySettings ? (
          <p
            className="mb-3 text-xs text-muted-foreground"
            data-testid="graph-time-scrubber-notice"
          >
            Time scrubber requires history.{' '}
            {historySettings.enabled
              ? 'No snapshots captured yet — first snapshot at 03:00 UTC daily.'
              : 'Enable history in settings to use the scrubber.'}
          </p>
        ) : null)}

      <p
        className="text-xs text-muted-foreground mb-3"
        data-testid="graph-stats"
      >
        {renderedAgents} agent{renderedAgents === 1 ? '' : 's'} •{' '}
        {renderedUnits} unit{renderedUnits === 1 ? '' : 's'} •{' '}
        {renderedContracts} contract{renderedContracts === 1 ? '' : 's'} •{' '}
        {distinctDomains} domain{distinctDomains === 1 ? '' : 's'}
      </p>

      {built.truncated && (
        <p
          className="text-xs text-amber-500 mb-3"
          data-testid="graph-truncation-notice"
        >
          Showing first {RENDER_NODE_CAP} of {built.totalNodeCount} nodes;
          tighten filters to see all
        </p>
      )}

      {loading ? (
        <div className="flex flex-col gap-3" data-testid="graph-loading">
          <Skeleton className="h-[420px] w-full" />
        </div>
      ) : error ? (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
          data-testid="graph-error"
        >
          <p className="mb-2">Failed to load authority graph</p>
          <p className="text-xs font-mono mb-3">{error}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            Retry
          </Button>
        </div>
      ) : positionedNodes.length === 0 ? (
        <Card
          className="p-8 text-sm text-muted-foreground"
          data-testid="graph-empty-state"
        >
          No authority units in this view. Try clearing filters or unchecking
          'Include revoked'.
        </Card>
      ) : (
        <div className="flex gap-4 flex-1">
          <Card
            className={`flex-1 h-[480px] relative gap-0 p-0${
              blastRadiusEnabled ? ' cursor-crosshair' : ''
            }`}
            data-testid="graph-canvas"
            data-blast-radius-mode={blastRadiusEnabled ? 'true' : 'false'}
          >
            <ReactFlow
              nodes={displayNodes}
              edges={displayEdges}
              nodeTypes={nodeTypes}
              panOnDrag
              panOnScroll
              zoomOnScroll
              zoomOnPinch
              zoomOnDoubleClick={false}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable
              proOptions={{ hideAttribution: true }}
              onNodeClick={(_evt, node) => {
                const data = node.data as GraphNodeData;
                setSelection({
                  nodeId: node.id,
                  data,
                });
                if (blastRadiusEnabled && data.kind === 'unit') {
                  setBlastRadiusUnitId(data.unit.unitId);
                  fetchBlastRadiusFor(data.unit.unitId, blastRadiusWindow);
                }
              }}
              fitView
              fitViewOptions={{ padding: 0.1 }}
            />
            {blastRadiusEnabled && blastRadiusLoading && (
              <div
                className="absolute inset-0 flex items-center justify-center pointer-events-none"
                data-testid="graph-blast-radius-canvas-loading"
              >
                <Card className="bg-card/80 px-3 py-1 text-xs text-foreground">
                  Loading blast radius…
                </Card>
              </div>
            )}
          </Card>
          <SidePanel
            selection={selection}
            units={renderUnits}
            contracts={renderContracts}
            onClose={() => setSelection(null)}
            onViewInLedger={(unitId) =>
              navigate(
                `/governance/ledger?scopeEvaluated=${encodeURIComponent(unitId)}`,
              )
            }
            blastRadiusEnabled={blastRadiusEnabled}
            blastRadiusWindowLabel={
              BLAST_RADIUS_WINDOW_OPTIONS.find(
                (o) => o.value === blastRadiusWindow,
              )?.label
            }
            blastRadiusReport={blastRadiusReport}
            blastRadiusLoading={blastRadiusLoading}
            blastRadiusError={blastRadiusError}
            onClearBlastRadius={handleClearBlastRadius}
            onRerunBlastRadius={() => {
              if (blastRadiusUnitId) {
                fetchBlastRadiusFor(blastRadiusUnitId, blastRadiusWindow);
              }
            }}
            blastRadiusWindowChanged={
              blastRadiusReportWindow !== null &&
              blastRadiusReportWindow !== blastRadiusWindow
            }
          />
        </div>
      )}
    </PageContainer>
  );
}

export default GovernanceGraph;
