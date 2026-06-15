/**
 * Shared metric/summary card for the governance pages.
 *
 * Used by Mismatches, Escalations, D4Retrospective, and
 * ReconcilerDrift to render the recurring "label + value (+ optional
 * subline)" pattern that previously lived as duplicated bare-border
 * div constructs across 4 files. Built on the shadcn `Card` primitive
 * so the entire governance UI shares one card aesthetic.
 */
import * as React from 'react';
import type { ReactNode } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../ui/card';
import { Skeleton } from '../ui/skeleton';
import { cn } from '../ui/utils';

export type MetricCardAccent =
  | 'default'
  | 'primary'
  | 'success'
  | 'warning'
  | 'destructive'
  | 'muted';

const ACCENT_BORDER: Record<MetricCardAccent, string> = {
  default: 'border-border',
  primary: 'border-primary/40',
  success: 'border-chart-2/40',
  warning: 'border-chart-4/40',
  destructive: 'border-destructive/40',
  muted: 'border-muted-foreground/20',
};

export interface MetricCardProps {
  /** Label shown above the value (small, muted). */
  label: string;
  /**
   * Primary value. Pass a string, number, or a node for rich content
   * (e.g. a value with a unit, a Badge, or chart).
   */
  value: ReactNode;
  /**
   * Optional secondary line below the value (small, muted). Use for
   * units, deltas, time windows, or other supporting info.
   */
  description?: ReactNode;
  /**
   * Border accent. Use sparingly to convey status (e.g. warning for
   * heightened-attention metrics, destructive for failures).
   */
  accent?: MetricCardAccent;
  /** When true, render skeleton placeholders instead of value/description. */
  loading?: boolean;
  /** Optional content slot below the description (sparkline, mini-chart). */
  children?: ReactNode;
  /** className passthrough for layout adjustments. */
  className?: string;
  /** test id for assertions in jest/playwright. */
  testId?: string;
}

export function MetricCard({
  label,
  value,
  description,
  accent = 'default',
  loading = false,
  children,
  className,
  testId,
}: MetricCardProps): React.JSX.Element {
  return (
    <Card
      data-testid={testId}
      className={cn(ACCENT_BORDER[accent], className)}
    >
      <CardHeader>
        <CardDescription className="text-xs">{label}</CardDescription>
        <CardTitle className="text-2xl font-semibold leading-tight">
          {loading ? <Skeleton className="h-7 w-16" /> : value}
        </CardTitle>
      </CardHeader>
      {(description || children) && (
        <CardContent className="flex flex-col gap-2">
          {description !== undefined && (
            loading ? (
              <Skeleton className="h-3 w-24" />
            ) : (
              <p className="text-xs text-muted-foreground">{description}</p>
            )
          )}
          {children}
        </CardContent>
      )}
    </Card>
  );
}
