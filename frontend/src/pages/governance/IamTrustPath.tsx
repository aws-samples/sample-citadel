/**
 * Governance IAM trust path
 *
 * Admin-only audit of the IAM assume chain that an admin Lambda follows
 * to reach a target resource (datastore / integration / agent). Renders
 * the two-hop chain (Lambda exec role → optional cross-account role →
 * scoped role) as a horizontal ReactFlow pipeline; clicking a hop opens
 * a side drawer with the trust policy principals + inline policy
 * statements.
 *
 * Drift detection + simulate-principal-policy effective-permissions
 * overlay are reserved for a future iteration — the footer note documents the
 * gap so operators don't expect them in this slice.
 *
 * Reuses the @xyflow/react dependency added by Tracer.tsx
 * for the canvas. ReactFlow is mocked as inert in tests via the same
 * pattern as governance-graph.test.tsx.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Handle,
  Position,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Clipboard, ExternalLink } from 'lucide-react';
import { PageContainer } from '../../components/PageContainer';
import { GovernanceBreadcrumbs } from '../../components/governance/GovernanceBreadcrumbs';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import { Skeleton } from '../../components/ui/skeleton';
import { Card } from '../../components/ui/card';
import { Alert, AlertDescription } from '../../components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '../../components/ui/sheet';
import { useOrganization } from '../../contexts/OrganizationContext';
import {
  governanceService,
  TrustPathReport,
  TrustPathRole,
  TrustPathPolicyStatement,
  IamDriftReport,
  IamDriftActionGroup,
} from '../../services/governanceService';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type ResourceType = 'agent' | 'datastore' | 'integration';
const RESOURCE_TYPES: ReadonlyArray<{ value: ResourceType; label: string }> = [
  { value: 'agent', label: 'Agent' },
  { value: 'datastore', label: 'Data store' },
  { value: 'integration', label: 'Integration' },
];

const RECENTS_STORAGE_KEY = 'governance.iam-trust-path.recents';
const RECENTS_MAX = 10;

const HORIZONTAL_GAP = 280;
const ROW_Y = 80;

// Scope → tailwind utility classes. No literal colour values, mirroring
// the Tracer.tsx convention.
function scopeBadgeVariant(scope: string): 'success' | 'warning' | 'secondary' | 'outline' | 'destructive' {
  switch (scope) {
    case 'lambda':
      return 'secondary';
    case 'cross-account':
      return 'warning';
    case 'datastore':
    case 'integration':
    case 'agent':
      return 'success';
    default:
      return 'outline';
  }
}

function scopeNodeBackground(scope: string): string {
  switch (scope) {
    case 'lambda':
      return 'bg-muted/60';
    case 'cross-account':
      return 'bg-amber-500/15';
    case 'datastore':
    case 'integration':
    case 'agent':
      return 'bg-chart-2/15';
    default:
      return 'bg-muted/30';
  }
}

function scopeNodeBorder(scope: string): string {
  switch (scope) {
    case 'lambda':
      return 'border-border';
    case 'cross-account':
      return 'border-amber-500/50';
    case 'datastore':
    case 'integration':
    case 'agent':
      return 'border-chart-2/40';
    default:
      return 'border-border/40 border-dashed';
  }
}

// ---------------------------------------------------------------------------
// LocalStorage recents helpers (admin session)
// ---------------------------------------------------------------------------

interface RecentEntry {
  resourceType: ResourceType;
  resourceId: string;
}

export function loadRecents(): RecentEntry[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: RecentEntry[] = [];
    for (const entry of parsed) {
      if (
        entry &&
        typeof entry.resourceType === 'string' &&
        typeof entry.resourceId === 'string' &&
        entry.resourceId.length > 0
      ) {
        out.push({
          resourceType: entry.resourceType as ResourceType,
          resourceId: entry.resourceId,
        });
      }
    }
    return out.slice(0, RECENTS_MAX);
  } catch {
    return [];
  }
}

export function saveRecents(entries: RecentEntry[]): void {
  try {
    window.localStorage.setItem(
      RECENTS_STORAGE_KEY,
      JSON.stringify(entries.slice(0, RECENTS_MAX)),
    );
  } catch {
    /* swallow — quota / private mode falls back to in-memory state */
  }
}

export function pushRecent(
  current: RecentEntry[],
  entry: RecentEntry,
): RecentEntry[] {
  const filtered = current.filter(
    (e) =>
      !(e.resourceType === entry.resourceType && e.resourceId === entry.resourceId),
  );
  filtered.unshift(entry);
  return filtered.slice(0, RECENTS_MAX);
}

// ---------------------------------------------------------------------------
// IAM console deep-link
// ---------------------------------------------------------------------------

function iamConsoleUrl(arn: string): string | null {
  // Match the role name out of `arn:aws:iam::<acct>:role/<path?/<name>`.
  const match = arn.match(/^arn:aws:iam::\d+:role\/(.+)$/);
  if (!match) return null;
  const roleName = match[1];
  return `https://us-east-1.console.aws.amazon.com/iam/home?region=us-east-1#/roles/details/${encodeURIComponent(roleName)}`;
}

// ---------------------------------------------------------------------------
// Hop node renderer
// ---------------------------------------------------------------------------

interface HopNodeData extends Record<string, unknown> {
  hop: TrustPathRole;
  selected: boolean;
}

function HopNode({ data }: NodeProps<Node<HopNodeData>>) {
  const { hop, selected } = data;
  const bg = scopeNodeBackground(hop.scope);
  const border = scopeNodeBorder(hop.scope);
  const ring = selected ? 'ring-2 ring-primary' : '';
  return (
    <div
      className={`rounded-lg border p-3 w-[240px] ${bg} ${border} ${ring}`}
      data-testid={`iam-hop-node-${hop.scope}`}
      data-hop-arn={hop.arn}
    >
      <Handle type="target" position={Position.Left} className="!opacity-0" />
      <div className="flex items-center gap-2 mb-2">
        <Badge
          variant={scopeBadgeVariant(hop.scope)}
          className="text-[10px] capitalize"
        >
          {hop.scope}
        </Badge>
      </div>
      <p
        className="text-foreground text-sm font-mono mb-2 truncate"
        title={hop.name}
        data-testid={`iam-hop-name-${hop.scope}`}
      >
        {hop.name}
      </p>
      <div className="flex flex-wrap gap-1 text-[10px]">
        <span
          className="px-1.5 py-0.5 rounded bg-background/80 text-foreground border border-border"
          data-testid={`iam-hop-actions-${hop.scope}`}
        >
          {hop.totalActions} actions • {hop.totalResources} resources
        </span>
        <span
          className="px-1.5 py-0.5 rounded bg-background/80 text-muted-foreground border border-border"
          data-testid={`iam-hop-principals-${hop.scope}`}
        >
          {hop.trustPolicyPrincipals.length} principals
        </span>
      </div>
      <Handle type="source" position={Position.Right} className="!opacity-0" />
    </div>
  );
}

const nodeTypes = { iamHopNode: HopNode };

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

interface BuiltCanvas {
  nodes: Node<HopNodeData>[];
  edges: Edge[];
}

export function buildHopNodesAndEdges(
  hops: TrustPathRole[],
  selectedIndex: number | null,
): BuiltCanvas {
  const nodes: Node<HopNodeData>[] = hops.map((hop, idx) => ({
    id: `hop-${idx}`,
    type: 'iamHopNode',
    position: { x: idx * HORIZONTAL_GAP, y: ROW_Y },
    data: { hop, selected: selectedIndex === idx },
    draggable: false,
    selectable: true,
  }));
  const edges: Edge[] = [];
  for (let i = 0; i < hops.length - 1; i++) {
    edges.push({
      id: `e-${i}-${i + 1}`,
      source: `hop-${i}`,
      target: `hop-${i + 1}`,
      label: 'sts:AssumeRole',
      labelStyle: {
        fontSize: 10,
        fill: 'var(--color-muted-foreground)',
      },
      style: {
        strokeDasharray: '4 4',
        strokeWidth: 1.25,
        stroke: 'var(--color-border)',
      },
      data: { edgeKind: 'assume-role' },
    });
  }
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Hop drawer
// ---------------------------------------------------------------------------

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        try {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        } catch {
          /* no-op */
        }
      }}
      data-testid={`iam-copy-${label}`}
      aria-label={`Copy ${label}`}
    >
      <Clipboard className="size-3" />
      {copied ? <span className="ml-1 text-[10px]">Copied</span> : null}
    </Button>
  );
}

function PolicyStatementCard({
  statement,
  index,
}: {
  statement: TrustPathPolicyStatement;
  index: number;
}) {
  const effectVariant: 'success' | 'destructive' | 'secondary' =
    statement.effect === 'Allow'
      ? 'success'
      : statement.effect === 'Deny'
        ? 'destructive'
        : 'secondary';
  let prettyConditions: string | null = null;
  if (statement.conditionsJson) {
    try {
      prettyConditions = JSON.stringify(
        JSON.parse(statement.conditionsJson),
        null,
        2,
      );
    } catch {
      prettyConditions = statement.conditionsJson;
    }
  }
  return (
    <Card
      className="rounded-md p-3 mb-2 gap-0"
      data-testid={`iam-policy-statement-${index}`}
    >
      <div className="flex items-center gap-2 mb-2">
        <Badge variant={effectVariant} className="text-[10px]">
          {statement.effect}
        </Badge>
        <span className="text-muted-foreground text-xs">
          Statement #{index + 1}
        </span>
      </div>
      <div className="mb-2">
        <p className="text-muted-foreground text-xs mb-1">Actions</p>
        <ul className="flex flex-col gap-0.5">
          {statement.actions.map((a, i) => (
            <li
              key={`a-${i}`}
              className="text-foreground text-xs font-mono break-all"
            >
              {a}
            </li>
          ))}
        </ul>
      </div>
      <div className="mb-2">
        <p className="text-muted-foreground text-xs mb-1">Resources</p>
        <ul className="flex flex-col gap-0.5">
          {statement.resources.map((r, i) => (
            <li
              key={`r-${i}`}
              className="text-foreground text-xs font-mono break-all"
            >
              {r}
            </li>
          ))}
        </ul>
      </div>
      {prettyConditions !== null && (
        <div>
          <p className="text-muted-foreground text-xs mb-1">Conditions</p>
          <pre
            className="text-foreground text-xs font-mono bg-muted/50 p-2 rounded border border-border whitespace-pre-wrap break-all"
            data-testid={`iam-policy-conditions-${index}`}
          >
            {prettyConditions}
          </pre>
        </div>
      )}
    </Card>
  );
}

function DriftActionGroupCard({
  group,
  index,
}: {
  group: IamDriftActionGroup;
  index: number;
}) {
  return (
    <Card
      className="p-3 mb-2 gap-2"
      data-testid={`iam-drift-group-${index}`}
    >
      <p
        className="text-foreground text-xs font-mono break-all"
        data-testid={`iam-drift-group-arn-${index}`}
      >
        {group.resourceArnPattern}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="text-muted-foreground text-[11px] mb-1">
            Excess actions
          </p>
          {group.excessActions.length === 0 ? (
            <p className="text-muted-foreground text-[11px] italic">None</p>
          ) : (
            <div
              className="flex flex-wrap gap-1"
              data-testid={`iam-drift-excess-${index}`}
            >
              {group.excessActions.map((a, i) => (
                <Badge
                  key={`ex-${i}`}
                  variant="destructive"
                  className="text-[10px] font-mono"
                >
                  {a}
                </Badge>
              ))}
            </div>
          )}
        </div>
        <div>
          <p className="text-muted-foreground text-[11px] mb-1">
            Missing actions
          </p>
          {group.missingActions.length === 0 ? (
            <p className="text-muted-foreground text-[11px] italic">None</p>
          ) : (
            <div
              className="flex flex-wrap gap-1"
              data-testid={`iam-drift-missing-${index}`}
            >
              {group.missingActions.map((a, i) => (
                <span
                  key={`mi-${i}`}
                  className="inline-flex items-center rounded-md border border-transparent px-2 py-0.5 text-[10px] font-mono bg-amber-500/20 text-amber-700"
                >
                  {a}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <p
        className="text-muted-foreground text-[11px]"
        data-testid={`iam-drift-counts-${index}`}
      >
        Declared: {group.declaredActions.length}, Effective:{' '}
        {group.effectiveActions.length}
      </p>
    </Card>
  );
}

function DriftSection({
  driftReport,
  driftLoading,
  driftError,
  onCheckDrift,
}: {
  driftReport: IamDriftReport | null;
  driftLoading: boolean;
  driftError: string | null;
  onCheckDrift: () => void;
}) {
  return (
    <div data-testid="iam-drift-section">
      <p className="text-muted-foreground text-xs mb-2">Drift detection</p>
      <Button
        variant="outline"
        size="sm"
        onClick={onCheckDrift}
        disabled={driftLoading}
        data-testid="iam-drift-check-button"
      >
        {driftLoading ? 'Checking…' : 'Check drift'}
      </Button>

      {driftLoading && (
        <Skeleton
          className="h-[60px] w-full mt-3"
          data-testid="iam-drift-skeleton"
        />
      )}

      {driftError && !driftLoading && (
        <Alert
          variant="destructive"
          className="mt-3"
          data-testid="iam-drift-error"
        >
          <AlertDescription>{driftError}</AlertDescription>
        </Alert>
      )}

      {driftReport && !driftLoading && (
        <div className="mt-3 flex flex-col gap-3" data-testid="iam-drift-result">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium ${
                driftReport.hasDrift
                  ? 'bg-destructive text-white'
                  : 'bg-chart-2 text-white'
              }`}
              data-testid="iam-drift-status-badge"
            >
              {driftReport.hasDrift ? 'Drift detected' : 'In sync'}
            </span>
            <span
              className="text-muted-foreground text-xs"
              data-testid="iam-drift-stats"
            >
              {driftReport.totalExcess} excess action(s),{' '}
              {driftReport.totalMissing} missing action(s)
            </span>
          </div>

          {driftReport.notes.length > 0 && (
            <ul className="flex flex-col gap-0.5" data-testid="iam-drift-notes">
              {driftReport.notes.map((n, i) => (
                <li
                  key={`dn-${i}`}
                  className="text-muted-foreground text-xs before:content-['•'] before:mr-1.5"
                  data-testid={`iam-drift-note-${i}`}
                >
                  {n}
                </li>
              ))}
            </ul>
          )}

          {driftReport.groups.length > 0 && (
            <div data-testid="iam-drift-groups">
              {driftReport.groups.map((g, i) => (
                <DriftActionGroupCard
                  key={`dg-${i}`}
                  group={g}
                  index={i}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HopDrawer({
  hop,
  hopNotes,
  driftReport,
  driftLoading,
  driftError,
  onCheckDrift,
  onClose,
}: {
  hop: TrustPathRole | null;
  hopNotes: string[];
  driftReport: IamDriftReport | null;
  driftLoading: boolean;
  driftError: string | null;
  onCheckDrift: () => void;
  onClose: () => void;
}) {
  const consoleHref = hop ? iamConsoleUrl(hop.arn) : null;
  return (
    <Sheet open={hop !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="w-[480px] sm:max-w-[520px] overflow-y-auto"
        data-testid="iam-hop-drawer"
      >
        {hop && (
          <>
            <SheetHeader>
              <SheetTitle data-testid="iam-hop-drawer-title">
                {hop.name}
              </SheetTitle>
              <SheetDescription>
                <Badge
                  variant={scopeBadgeVariant(hop.scope)}
                  className="capitalize text-[10px] mr-2"
                >
                  {hop.scope}
                </Badge>
                Trust path hop
              </SheetDescription>
            </SheetHeader>
            <div className="mt-4 flex flex-col gap-4">
              <div>
                <p className="text-muted-foreground text-xs mb-1">Role ARN</p>
                <div className="flex items-center gap-2">
                  <p
                    className="text-foreground text-xs font-mono break-all flex-1"
                    data-testid="iam-hop-drawer-arn"
                  >
                    {hop.arn}
                  </p>
                  <CopyButton text={hop.arn} label="arn" />
                </div>
                {consoleHref && (
                  <a
                    href={consoleHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary text-xs inline-flex items-center gap-1 mt-1 hover:underline"
                    data-testid="iam-hop-console-link"
                  >
                    <ExternalLink className="size-3" />
                    Open in IAM console
                  </a>
                )}
              </div>
              <div>
                <p className="text-muted-foreground text-xs mb-1">
                  Trust policy principals ({hop.trustPolicyPrincipals.length})
                </p>
                {hop.trustPolicyPrincipals.length === 0 ? (
                  <p className="text-muted-foreground text-xs italic">
                    No principals captured
                  </p>
                ) : (
                  <ul className="flex flex-col gap-0.5">
                    {hop.trustPolicyPrincipals.map((p, i) => (
                      <li
                        key={`p-${i}`}
                        className="text-foreground text-xs font-mono break-all"
                        data-testid={`iam-hop-drawer-principal-${i}`}
                      >
                        {p}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div>
                <p className="text-muted-foreground text-xs mb-1">
                  Inline policy
                  {hop.inlinePolicyName ? ` (${hop.inlinePolicyName})` : ''}
                </p>
                {hop.inlinePolicy.length === 0 ? (
                  <p
                    className="text-muted-foreground text-xs italic"
                    data-testid="iam-hop-drawer-no-policy"
                  >
                    No inline policy on this hop
                  </p>
                ) : (
                  hop.inlinePolicy.map((stmt, i) => (
                    <PolicyStatementCard
                      key={`stmt-${i}`}
                      statement={stmt}
                      index={i}
                    />
                  ))
                )}
              </div>
              {(hop.scope === 'agent' ||
                hop.scope === 'datastore' ||
                hop.scope === 'integration') && (
                <DriftSection
                  driftReport={driftReport}
                  driftLoading={driftLoading}
                  driftError={driftError}
                  onCheckDrift={onCheckDrift}
                />
              )}
              {hopNotes.length > 0 && (
                <div>
                  <p className="text-muted-foreground text-xs mb-1">Notes</p>
                  <ul className="flex flex-col gap-0.5">
                    {hopNotes.map((n, i) => (
                      <li
                        key={`hn-${i}`}
                        className="text-foreground text-xs"
                        data-testid={`iam-hop-drawer-note-${i}`}
                      >
                        {n}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Page-level helpers
// ---------------------------------------------------------------------------

function notesForHop(hop: TrustPathRole, allNotes: string[]): string[] {
  return allNotes.filter((n) => n.includes(hop.arn));
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function GovernanceIamTrustPath() {
  const org = useOrganization();
  const isAdmin = !!org.isAdmin;

  const [resourceType, setResourceType] = useState<ResourceType>('datastore');
  const [resourceId, setResourceId] = useState<string>('');
  const [recents, setRecents] = useState<RecentEntry[]>([]);
  const [report, setReport] = useState<TrustPathReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [driftReport, setDriftReport] = useState<IamDriftReport | null>(null);
  const [driftLoading, setDriftLoading] = useState(false);
  const [driftError, setDriftError] = useState<string | null>(null);

  // Reset drift state when the user switches hops or closes the drawer.
  useEffect(() => {
    setDriftReport(null);
    setDriftLoading(false);
    setDriftError(null);
  }, [selectedIndex]);

  useEffect(() => {
    if (!isAdmin) return;
    setRecents(loadRecents());
  }, [isAdmin]);

  const handleInspect = useCallback(async () => {
    if (!resourceId.trim()) return;
    setLoading(true);
    setError(null);
    setSelectedIndex(null);
    try {
      const res = await governanceService.getTrustPath(resourceType, resourceId.trim());
      setReport(res);
      setRecents((prev) => {
        const next = pushRecent(prev, {
          resourceType,
          resourceId: resourceId.trim(),
        });
        saveRecents(next);
        return next;
      });
    } catch (err: any) {
      setError(err?.message || 'Failed to load trust path');
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [resourceType, resourceId]);

  const handleCheckDrift = useCallback(async () => {
    if (!report) return;
    setDriftLoading(true);
    setDriftError(null);
    try {
      const res = await governanceService.getResourceIamDrift(
        report.resourceType,
        report.resourceId,
      );
      setDriftReport(res);
    } catch (err: any) {
      setDriftError(err?.message || 'Failed to check drift');
      setDriftReport(null);
    } finally {
      setDriftLoading(false);
    }
  }, [report]);

  const { nodes, edges } = useMemo(() => {
    if (!report) return { nodes: [], edges: [] };
    return buildHopNodesAndEdges(report.hops, selectedIndex);
  }, [report, selectedIndex]);

  if (!isAdmin) {
    return (
      <PageContainer className="flex-1 flex flex-col bg-background">
        <GovernanceBreadcrumbs title="IAM trust path" />
        <div className="mb-6">
          <h2 className="text-foreground text-2xl font-semibold mb-2">
            IAM trust path
          </h2>
          <p className="text-muted-foreground text-sm">
            Admin-only audit of the IAM assume chain for governed resources.
          </p>
        </div>
        <Card
          className="rounded-lg p-6 bg-muted/30 text-center gap-0"
          data-testid="iam-empty-state"
        >
          <p className="text-foreground font-semibold mb-1">Admin-only page</p>
          <p className="text-muted-foreground text-sm">
            Sign in as an administrator to inspect IAM trust paths.
          </p>
        </Card>
      </PageContainer>
    );
  }

  const selectedHop =
    report && selectedIndex !== null ? report.hops[selectedIndex] : null;

  return (
    <PageContainer className="flex-1 flex flex-col bg-background">
      <GovernanceBreadcrumbs title="IAM trust path" />
      <div className="mb-6">
        <h2 className="text-foreground text-2xl font-semibold mb-2">
          IAM trust path
        </h2>
        <p className="text-muted-foreground text-sm">
          Audit the two-hop assume chain that an admin Lambda follows to
          reach a target resource.
        </p>
      </div>

      {/* Selector */}
      <Card className="rounded-lg p-4 mb-4 flex-row items-end gap-3 flex-wrap">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="iam-resource-type">Resource type</Label>
          <Select
            value={resourceType}
            onValueChange={(v) => setResourceType(v as ResourceType)}
          >
            <SelectTrigger
              id="iam-resource-type"
              className="w-[180px]"
              data-testid="iam-resource-type-trigger"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RESOURCE_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5 flex-1 min-w-[240px]">
          <Label htmlFor="iam-resource-id">Resource ID</Label>
          <Input
            id="iam-resource-id"
            value={resourceId}
            onChange={(e) => setResourceId(e.target.value)}
            placeholder="e.g. ds-1234, int-abcd, agent-xyz"
            data-testid="iam-resource-id-input"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void handleInspect();
              }
            }}
          />
        </div>
        <Button
          onClick={() => void handleInspect()}
          disabled={loading || resourceId.trim().length === 0}
          data-testid="iam-inspect-button"
        >
          {loading ? 'Inspecting…' : 'Inspect'}
        </Button>
        {recents.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="iam-recents">Recent</Label>
            <Select
              value=""
              onValueChange={(v) => {
                const entry = recents[Number(v)];
                if (entry) {
                  setResourceType(entry.resourceType);
                  setResourceId(entry.resourceId);
                }
              }}
            >
              <SelectTrigger
                id="iam-recents"
                className="w-[260px]"
                data-testid="iam-recents-trigger"
              >
                <SelectValue placeholder="Recent…" />
              </SelectTrigger>
              <SelectContent>
                {recents.map((r, idx) => (
                  <SelectItem
                    key={`${r.resourceType}|${r.resourceId}`}
                    value={String(idx)}
                  >
                    {r.resourceType}/{r.resourceId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </Card>

      {error && (
        <div
          className="border border-destructive/40 bg-destructive/10 rounded-lg p-3 mb-4"
          data-testid="iam-error-banner"
        >
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}

      {loading && (
        <div className="flex flex-col gap-3 mb-4">
          <Skeleton className="h-[100px] w-full" />
          <Skeleton className="h-[280px] w-full" />
        </div>
      )}

      {!loading && !report && (
        <Card
          className="rounded-lg p-6 bg-muted/30 gap-0"
          data-testid="iam-walkthrough-card"
        >
          <h3 className="text-foreground text-base font-semibold mb-2">
            Trust chain pattern
          </h3>
          <p className="text-muted-foreground text-sm mb-2">
            Every governed resource is reached via a deterministic two-hop
            chain:
          </p>
          <ol className="list-decimal pl-5 text-sm text-foreground flex flex-col gap-1 mb-3">
            <li>
              <span className="font-mono">Lambda execution role</span> —
              the assumer (this audit fixes it to the governance UI
              resolver Lambda)
            </li>
            <li>
              <span className="font-mono">Cross-account role</span>{' '}
              (optional) — when the resource declares{' '}
              <code className="font-mono">crossAccountRoleArn</code>
            </li>
            <li>
              <span className="font-mono">
                citadel-{`{ds,int,agent}-${'{resourceId}'}`}
              </span>{' '}
              — the scoped role with the inline{' '}
              <code className="font-mono">DataStoreAccess</code> policy
            </li>
          </ol>
          <p className="text-muted-foreground text-xs">
            See <code className="font-mono">docs/POLICY_MANAGER.md</code>{' '}
            for the architectural reference.
          </p>
        </Card>
      )}

      {!loading && report && (
        <>
          {report.notes.length > 0 && (
            <div
              className="border border-border bg-muted/40 rounded-lg p-3 mb-4"
              data-testid="iam-notes-banner"
            >
              <p className="text-foreground text-xs font-semibold mb-1">
                Operational notes
              </p>
              <ul className="flex flex-col gap-0.5">
                {report.notes.map((n, i) => (
                  <li
                    key={`note-${i}`}
                    className="text-foreground text-xs"
                    data-testid={`iam-note-${i}`}
                  >
                    {n}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <Card
            className="rounded-lg h-[260px] mb-4 relative block gap-0"
            data-testid="iam-trust-path-canvas"
            data-hop-count={String(report.hops.length)}
          >
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
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
                const id = node.id;
                const m = id.match(/^hop-(\d+)$/);
                if (m) setSelectedIndex(Number(m[1]));
              }}
              fitView
              fitViewOptions={{ padding: 0.15 }}
            />
          </Card>
        </>
      )}

      <p
        className="text-muted-foreground text-[11px] mt-auto pt-4"
        data-testid="iam-wave-5c2-footer"
      >
        Drift detection overlay highlights roles whose inline policies exceed declared requirements.
      </p>

      <HopDrawer
        hop={selectedHop}
        hopNotes={
          selectedHop && report
            ? notesForHop(selectedHop, report.notes)
            : []
        }
        driftReport={driftReport}
        driftLoading={driftLoading}
        driftError={driftError}
        onCheckDrift={() => void handleCheckDrift()}
        onClose={() => setSelectedIndex(null)}
      />
    </PageContainer>
  );
}

export default GovernanceIamTrustPath;
