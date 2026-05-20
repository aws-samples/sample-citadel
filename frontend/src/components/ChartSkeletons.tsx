/**
 * Skeleton placeholders for lazy-loaded dashboard chart sections.
 * Dimensions match the rendered charts to prevent layout shift.
 *
 * Requirement 15.6: Skeleton placeholders while charts load
 * Requirement 15.8: Zero layout shift
 */

/**
 * Skeleton for Row 2: Request Status, Agent Types, System Performance
 * Matches: grid grid-cols-1 lg:grid-cols-3 gap-6 mt-5
 * Each card: border rounded-lg p-5, chart height ~280px + legend ~80px
 */
export function ChartRow2Skeleton() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-5" data-testid="chart-row-2-skeleton">
      {[0, 1, 2].map((i) => (
        <div key={i} className="border border-border rounded-lg p-5">
          <div className="mb-4">
            <div className="h-5 w-36 bg-accent rounded animate-pulse mb-2" />
            <div className="h-4 w-48 bg-accent rounded animate-pulse" />
          </div>
          <div className="h-[280px] bg-accent rounded animate-pulse" />
          <div className="flex flex-col mt-4 gap-2">
            {[0, 1, 2].map((j) => (
              <div key={j} className="h-4 bg-accent rounded animate-pulse" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Skeleton for Row 3: Monthly Cost Trend, Pipeline Stage Performance
 * Matches: flex gap-6 mt-5, each card w-1/2 with chart height 300px + metrics
 */
export function ChartRow3Skeleton() {
  return (
    <div className="flex gap-6 mt-5" data-testid="chart-row-3-skeleton">
      {[0, 1].map((i) => (
        <div key={i} className="border border-border rounded-lg p-5 w-1/2">
          <div className="mb-4">
            <div className="h-5 w-44 bg-accent rounded animate-pulse mb-2" />
            <div className="h-4 w-56 bg-accent rounded animate-pulse" />
          </div>
          <div className="h-[300px] bg-accent rounded animate-pulse" />
          <div className="flex gap-3 mt-4">
            {[0, 1, 2].map((j) => (
              <div key={j} className="flex-1 rounded-lg p-2 h-16 bg-accent animate-pulse" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}


/**
 * Skeleton for Row 4: System Health, Recent Activity, Quick Actions
 * Matches: flex gap-6 mt-5 (two half-width cards) + full-width quick actions
 */
export function ChartRow4Skeleton() {
  return (
    <div data-testid="chart-row-4-skeleton">
      <div className="flex gap-6 mt-5">
        {[0, 1].map((i) => (
          <div key={i} className="bg-accent border border-border rounded-lg p-5 w-1/2">
            <div className="mb-6">
              <div className="h-5 w-32 bg-card rounded animate-pulse mb-2" />
              <div className="h-4 w-52 bg-card rounded animate-pulse" />
            </div>
            <div className="flex flex-col gap-4">
              {[0, 1, 2, 3, 4].map((j) => (
                <div key={j} className="h-8 bg-card rounded animate-pulse" />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="border border-border rounded-lg p-5 mt-5">
        <div className="mb-4">
          <div className="h-5 w-28 bg-accent rounded animate-pulse mb-2" />
          <div className="h-4 w-48 bg-accent rounded animate-pulse" />
        </div>
        <div className="flex flex-wrap gap-3">
          {[0, 1, 2, 3, 4].map((j) => (
            <div key={j} className="h-10 w-40 bg-accent rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    </div>
  );
}
