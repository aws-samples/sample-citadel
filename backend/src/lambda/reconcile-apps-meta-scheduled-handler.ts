import { runReconciliation } from '../../scripts/reconcile-apps-meta';

/**
 * EventBridge-scheduled reconciler. Runs in --apply mode every 6h to mirror
 * any Registry agent records that don't have an AppsTable #META row
 * (e.g. Fabricator-created agents that bypassed the synchronous resolver
 * write, or any drift caused by transient DDB write failures).
 *
 * Stale and orphan rows are logged but not auto-repaired — admins decide
 * (matches the CLI script's contract).
 */
export const handler = async (): Promise<{
  statusCode: number;
  body: string;
}> => {
  try {
    const summary = await runReconciliation({ apply: true });
    console.log(
      '[reconcile-apps-meta-scheduled] summary:',
      JSON.stringify(summary),
    );
    return { statusCode: 200, body: JSON.stringify(summary) };
  } catch (err) {
    console.error('[reconcile-apps-meta-scheduled] failed:', err);
    throw err; // let Lambda retry policy handle it
  }
};
