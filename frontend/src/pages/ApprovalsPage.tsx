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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '../components/ui/tooltip';
import {
  approvalsService,
  supportsToolDecisions,
} from '../services/approvalsService';
import type {
  PendingApprovalItem,
  ApprovalDecision,
} from '../services/approvalsService';
import { ApprovalDecisionDialog } from '../components/ApprovalDecisionDialog';

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
    } catch (err: any) {
      setError(err.message ?? 'Failed to load approvals');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPage();
  }, [fetchPage]);

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
        version: 1,
        statusReason,
      });
      toast.success(
        `${dialogRecord.displayName || dialogRecord.name} ${dialogDecision.toLowerCase()}`,
      );
      setItems((prev) => prev.filter((i) => i.recordId !== dialogRecord.recordId));
      setDialogRecord(null);
      // Refresh sidebar count by re-fetching first page
      fetchPage();
    } catch (err: any) {
      toast.error(err.message ?? 'Decision failed');
    }
  };

  const actionsDisabled = (record: PendingApprovalItem) =>
    record.recordType === 'tool' && !supportsToolDecisions;

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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Organisation</TableHead>
              <TableHead>Submitted</TableHead>
              <TableHead>Submitted by</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((record) => (
              <TableRow key={record.recordId} data-testid={`row-${record.recordId}`}>
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
                  {actionsDisabled(record) ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex gap-2" data-testid="tool-actions-disabled">
                          <Button size="sm" disabled>Approve</Button>
                          <Button size="sm" variant="destructive" disabled>Reject</Button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>Tool decisions are not yet supported</TooltipContent>
                    </Tooltip>
                  ) : (
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
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
    </div>
  );
}
