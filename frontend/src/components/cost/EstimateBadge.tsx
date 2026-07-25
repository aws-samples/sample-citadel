/**
 * EstimateBadge
 *
 * Honest-state indicator for cost panels: every ledger-derived cost row
 * carries `estimate: true` (see cost-query-handler.ts response shapes),
 * so this badge is shown whenever a cost dataset is rendered — it must
 * never be silently omitted, since that would imply the figures are
 * exact/priced-with-certainty rather than model-derived estimates.
 */
import { Badge } from '../ui/badge';

export interface EstimateBadgeProps {
  /** Show the badge. Callers pass `true` whenever any row in the dataset has `estimate:true` (i.e. essentially always, per the API contract) — kept explicit rather than hardcoded so a future non-estimate data source can opt out. */
  show: boolean;
}

export function EstimateBadge({ show }: EstimateBadgeProps) {
  if (!show) return null;
  return (
    <Badge variant="info" title="Costs are estimated from token usage and catalog pricing, not a billing invoice.">
      Estimate
    </Badge>
  );
}

export default EstimateBadge;
