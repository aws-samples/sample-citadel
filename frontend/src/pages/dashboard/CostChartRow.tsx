/**
 * Dashboard Cost Row: Cost Over Time, By App, By Model, By Agent
 * Lazy-loaded — rendered when scrolled into view, same as ChartRow2-4.
 *
 * Follows ChartRow4's self-fetching pattern: this component owns its own
 * data fetching (via costService) rather than receiving it as props.
 *
 * Graceful degradation: when the cost API isn't configured for this
 * deployment (`costService.isAvailable()` false), the whole row renders
 * nothing — no panels, no fetch attempts, no error banners. This is a
 * deliberate "hide, don't error" choice per the architect design, since an
 * unconfigured cost surface is an expected state for local dev / partial
 * deployments, not a failure.
 */
import { useEffect, useState } from 'react';
import { costService } from '../../services/costService';
import type { CostSeriesResponse, CostSummaryResponse } from '../../services/costService';
import { CostOverTimeChart } from '../../components/cost/CostOverTimeChart';
import { CostByDimensionChart } from '../../components/cost/CostByDimensionChart';
import { useMetricsAutoRefresh } from '../../hooks/useMetricsAutoRefresh';

export default function CostChartRow() {
  const [available, setAvailable] = useState(false);
  const [series, setSeries] = useState<CostSeriesResponse | null>(null);
  const [byApp, setByApp] = useState<CostSummaryResponse | null>(null);
  const [byModel, setByModel] = useState<CostSummaryResponse | null>(null);
  const [byAgent, setByAgent] = useState<CostSummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchAll = async () => {
    if (!costService.isAvailable()) {
      setAvailable(false);
      return;
    }
    setAvailable(true);

    const [seriesResult, appResult, modelResult, agentResult] = await Promise.all([
      costService.getSeries('org', undefined, 'day'),
      costService.getSummary('app'),
      costService.getSummary('model'),
      costService.getSummary('agent'),
    ]);

    if (seriesResult.available) setSeries(seriesResult.data);
    if (appResult.available) setByApp(appResult.data);
    if (modelResult.available) setByModel(modelResult.data);
    if (agentResult.available) setByAgent(agentResult.data);
  };

  useEffect(() => {
    setLoading(true);
    fetchAll()
      .catch(() => {
        // Graceful degradation: a genuine fetch/auth error (as opposed to
        // "unconfigured") still shouldn't crash the dashboard — panels
        // simply keep their last-known (or empty) state.
        console.warn('CostChartRow: failed to load cost data');
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useMetricsAutoRefresh({
    enabled: available,
    onRefresh: () => {
      fetchAll().catch(() => console.warn('CostChartRow: failed to refresh cost data'));
    },
  });

  if (!available && !loading) {
    return null;
  }

  return (
    <div data-testid="cost-chart-row" className="mt-5">
      <div className="mb-4">
        <h3 className="text-foreground text-lg font-semibold mb-1">Cost</h3>
        <p className="text-muted-foreground text-sm">Estimated model invocation spend across the organization</p>
      </div>
      <div className="grid grid-cols-1 gap-4 mb-4">
        <CostOverTimeChart data={series} loading={loading} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        <CostByDimensionChart title="Cost by App" description="Estimated spend by app" data={byApp} loading={loading} />
        <CostByDimensionChart title="Cost by Model" description="Estimated spend by model" data={byModel} loading={loading} />
      </div>
      <div className="grid grid-cols-1 gap-4">
        <CostByDimensionChart title="Cost by Agent" description="Estimated spend by agent" data={byAgent} loading={loading} />
      </div>
    </div>
  );
}
