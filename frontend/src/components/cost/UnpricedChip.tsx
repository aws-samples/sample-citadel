/**
 * UnpricedChip
 *
 * Honest-state indicator showing how many ledger rows in the current
 * dataset could not be priced (missing catalog entry, missing pricing
 * fields — see cost-ledger-writer.ts's `unpricedReason`). Rendered
 * whenever `count > 0` so totals never silently understate spend without
 * disclosure; hidden entirely when there are no unpriced rows.
 */
import { Badge } from '../ui/badge';

export interface UnpricedChipProps {
  count: number;
}

export function UnpricedChip({ count }: UnpricedChipProps) {
  if (count <= 0) return null;
  return (
    <Badge
      variant="warning"
      title="These calls could not be matched to catalog pricing and are excluded from the cost totals."
    >
      {count} unpriced
    </Badge>
  );
}

export default UnpricedChip;
