/**
 * Governance Ledger
 *
 * Filter bar (decision / workflow id / time range / refresh) over a
 * paginated table of GovernanceFinding rows, with row-click drawer for
 * full detail.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Copy, Link2, FileText, Layers, Workflow } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PageContainer } from '../../components/PageContainer';
import { GovernanceBreadcrumbs } from '../../components/governance/GovernanceBreadcrumbs';
import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import { Skeleton } from '../../components/ui/skeleton';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '../../components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import {
  governanceService,
  GovernanceFinding,
} from '../../services/governanceService';

type DecisionFilter = 'all' | 'permit' | 'deny' | 'escalate' | 'halt';
type RangeFilter = '24h' | '7d' | '30d' | 'custom';

const PAGE_SIZE = 50;

/**
 * Convert a `<input type="datetime-local">` value (e.g. "2026-05-18T09:30")
 * to a unix-second timestamp in the user's local timezone. Returns null for
 * empty / unparseable input.
 */
function localDatetimeToTs(value: string): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

/**
 * Format a Date as a `<input type="datetime-local">` value in local time
 * (`YYYY-MM-DDTHH:MM`). Used to seed the picker so it is never blank when
 * the user first switches to custom mode.
 */
function dateToLocalDatetime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function rangeToSinceTs(range: RangeFilter, customFromTs: number | null): number | null {
  const now = Math.floor(Date.now() / 1000);
  switch (range) {
    case '24h':
      return now - 86_400;
    case '7d':
      return now - 7 * 86_400;
    case '30d':
      return now - 30 * 86_400;
    case 'custom':
      // When the user has not yet entered a `from`, fall back to "all time"
      // (sinceTs = null). The from > to validation runs separately and
      // gates the fetch entirely on its own.
      return customFromTs;
    default:
      return null;
  }
}

function formatRelative(ts: number): string {
  const ms = Date.now() - ts * 1000;
  const sec = Math.abs(ms) / 1000;
  if (sec < 60) return ms >= 0 ? 'just now' : 'in a moment';
  const minutes = Math.round(sec / 60);
  if (minutes < 60) return ms >= 0 ? `${minutes}m ago` : `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return ms >= 0 ? `${hours}h ago` : `in ${hours}h`;
  const days = Math.round(hours / 24);
  return ms >= 0 ? `${days}d ago` : `in ${days}d`;
}

function formatAbsolute(ts: number): string {
  return new Date(ts * 1000).toISOString();
}

function decisionVariant(decision: string): 'success' | 'destructive' | 'warning' | 'secondary' {
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

function ReasonTokens({ reason }: { reason: string }) {
  if (!reason) return <span className="text-muted-foreground text-xs">—</span>;
  const tokens = reason.split(':');
  return (
    <div className="flex flex-wrap items-center gap-1">
      {tokens.map((token, i) => (
        <span
          key={`${i}-${token}`}
          className="font-mono text-xs px-1 rounded bg-muted"
        >
          {token}
        </span>
      ))}
    </div>
  );
}

interface FindingDetailSheetProps {
  finding: GovernanceFinding | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function FindingDetailSheet({ finding, open, onOpenChange }: FindingDetailSheetProps) {
  const navigate = useNavigate();
  if (!finding) return null;

  const copy = (value: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(value).catch(() => {
        /* swallow */
      });
    }
  };

  const fields: Array<[string, string | number | boolean | null]> = [
    ['findingId', finding.findingId],
    ['workflowId', finding.workflowId],
    ['decision', finding.decision],
    ['reason', finding.reason],
    ['requestingAgent', finding.requestingAgent],
    ['targetAgent', finding.targetAgent],
    ['scopeEvaluated', finding.scopeEvaluated],
    ['contractEvaluated', finding.contractEvaluated],
    ['escalationTarget', finding.escalationTarget],
    ['residualAuthorityDenial', finding.residualAuthorityDenial],
    ['timestamp', finding.timestamp],
  ];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[600px] sm:max-w-[600px] p-6 overflow-y-auto">
        <SheetHeader className="p-0 mb-4">
          <SheetTitle>Governance Finding</SheetTitle>
          <SheetDescription>Full record from the governance ledger.</SheetDescription>
        </SheetHeader>

        <dl className="grid grid-cols-[160px_1fr] gap-x-4 gap-y-2 text-sm mb-6">
          {fields.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground font-mono text-xs pt-0.5">{key}</dt>
              <dd className="text-foreground break-all font-mono text-xs">
                {value === null || value === undefined ? (
                  <span className="text-muted-foreground italic">null</span>
                ) : typeof value === 'boolean' ? (
                  String(value)
                ) : (
                  String(value)
                )}
              </dd>
            </div>
          ))}
        </dl>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => copy(finding.findingId)}
          >
            <Copy className="size-3" />
            Copy findingId
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => copy(JSON.stringify(finding, null, 2))}
          >
            <Copy className="size-3" />
            Copy as JSON
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              navigate(`/governance/tracer?findingId=${finding.findingId}`);
            }}
            data-testid="ledger-view-trace-button"
          >
            <Workflow className="size-3" />
            View trace
          </Button>
          {finding.escalationTarget && (
            <Button
              size="sm"
              variant="outline"
              asChild
            >
              <a
                href={finding.escalationTarget}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Link2 className="size-3" />
                Escalation target
              </a>
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export function GovernanceLedger() {
  const [decision, setDecision] = useState<DecisionFilter>('all');
  const [workflowId, setWorkflowId] = useState<string>('');
  const [workflowIdInput, setWorkflowIdInput] = useState<string>('');
  const [range, setRange] = useState<RangeFilter>('24h');
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');

  const [items, setItems] = useState<GovernanceFinding[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<GovernanceFinding | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Validate custom range. If both from and to are set and from > to, the
  // picker is in an invalid state and the fetch must be skipped to avoid a
  // wedged state where a stale error keeps re-rendering.
  const customRangeError = useMemo<string | null>(() => {
    if (range !== 'custom') return null;
    const fromTs = localDatetimeToTs(customFrom);
    const toTs = localDatetimeToTs(customTo);
    if (fromTs === null || toTs === null) return null;
    if (fromTs > toTs) return 'Start must be before end.';
    return null;
  }, [range, customFrom, customTo]);

  const buildArgs = useCallback(
    (cursor: string | null) => {
      const customFromTs =
        range === 'custom' ? localDatetimeToTs(customFrom) : null;
      return {
        limit: PAGE_SIZE,
        cursor,
        decision: decision === 'all' ? null : decision,
        workflowId: workflowId.trim() ? workflowId.trim() : null,
        sinceTs: rangeToSinceTs(range, customFromTs),
      };
    },
    [decision, workflowId, range, customFrom]
  );

  const fetchInitial = useCallback(async () => {
    if (customRangeError) {
      // Skip fetch — the inline picker error tells the user what to fix.
      // Do NOT touch `items` here so the previous results remain visible
      // while the user corrects the range (avoids a flash of empty state).
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const conn = await governanceService.listGovernanceFindings(buildArgs(null));
      setItems(conn.items);
      setNextCursor(conn.nextCursor);
    } catch (err: any) {
      setError(err?.message || 'Failed to load findings');
      setItems([]);
      setNextCursor(null);
    } finally {
      setLoading(false);
    }
  }, [buildArgs, customRangeError]);

  const fetchMore = useCallback(async () => {
    if (!nextCursor) return;
    if (customRangeError) return;
    setLoadingMore(true);
    setError(null);
    try {
      const conn = await governanceService.listGovernanceFindings(buildArgs(nextCursor));
      setItems((prev) => [...prev, ...conn.items]);
      setNextCursor(conn.nextCursor);
    } catch (err: any) {
      setError(err?.message || 'Failed to load more findings');
    } finally {
      setLoadingMore(false);
    }
  }, [buildArgs, nextCursor, customRangeError]);

  useEffect(() => {
    fetchInitial();
  }, [fetchInitial]);

  const handleRangeChange = (next: RangeFilter) => {
    if (next === 'custom' && !customFrom && !customTo) {
      // Seed the picker so it is never blank: from = now − 7d, to = now.
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * 86_400 * 1000);
      setCustomFrom(dateToLocalDatetime(sevenDaysAgo));
      setCustomTo(dateToLocalDatetime(now));
    }
    setRange(next);
  };

  const handleApplyWorkflowFilter = () => {
    setWorkflowId(workflowIdInput);
  };

  const handleRowClick = (finding: GovernanceFinding) => {
    setSelected(finding);
    setSheetOpen(true);
  };

  const handleWorkflowChip = (id: string) => {
    setWorkflowIdInput(id);
    setWorkflowId(id);
  };

  // Client-side `<= toTs` trim. The resolver's GSI Query SK comparator is
  // `>=` only (sinceTs lower bound), so we honour the picker's upper bound
  // by filtering on the rendered side. This is cheap because PAGE_SIZE caps
  // the row count.
  const visibleItems = useMemo(() => {
    if (range !== 'custom') return items;
    const toTs = localDatetimeToTs(customTo);
    if (toTs === null) return items;
    return items.filter((f) => f.timestamp <= toTs);
  }, [items, range, customTo]);

  const isEmpty = !loading && visibleItems.length === 0 && !error;


  const tableRows = useMemo(
    () =>
      visibleItems.map((finding) => {
        const scopeOrContract = finding.scopeEvaluated
          ? { kind: 'scope', value: finding.scopeEvaluated }
          : finding.contractEvaluated
          ? { kind: 'contract', value: finding.contractEvaluated }
          : null;

        return (
          <TableRow
            key={finding.findingId}
            className="cursor-pointer"
            onClick={() => handleRowClick(finding)}
          >
            <TableCell title={formatAbsolute(finding.timestamp)}>
              <span className="text-xs text-muted-foreground">
                {formatRelative(finding.timestamp)}
              </span>
            </TableCell>
            <TableCell>
              <Badge variant={decisionVariant(finding.decision)} className="capitalize">
                {finding.decision}
              </Badge>
            </TableCell>
            <TableCell>
              <ReasonTokens reason={finding.reason} />
            </TableCell>
            <TableCell>
              <Button
                variant="link"
                type="button"
                className="font-mono text-xs text-primary hover:underline h-auto p-0"
                onClick={(e) => {
                  e.stopPropagation();
                  handleWorkflowChip(finding.workflowId);
                }}
              >
                {finding.workflowId}
              </Button>
            </TableCell>
            <TableCell>
              <span className="font-mono text-xs">
                {finding.requestingAgent} <span className="text-muted-foreground">→</span>{' '}
                {finding.targetAgent}
              </span>
            </TableCell>
            <TableCell>
              {scopeOrContract ? (
                <span className="inline-flex items-center gap-1 font-mono text-xs">
                  {scopeOrContract.kind === 'scope' ? (
                    <Layers className="size-3 text-muted-foreground" />
                  ) : (
                    <FileText className="size-3 text-muted-foreground" />
                  )}
                  {scopeOrContract.value}
                </span>
              ) : (
                <span className="text-muted-foreground text-xs">—</span>
              )}
            </TableCell>
          </TableRow>
        );
      }),
    [visibleItems]
  );

  return (
    <PageContainer className="flex-1 flex flex-col bg-background">
      <GovernanceBreadcrumbs title="Ledger" />
      <div className="mb-6">
        <h2 className="text-foreground text-2xl font-semibold mb-2">Governance Ledger</h2>
        <p className="text-muted-foreground text-sm">
          Authority and contract decisions emitted by the governance gate.
        </p>
      </div>

      {/* Filter bar */}
      <div className="flex items-end gap-3 mb-4 flex-wrap" data-testid="ledger-filter-bar">
        <div className="flex flex-col gap-1">
          <Label htmlFor="ledger-decision-trigger" className="text-xs text-muted-foreground">
            Decision
          </Label>
          <Select value={decision} onValueChange={(v) => setDecision(v as DecisionFilter)}>
            <SelectTrigger id="ledger-decision-trigger" className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="permit">Permit</SelectItem>
              <SelectItem value="deny">Deny</SelectItem>
              <SelectItem value="escalate">Escalate</SelectItem>
              <SelectItem value="halt">Halt</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="ledger-workflow-input" className="text-xs text-muted-foreground">
            Workflow ID
          </Label>
          <Input
            id="ledger-workflow-input"
            value={workflowIdInput}
            onChange={(e) => setWorkflowIdInput(e.target.value)}
            onBlur={handleApplyWorkflowFilter}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleApplyWorkflowFilter();
            }}
            placeholder="exact id…"
            className="w-[260px]"
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="ledger-range-trigger" className="text-xs text-muted-foreground">
            Time range
          </Label>
          <Select value={range} onValueChange={(v) => handleRangeChange(v as RangeFilter)}>
            <SelectTrigger id="ledger-range-trigger" className="w-[120px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="24h">Last 24h</SelectItem>
              <SelectItem value="7d">Last 7d</SelectItem>
              <SelectItem value="30d">Last 30d</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {range === 'custom' && (
          <>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ledger-custom-from" className="text-xs text-muted-foreground">
                From
              </Label>
              <Input
                id="ledger-custom-from"
                data-testid="ledger-custom-from"
                type="datetime-local"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                aria-invalid={customRangeError ? true : undefined}
                className="w-[220px]"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="ledger-custom-to" className="text-xs text-muted-foreground">
                To
              </Label>
              <Input
                id="ledger-custom-to"
                data-testid="ledger-custom-to"
                type="datetime-local"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                aria-invalid={customRangeError ? true : undefined}
                className="w-[220px]"
              />
            </div>
          </>
        )}

        <Button
          variant="outline"
          onClick={() => fetchInitial()}
          disabled={loading || customRangeError !== null}
        >
          Refresh
        </Button>
      </div>

      {customRangeError && (
        <div
          className="text-xs text-destructive mb-3"
          role="alert"
          data-testid="ledger-custom-error"
        >
          {customRangeError}
        </div>
      )}

      <Card className="overflow-hidden p-0 gap-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Timestamp</TableHead>
              <TableHead>Decision</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Workflow ID</TableHead>
              <TableHead>Requesting → Target</TableHead>
              <TableHead>Scope / Contract</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={`sk-${i}`}>
                  {Array.from({ length: 6 }).map((__, j) => (
                    <TableCell key={`sk-${i}-${j}`}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : isEmpty ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <div className="py-12 text-center text-sm text-muted-foreground">
                    No findings match these filters — the gate may not be reached. Check engine
                    position.
                  </div>
                </TableCell>
              </TableRow>
            ) : error ? (
              <TableRow>
                <TableCell colSpan={6}>
                  <div className="py-12 text-center text-sm text-destructive">{error}</div>
                </TableCell>
              </TableRow>
            ) : (
              tableRows
            )}
          </TableBody>
        </Table>
      </Card>

      <div className="flex justify-center mt-4">
        <Button
          variant="outline"
          onClick={fetchMore}
          disabled={!nextCursor || loadingMore}
          data-testid="ledger-load-more"
        >
          {loadingMore ? 'Loading…' : nextCursor ? 'Load more' : 'No more results'}
        </Button>
      </div>

      <FindingDetailSheet
        finding={selected}
        open={sheetOpen}
        onOpenChange={(o) => {
          setSheetOpen(o);
          if (!o) setSelected(null);
        }}
      />
    </PageContainer>
  );
}

export default GovernanceLedger;
