import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Checkbox } from '../components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import {
  approvalsService,
} from '../services/approvalsService';
import type {
  PendingApprovalItem,
  ApprovalDecision,
} from '../services/approvalsService';
import { ApprovalDecisionDialog } from '../components/ApprovalDecisionDialog';
import { BulkApprovalDialog } from '../components/BulkApprovalDialog';
import { useBulkApproval } from '../hooks/useBulkApproval';

const MAX_BULK_SELECTION = 25;

type KindFilter = 'all' | 'agent' | 'tool' | 'app';

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function ApprovalsPage() {
  const [items, setItems] = useState<PendingApprovalItem[]>([]);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogRecord, setDialogRecord] = useState<PendingApprovalItem | null>(null);
  const [dialogDecision, setDialogDecision] = useState<ApprovalDecision>('APPROVED');

  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [kindFilter, setKindFilter] = useState<KindFilter>('all');
  const [bulkDecision, setBulkDecision] = useState<ApprovalDecision | null>(null);

  const bulk = useBulkApproval();

  const filteredItems = kindFilter === 'all'
    ? items
    : items.filter((item) => item.recordType === kindFilter);

  const fetchPage = useCallback(async (token?: string) => {
    try {
      setLoading(true);
      setError(null);
      const data = await approvalsService.listPendingApprovals({
        limit: 25,
        nextToken: token,
      });
      setItems((prev) => (token ? [...prev, ...data.items] : data.items));
      setNextToken(data.nextToken ?? null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load approvals');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPage();
  }, [fetchPage]);

  // Clear selection on kind filter change
  const handleKindChange = (value: string) => {
    setKindFilter(value as KindFilter);
    setSelectedIds(new Set());
  };

  // Toggle a single row
  const toggleSelect = (recordId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(recordId)) {
        next.delete(recordId);
      } else if (next.size < MAX_BULK_SELECTION) {
        next.add(recordId);
      }
      return next;
    });
  };

  // Select-all on current (filtered) page, capped at 25
  const toggleSelectAll = () => {
    const visibleIds = filteredItems.map((r) => r.recordId);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));

    if (allSelected) {
      // Deselect all visible
      setSelectedIds((prev) => {
        const next = new Set(prev);
        visibleIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      // Select all visible, capped at MAX_BULK_SELECTION
      setSelectedIds(new Set(visibleIds.slice(0, MAX_BULK_SELECTION)));
    }
  };

  const visibleIds = filteredItems.map((r) => r.recordId);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const someVisibleSelected = visibleIds.some((id) => selectedIds.has(id));

  // Single-record dialog
  const openDialog = (record: PendingApprovalItem, decision: ApprovalDecision) => {
    setDialogRecord(record);
    setDialogDecision(decision);
  };

  const handleConfirm = async (statusReason?: string) => {
    if (!dialogRecord) return;
    try {
      await approvalsService.decideApproval({
        recordId: dialogRecord.recordId,
        recordType: dialogRecord.recordType,
        decision: dialogDecision,
        ...(dialogRecord.version !== undefined ? { version: dialogRecord.version } : {}),
        statusReason,
      });
      toast.success(
        `${dialogRecord.displayName || dialogRecord.name} ${dialogDecision.toLowerCase()}`,
      );
      setItems((prev) => prev.filter((i) => i.recordId !== dialogRecord.recordId));
      setDialogRecord(null);
      fetchPage();
    } catch (err: unknown) {
      const msg: string = err instanceof Error ? err.message : 'Decision failed';
      if (msg.toLowerCase().includes('conflict')) {
        toast.error('This record changed; please review again');
        setDialogRecord(null);
        fetchPage();
      } else {
        toast.error(msg);
      }
    }
  };

  // Bulk actions
  const openBulkDialog = (decision: ApprovalDecision) => {
    setBulkDecision(decision);
  };

  const handleBulkConfirm = (reason?: string) => {
    const selectedRecords = items.filter((i) => selectedIds.has(i.recordId));
    bulk.execute(selectedRecords, bulkDecision!, reason);
  };

  const handleBulkClose = () => {
    setBulkDecision(null);
    bulk.reset();
    setSelectedIds(new Set());
    fetchPage();
  };

  return (
    <div className="p-6 flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Pending Approvals</h1>

      {error && (
        <div role="alert" className="text-destructive">
          {error}
        </div>
      )}

      {!error && !loading && items.length === 0 && (
        <p className="text-muted-foreground">No records awaiting approval</p>
      )}

      {items.length > 0 && (
        <>
          {/* Toolbar: kind filter + bulk actions */}
          <div className="flex items-center gap-3 flex-wrap" data-testid="toolbar">
            <Select value={kindFilter} onValueChange={handleKindChange}>
              <SelectTrigger className="w-[140px]" data-testid="kind-filter">
                <SelectValue placeholder="Filter by kind" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="agent">Agents</SelectItem>
                <SelectItem value="tool">Tools</SelectItem>
                <SelectItem value="app">Apps</SelectItem>
              </SelectContent>
            </Select>

            {selectedIds.size > 0 && (
              <div className="flex items-center gap-2" data-testid="bulk-actions">
                <span className="text-sm text-muted-foreground" data-testid="selection-count">
                  {selectedIds.size} selected
                </span>
                <Button
                  size="sm"
                  onClick={() => openBulkDialog('APPROVED')}
                  data-testid="bulk-approve"
                >
                  Approve selected
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => openBulkDialog('REJECTED')}
                  data-testid="bulk-reject"
                >
                  Reject selected
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setSelectedIds(new Set())}
                  data-testid="clear-selection"
                >
                  ×
                </Button>
              </div>
            )}
          </div>

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={allVisibleSelected ? true : someVisibleSelected ? 'indeterminate' : false}
                    onCheckedChange={toggleSelectAll}
                    aria-label="Select all records on this page"
                    data-testid="select-all"
                    disabled={filteredItems.length === 0}
                  />
                </TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Organisation</TableHead>
                <TableHead>Submitted</TableHead>
                <TableHead>Submitted by</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredItems.map((record) => (
                <TableRow key={record.recordId} data-testid={`row-${record.recordId}`}>
                  <TableCell>
                    <Checkbox
                      checked={selectedIds.has(record.recordId)}
                      onCheckedChange={() => toggleSelect(record.recordId)}
                      aria-label={`Select ${record.displayName || record.name}`}
                      data-testid={`select-${record.recordId}`}
                      disabled={!selectedIds.has(record.recordId) && selectedIds.size >= MAX_BULK_SELECTION}
                    />
                  </TableCell>
                  <TableCell>{record.displayName || record.name}</TableCell>
                  <TableCell>
                    <Badge variant={record.recordType === 'agent' ? 'default' : 'secondary'}>
                      {record.recordType}
                    </Badge>
                  </TableCell>
                  <TableCell>{record.orgId}</TableCell>
                  <TableCell title={record.submittedAt}>
                    {relativeTime(record.submittedAt)}
                  </TableCell>
                  <TableCell>{record.createdBy}</TableCell>
                  <TableCell>
                    <span className="inline-flex gap-2">
                      <Button
                        size="sm"
                        onClick={() => openDialog(record, 'APPROVED')}
                        data-testid={`approve-${record.recordId}`}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => openDialog(record, 'REJECTED')}
                        data-testid={`reject-${record.recordId}`}
                      >
                        Reject
                      </Button>
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}

      {loading && <p className="text-muted-foreground">Loading…</p>}

      {!loading && nextToken && (
        <Button
          variant="outline"
          onClick={() => fetchPage(nextToken)}
          data-testid="load-more"
        >
          Load more
        </Button>
      )}

      {dialogRecord && (
        <ApprovalDecisionDialog
          record={dialogRecord}
          decision={dialogDecision}
          onConfirm={handleConfirm}
          onCancel={() => setDialogRecord(null)}
        />
      )}

      {bulkDecision && (
        <BulkApprovalDialog
          records={items.filter((i) => selectedIds.has(i.recordId))}
          decision={bulkDecision}
          results={bulk.results}
          progress={bulk.progress}
          isExecuting={bulk.isExecuting}
          onConfirm={handleBulkConfirm}
          onRetry={bulk.retryFailed}
          onClose={handleBulkClose}
        />
      )}
    </div>
  );
}
