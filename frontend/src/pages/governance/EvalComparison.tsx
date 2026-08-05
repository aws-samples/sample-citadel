/**
 * Governance — Eval baseline comparison (CIT-105 UI)
 *
 * Side-by-side baseline-vs-candidate diff for a computed
 * EvalComparisonVerdict: per-dimension aggregates with the categorical
 * material-regression verdict, plus a per-case×per-dimension breakdown
 * (improved/regressed/unstable/unchanged/incomparable/new/dropped),
 * expandable per dimension.
 *
 * Backend contract: backend/src/schema/schema.graphql "Eval baseline
 * comparison + regression (CIT-105)" + the pure algorithm in
 * backend/src/lambda/utils/eval-comparison.ts (compareRuns). This page
 * NEVER re-derives a classification or a composite score — it only
 * renders what the resolver returns.
 *
 * Honest states (never fabricated):
 *  - loading: compute/designate in flight
 *  - no baseline designated: getEvalBaseline resolved null and the
 *    caller has not supplied an explicit baselineEvalRunId override
 *  - NOTHING_TO_COMPARE / INCOMPARABLE: rendered as their own explicit
 *    states, never collapsed into PASS
 *  - unauthorized (cross-org / permission denial): the resolver's
 *    `UnauthorizedError:` / `CrossOrgRowError` message is surfaced
 *    distinctly from a generic error
 *  - empty: zero dimensions / zero cases in a dimension's breakdown
 *
 * Accessibility: every classification is labelled with text (and an
 * icon for the top-level verdict) — never colour alone. Dimension rows
 * are keyboard-expandable buttons; the case-detail table uses semantic
 * <table> markup via the shared Table primitives.
 *
 * Scope note: raw transcript/trajectory artifact rendering (executing
 * the conversation/execution replay viewer) is OUT OF SCOPE — no query
 * in the CIT-105 GraphQL surface returns raw artifacts, only the
 * per-case×per-dimension classification + numeric baseline/candidate
 * values via `caseDetail`. This page renders exactly that evidence.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Minus,
  ShieldAlert,
  XCircle,
} from 'lucide-react';
import { PageContainer } from '../../components/PageContainer';
import { GovernanceBreadcrumbs } from '../../components/governance/GovernanceBreadcrumbs';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import { Skeleton } from '../../components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Alert, AlertDescription } from '../../components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import { useOrganization } from '../../contexts/OrganizationContext';
import {
  evalComparisonService,
  type EvalComparisonVerdict,
  type EvalComparisonPerCaseRow,
  type EvalComparisonPerCaseClass,
  type EvalBaseline,
} from '../../services/evalComparisonService';

// ---------------------------------------------------------------------------
// Verdict status presentation (icon + label — never colour alone)
// ---------------------------------------------------------------------------

const VERDICT_PRESENTATION: Record<
  string,
  { label: string; icon: typeof CheckCircle2; badgeVariant: 'success' | 'destructive' | 'warning' | 'secondary' | 'outline' }
> = {
  PASS: { label: 'PASS', icon: CheckCircle2, badgeVariant: 'success' },
  REGRESSED: { label: 'REGRESSED', icon: XCircle, badgeVariant: 'destructive' },
  UNSTABLE: { label: 'UNSTABLE', icon: AlertTriangle, badgeVariant: 'warning' },
  INCOMPARABLE: { label: 'INCOMPARABLE', icon: ShieldAlert, badgeVariant: 'secondary' },
  NOTHING_TO_COMPARE: { label: 'NOTHING TO COMPARE', icon: ShieldAlert, badgeVariant: 'outline' },
};

function isUnauthorizedError(message: string): boolean {
  return /unauthorized|forbidden|cross-org row encountered/i.test(message);
}

function directionIcon(direction: string) {
  if (direction === 'improved') return ArrowUp;
  if (direction === 'regressed') return ArrowDown;
  return Minus;
}

const CASE_CLASS_LABEL: Record<EvalComparisonPerCaseClass, string> = {
  improved: 'Improved',
  regressed: 'Regressed',
  unchanged: 'Unchanged',
  unstable: 'Unstable (flaky)',
  incomparable: 'Incomparable',
  new: 'New case',
  dropped: 'Dropped case',
};

const CASE_CLASS_BADGE_VARIANT: Record<
  EvalComparisonPerCaseClass,
  'success' | 'destructive' | 'warning' | 'secondary' | 'outline'
> = {
  improved: 'success',
  regressed: 'destructive',
  unchanged: 'secondary',
  unstable: 'warning',
  incomparable: 'outline',
  new: 'outline',
  dropped: 'outline',
};

function parseCaseDetail(
  verdict: EvalComparisonVerdict | null,
): Record<string, EvalComparisonPerCaseRow[]> {
  if (!verdict?.caseDetail) return {};
  try {
    return JSON.parse(verdict.caseDetail) as Record<string, EvalComparisonPerCaseRow[]>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function VerdictSummary({ verdict }: { verdict: EvalComparisonVerdict }) {
  const presentation = VERDICT_PRESENTATION[verdict.verdictStatus] ?? {
    label: verdict.verdictStatus,
    icon: ShieldAlert,
    badgeVariant: 'outline' as const,
  };
  const Icon = presentation.icon;
  return (
    <Card data-testid="eval-verdict-summary" className="mb-4">
      <CardHeader>
        <div className="flex items-center gap-3">
          <Icon
            className="size-5"
            aria-hidden="true"
            data-testid="eval-verdict-icon"
          />
          <div>
            <CardTitle>
              <Badge
                variant={presentation.badgeVariant}
                className="text-sm"
                data-testid="eval-verdict-badge"
                role="status"
              >
                {presentation.label}
              </Badge>
            </CardTitle>
            <CardDescription>
              Baseline <span className="font-mono">{verdict.baselineEvalRunId}</span> (
              {verdict.baselineAgentTargetVersion}) vs. candidate(s){' '}
              <span className="font-mono">{verdict.candidateEvalRunIds.join(', ')}</span> (
              {verdict.candidateAgentTargetVersion}), {verdict.repeatCount} repeat(s)
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div>
            <dt className="text-muted-foreground text-xs">Suite version</dt>
            <dd className="font-mono">{verdict.suiteVersion}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Materially regressed dims</dt>
            <dd data-testid="eval-regressed-dims-count">
              {verdict.materiallyRegressedDimensions.length === 0
                ? 'None'
                : verdict.materiallyRegressedDimensions.join(', ')}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Unstable dims</dt>
            <dd data-testid="eval-unstable-dims-count">
              {verdict.unstableDimensions.length === 0
                ? 'None'
                : verdict.unstableDimensions.join(', ')}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground text-xs">Scorer version(s)</dt>
            <dd className="font-mono">{verdict.scorerVersions.join(', ')}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

function DimensionRow({
  dim,
  expanded,
  onToggle,
  caseRows,
}: {
  dim: EvalComparisonVerdict['dimensions'][number];
  expanded: boolean;
  onToggle: () => void;
  caseRows: EvalComparisonPerCaseRow[];
}) {
  const DirectionIcon = directionIcon(dim.direction);
  const ToggleIcon = expanded ? ChevronDown : ChevronRight;
  return (
    <>
      <TableRow data-testid={`eval-dimension-row-${dim.dimension}`}>
        <TableCell>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-controls={`eval-dimension-panel-${dim.dimension}`}
            data-testid={`eval-dimension-expand-${dim.dimension}`}
            className="h-auto p-0 inline-flex items-center gap-1 font-mono text-sm"
          >
            <ToggleIcon className="size-4" aria-hidden="true" />
            {dim.dimension}
          </Button>
        </TableCell>
        <TableCell>
          <span className="inline-flex items-center gap-1">
            <DirectionIcon className="size-3.5" aria-hidden="true" />
            {dim.direction}
          </span>
        </TableCell>
        <TableCell>
          {dim.materialRegression ? (
            <span
              className="inline-flex items-center gap-1 text-destructive font-medium"
              data-testid={`eval-dimension-regression-marker-${dim.dimension}`}
            >
              <XCircle className="size-3.5" aria-hidden="true" />
              Material regression
            </span>
          ) : dim.unstable ? (
            <span className="inline-flex items-center gap-1 text-amber-600 font-medium">
              <AlertTriangle className="size-3.5" aria-hidden="true" />
              Unstable
            </span>
          ) : (
            <span className="text-muted-foreground">No material regression</span>
          )}
        </TableCell>
        <TableCell className="font-mono text-xs">
          {dim.baselineStat ?? '\u2014'}
        </TableCell>
        <TableCell className="font-mono text-xs">
          {dim.candidateStat ?? '\u2014'}
        </TableCell>
        <TableCell className="font-mono text-xs">{dim.delta ?? '\u2014'}</TableCell>
        <TableCell className="text-xs text-muted-foreground">
          {dim.caseCounts.improved}
          {'\u2191'} / {dim.caseCounts.regressed}
          {'\u2193'} / {dim.caseCounts.unstable}
          {'\u2248'}
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={7} id={`eval-dimension-panel-${dim.dimension}`}>
            {caseRows.length === 0 ? (
              <p
                className="text-muted-foreground text-sm py-2"
                data-testid={`eval-dimension-empty-${dim.dimension}`}
              >
                No per-case detail available for this dimension.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Case</TableHead>
                    <TableHead>Classification</TableHead>
                    <TableHead>Baseline value</TableHead>
                    <TableHead>Candidate value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {caseRows.map((row) => (
                    <TableRow key={row.caseId} data-testid={`eval-case-row-${row.caseId}`}>
                      <TableCell className="font-mono text-xs">{row.caseId}</TableCell>
                      <TableCell>
                        <Badge variant={CASE_CLASS_BADGE_VARIANT[row.classification]}>
                          {CASE_CLASS_LABEL[row.classification]}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {row.baselineValue ?? '\u2014'}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {row.candidateValue ?? '\u2014'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function DimensionsTable({ verdict }: { verdict: EvalComparisonVerdict }) {
  const [expandedDim, setExpandedDim] = useState<string | null>(null);
  const caseDetail = useMemo(() => parseCaseDetail(verdict), [verdict]);

  if (verdict.dimensions.length === 0) {
    return (
      <p className="text-muted-foreground text-sm" data-testid="eval-dimensions-empty">
        No dimensions were compared.
      </p>
    );
  }

  return (
    <Table data-testid="eval-dimensions-table">
      <TableHeader>
        <TableRow>
          <TableHead>Dimension</TableHead>
          <TableHead>Direction</TableHead>
          <TableHead>Verdict</TableHead>
          <TableHead>Baseline</TableHead>
          <TableHead>Candidate</TableHead>
          <TableHead>Delta</TableHead>
          <TableHead>Case counts</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {verdict.dimensions.map((dim) => (
          <DimensionRow
            key={dim.dimension}
            dim={dim}
            expanded={expandedDim === dim.dimension}
            onToggle={() =>
              setExpandedDim((cur) => (cur === dim.dimension ? null : dim.dimension))
            }
            caseRows={caseDetail[dim.dimension] ?? []}
          />
        ))}
      </TableBody>
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function GovernanceEvalComparison() {
  const org = useOrganization();
  const orgId = org.selectedOrganization || 'default';

  const [suiteId, setSuiteId] = useState('');
  const [agentTargetId, setAgentTargetId] = useState('');
  const [baselineRunId, setBaselineRunId] = useState('');
  const [candidateRunId, setCandidateRunId] = useState('');

  const [baseline, setBaseline] = useState<EvalBaseline | null | undefined>(undefined);
  const [baselineChecked, setBaselineChecked] = useState(false);

  const [verdict, setVerdict] = useState<EvalComparisonVerdict | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [designateStatus, setDesignateStatus] = useState<string | null>(null);

  const handleCheckBaseline = useCallback(async () => {
    if (!suiteId.trim() || !agentTargetId.trim()) return;
    setBaselineChecked(false);
    try {
      const result = await evalComparisonService.getEvalBaseline(
        orgId,
        agentTargetId.trim(),
        suiteId.trim(),
      );
      setBaseline(result);
    } catch (err: any) {
      setBaseline(null);
      setErrorMessage(err?.message || 'Failed to check baseline');
    } finally {
      setBaselineChecked(true);
    }
  }, [orgId, suiteId, agentTargetId]);

  const handleDesignateBaseline = useCallback(async () => {
    if (!suiteId.trim() || !agentTargetId.trim() || !baselineRunId.trim()) return;
    setDesignateStatus(null);
    setErrorMessage(null);
    try {
      const result = await evalComparisonService.designateEvalBaseline({
        orgId,
        agentTargetId: agentTargetId.trim(),
        suiteId: suiteId.trim(),
        baselineEvalRunId: baselineRunId.trim(),
      });
      setBaseline(result);
      setBaselineChecked(true);
      setDesignateStatus(`Baseline designated: ${result.baselineEvalRunId}`);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to designate baseline');
    }
  }, [orgId, suiteId, agentTargetId, baselineRunId]);

  const handleCompute = useCallback(async () => {
    if (!suiteId.trim() || !candidateRunId.trim()) return;
    setLoading(true);
    setErrorMessage(null);
    setVerdict(null);
    try {
      const idempotencyKey = `ui-${orgId}-${suiteId.trim()}-${baselineRunId.trim() || 'auto'}-${candidateRunId.trim()}`;
      const result = await evalComparisonService.computeEvalComparison({
        orgId,
        suiteId: suiteId.trim(),
        candidateEvalRunIds: candidateRunId
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
        baselineEvalRunId: baselineRunId.trim() || undefined,
        idempotencyKey,
      });
      setVerdict(result);
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to compute eval comparison');
    } finally {
      setLoading(false);
    }
  }, [orgId, suiteId, baselineRunId, candidateRunId]);

  const showNoBaselineState =
    baselineChecked && baseline === null && !baselineRunId.trim() && !verdict && !loading;

  const unauthorized = errorMessage && isUnauthorizedError(errorMessage);

  return (
    <PageContainer className="flex-1 flex flex-col bg-background">
      <GovernanceBreadcrumbs title="Eval baseline comparison" />
      <div className="mb-6">
        <h2 className="text-foreground text-2xl font-semibold mb-2">
          Eval baseline comparison
        </h2>
        <p className="text-muted-foreground text-sm">
          Side-by-side baseline-vs-candidate diff of eval case scores, with
          per-dimension aggregates and the material-regression verdict.
        </p>
      </div>

      <Card className="mb-4">
        <CardContent className="pt-6">
          <form
            data-testid="eval-comparison-form"
            className="flex flex-col gap-4"
            onSubmit={(e) => e.preventDefault()}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="eval-suite-id">Suite ID</Label>
                <Input
                  id="eval-suite-id"
                  data-testid="eval-suite-id-input"
                  value={suiteId}
                  onChange={(e) => setSuiteId(e.target.value)}
                  placeholder="suite-1"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="eval-agent-target-id">Agent target ID</Label>
                <Input
                  id="eval-agent-target-id"
                  data-testid="eval-agent-target-id-input"
                  value={agentTargetId}
                  onChange={(e) => setAgentTargetId(e.target.value)}
                  placeholder="agent-1"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="eval-baseline-run-id">
                  Baseline run ID (optional — uses designated baseline when empty)
                </Label>
                <Input
                  id="eval-baseline-run-id"
                  data-testid="eval-baseline-run-id-input"
                  value={baselineRunId}
                  onChange={(e) => setBaselineRunId(e.target.value)}
                  placeholder="run-base"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="eval-candidate-run-id">
                  Candidate run ID(s) (comma-separated for repeats)
                </Label>
                <Input
                  id="eval-candidate-run-id"
                  data-testid="eval-candidate-run-id-input"
                  value={candidateRunId}
                  onChange={(e) => setCandidateRunId(e.target.value)}
                  placeholder="run-cand"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleCheckBaseline()}
                disabled={!suiteId.trim() || !agentTargetId.trim()}
                data-testid="eval-check-baseline-button"
              >
                Check designated baseline
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleDesignateBaseline()}
                disabled={!suiteId.trim() || !agentTargetId.trim() || !baselineRunId.trim()}
                data-testid="eval-designate-baseline-button"
              >
                Designate as baseline
              </Button>
              <Button
                type="button"
                onClick={() => void handleCompute()}
                disabled={loading || !suiteId.trim() || !candidateRunId.trim()}
                data-testid="eval-compute-button"
              >
                {loading ? 'Computing…' : 'Compute comparison'}
              </Button>
            </div>
            {baseline && baselineChecked && (
              <p className="text-muted-foreground text-xs" data-testid="eval-baseline-info">
                Designated baseline: <span className="font-mono">{baseline.baselineEvalRunId}</span>{' '}
                ({baseline.baselineAgentTargetVersion})
              </p>
            )}
            {designateStatus && (
              <p className="text-foreground text-xs" data-testid="eval-designate-status">
                {designateStatus}
              </p>
            )}
          </form>
        </CardContent>
      </Card>

      {showNoBaselineState && (
        <Alert data-testid="eval-no-baseline-state" className="mb-4">
          <AlertDescription>
            No baseline designated for this (org, agent target, suite) triple. Designate a
            baseline run above, or supply an explicit baseline run ID to compare against.
          </AlertDescription>
        </Alert>
      )}

      {loading && (
        <div className="flex flex-col gap-3 mb-4" data-testid="eval-loading-state">
          <Skeleton className="h-[80px] w-full" />
          <Skeleton className="h-[240px] w-full" />
        </div>
      )}

      {!loading && errorMessage && unauthorized && (
        <Alert variant="destructive" className="mb-4" data-testid="eval-unauthorized-state">
          <AlertDescription>Unauthorized: {errorMessage}</AlertDescription>
        </Alert>
      )}

      {!loading && errorMessage && !unauthorized && (
        <Alert variant="destructive" className="mb-4" data-testid="eval-error-banner">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      {!loading && verdict && verdict.verdictStatus === 'NOTHING_TO_COMPARE' && (
        <Alert className="mb-4" data-testid="eval-nothing-to-compare-state">
          <AlertDescription>
            Nothing to compare: no candidate repeats, or no case is present in both the
            baseline and every candidate repeat. This is not a pass — it means no genuine
            comparison evidence exists yet.
          </AlertDescription>
        </Alert>
      )}

      {!loading && verdict && verdict.verdictStatus === 'INCOMPARABLE' && (
        <Alert className="mb-4" data-testid="eval-incomparable-state">
          <AlertDescription>
            Incomparable: at least one dimension has no measurable overlap between baseline
            and candidate. See the per-dimension table below for details.
          </AlertDescription>
        </Alert>
      )}

      {!loading && verdict && (
        <>
          <VerdictSummary verdict={verdict} />
          <Card>
            <CardHeader>
              <CardTitle>Per-dimension aggregates</CardTitle>
              <CardDescription>
                Expand a dimension to see the per-case baseline vs. candidate diff.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DimensionsTable verdict={verdict} />
            </CardContent>
          </Card>
        </>
      )}
    </PageContainer>
  );
}

export default GovernanceEvalComparison;
