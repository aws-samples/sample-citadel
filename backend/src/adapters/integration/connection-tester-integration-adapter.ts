/**
 * ConnectionTesterIntegrationAdapter
 *
 * Canonical adapter for integration connector types whose `testConnection`
 * implementation lives in `backend/src/utils/connection-tester.ts`.
 *
 * Why this class exists
 * ---------------------
 * `BaseIntegrationAdapter.testConnection` deliberately throws
 * `NotImplementedError` so that any connector type wrapped in a bare base
 * instance fails loudly. That backstop replaces an earlier silent-success
 * regression where every entry in `BACKEND_CONNECTOR_REGISTRY` returned
 * `{ success: true, message: '... placeholder' }` — masking real connection
 * failures.
 *
 * To provide real behavior, every entry in the unified registry whose
 * connection check is implemented in `utils/connection-tester` MUST be
 * wrapped in this subclass rather than the bare base. This keeps the
 * unified-registry path (`UnifiedRegistry.getAdapter().testConnection()`)
 * structurally equivalent to the AppSync path
 * (`integration-resolver` -> `connection-tester.testConnection`).
 *
 * Boundaries
 * ----------
 *  - `connect` / `disconnect` are NOT overridden — integrations connect via
 *    EventBridge events, not direct adapter calls. The base class no-ops are
 *    intentional and preserved.
 *  - This class does not implement OAuth2 token exchange, retries, or
 *    credential rotation. Those concerns live in `connection-tester` itself.
 *  - This class does not catch errors from `connection-tester`. Errors
 *    propagate to the caller so failures stay visible.
 */

import { BaseIntegrationAdapter } from './base-integration-adapter';
import { ConnectionTestResult, ConnectorSpec } from '../base';
import { testConnection as runConnectionTest } from '../../utils/connection-tester';

export class ConnectionTesterIntegrationAdapter extends BaseIntegrationAdapter {
  constructor(spec: Omit<ConnectorSpec, 'category'>) {
    super(spec);
  }

  /**
   * Delegates to `utils/connection-tester.testConnection`, matching its
   * signature exactly: `(connectorType, credentials, config)`.
   *
   * `TestResult` from connection-tester (with required `details`) is
   * structurally a `ConnectionTestResult` (with optional `details`); the
   * value is returned unchanged.
   */
  async testConnection(
    config: Record<string, unknown>,
    credentials?: Record<string, unknown>
  ): Promise<ConnectionTestResult> {
    return runConnectionTest(
      this.spec.type,
      credentials as Parameters<typeof runConnectionTest>[1],
      config as Parameters<typeof runConnectionTest>[2]
    );
  }
}
