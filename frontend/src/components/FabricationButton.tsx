import React from 'react';
import { Cog } from 'lucide-react';
import { Button } from './ui/button';
import { Badge } from './ui/badge';

interface FabricationButtonProps {
  /** PENDING + PROCESSING items — the number shown prominently. */
  activeCount: number;
  /** All-time COMPLETED items — surfaced in the accessible breakdown. */
  completedCount: number;
  onClick: () => void;
}

/**
 * Queue entry button. The badge shows the ACTIVE (in progress) count — not
 * the cumulative all-time total, which read as a stalled backlog once the
 * completed history accumulated (live: '37' with nothing running). The full
 * breakdown is exposed on the button label for assistive tech and as a
 * hover tooltip.
 */
export const FabricationButton: React.FC<FabricationButtonProps> = ({
  activeCount,
  completedCount,
  onClick,
}) => {
  const breakdown = `${activeCount} in progress, ${completedCount} completed`;
  return (
    <Button
      variant="outline"
      className="gap-2 h-9 px-3 font-medium rounded-md inline-flex items-center transition-colors duration-200 bg-card text-muted-foreground border-none cursor-pointer text-sm hover:bg-accent"
      onClick={onClick}
      aria-label={`Fabrication queue: ${breakdown}`}
      title={breakdown}
    >
      <Cog className="size-4" />
      <span>Fabrication</span>
      <Badge
        variant="secondary"
        data-testid="fabrication-active-badge"
        className="ml-1 text-xs px-1.5 py-0.5 font-semibold rounded"
        style={{
          backgroundColor: 'var(--background)',
          color: 'var(--muted-foreground)',
          fontSize: '11px',
          minWidth: '20px',
          textAlign: 'center',
        }}
      >
        {activeCount}
      </Badge>
    </Button>
  );
};
