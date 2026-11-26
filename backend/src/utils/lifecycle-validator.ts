/**
 * Integration Lifecycle Validator
 * 
 * Ensures status transitions follow the defined lifecycle:
 * CREATED → CONFIGURED → TESTED → CONNECTED
 * 
 * Also supports:
 * - DISCONNECTED (from CONNECTED)
 * - CONNECTION_FAILED (from CONNECTING)
 * - CONNECTING (from TESTED or CONFIGURED)
 * Updated: 2026-02-13
 */

export type IntegrationStatus = 
  | 'CREATED'
  | 'CONFIGURED'
  | 'TESTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'DISCONNECTED'
  | 'CONNECTION_FAILED'
  | 'CONFIGURING';

/**
 * Valid status transitions map
 * Key: current status
 * Value: array of valid next statuses
 */
const VALID_TRANSITIONS: Record<IntegrationStatus, IntegrationStatus[]> = {
  CREATED: ['CONFIGURED', 'CONFIGURING'],
  CONFIGURING: ['CONFIGURED', 'CREATED'],
  CONFIGURED: ['TESTED', 'CONNECTING', 'CONFIGURED'], // Can re-configure
  TESTED: ['CONNECTING', 'CONFIGURED', 'TESTED'], // Can re-test or re-configure
  CONNECTING: ['CONNECTED', 'CONNECTION_FAILED'],
  CONNECTED: ['DISCONNECTED', 'CONFIGURED'], // Can disconnect or re-configure
  DISCONNECTED: ['CONFIGURED', 'CONNECTING'], // Can re-configure or reconnect
  CONNECTION_FAILED: ['CONFIGURED', 'CONNECTING', 'TESTED'], // Can re-configure, retry, or test again
};

/**
 * Validates if a status transition is allowed
 * 
 * @param currentStatus - The current integration status
 * @param newStatus - The desired new status
 * @returns true if transition is valid, false otherwise
 */
export function isValidTransition(
  currentStatus: IntegrationStatus,
  newStatus: IntegrationStatus
): boolean {
  // Same status is always valid (idempotent operations)
  if (currentStatus === newStatus) {
    return true;
  }
  
  const validNextStatuses = VALID_TRANSITIONS[currentStatus];
  if (!validNextStatuses) {
    return false;
  }
  
  return validNextStatuses.includes(newStatus);
}

/**
 * Validates a status transition and throws an error if invalid
 * 
 * @param currentStatus - The current integration status
 * @param newStatus - The desired new status
 * @throws Error if transition is invalid
 */
export function validateTransition(
  currentStatus: IntegrationStatus,
  newStatus: IntegrationStatus
): void {
  if (!isValidTransition(currentStatus, newStatus)) {
    throw new Error(
      `Invalid status transition: ${currentStatus} → ${newStatus}. ` +
      `Valid transitions from ${currentStatus}: ${VALID_TRANSITIONS[currentStatus]?.join(', ') || 'none'}`
    );
  }
}

/**
 * Gets the list of valid next statuses for a given current status
 * 
 * @param currentStatus - The current integration status
 * @returns Array of valid next statuses
 */
export function getValidNextStatuses(
  currentStatus: IntegrationStatus
): IntegrationStatus[] {
  return VALID_TRANSITIONS[currentStatus] || [];
}

/**
 * Determines the appropriate status after a successful test
 * 
 * @param currentStatus - The current integration status
 * @returns The status to set after successful test
 */
export function getStatusAfterSuccessfulTest(
  _currentStatus: IntegrationStatus
): IntegrationStatus {
  // After successful test, status should be TESTED
  return 'TESTED';
}

/**
 * Determines the appropriate status after a failed test
 * 
 * @param currentStatus - The current integration status
 * @returns The status to set after failed test (remains in current state)
 */
export function getStatusAfterFailedTest(
  currentStatus: IntegrationStatus
): IntegrationStatus {
  // After failed test, status remains unchanged
  return currentStatus;
}

/**
 * Determines the appropriate status after connection attempt
 * 
 * @param success - Whether the connection was successful
 * @returns The status to set after connection attempt
 */
export function getStatusAfterConnection(success: boolean): IntegrationStatus {
  return success ? 'CONNECTED' : 'CONNECTION_FAILED';
}

/**
 * Checks if an integration is in a state where it can be tested
 * 
 * @param currentStatus - The current integration status
 * @returns true if integration can be tested
 */
export function canTest(currentStatus: IntegrationStatus): boolean {
  return ['CONFIGURED', 'TESTED', 'CONNECTED', 'DISCONNECTED', 'CONNECTION_FAILED'].includes(currentStatus);
}

/**
 * Checks if an integration is in a state where it can be connected
 * 
 * @param currentStatus - The current integration status
 * @returns true if integration can be connected
 */
export function canConnect(currentStatus: IntegrationStatus): boolean {
  return ['TESTED', 'CONFIGURED', 'DISCONNECTED', 'CONNECTION_FAILED'].includes(currentStatus);
}

/**
 * Checks if an integration is in a state where it can be disconnected
 * 
 * @param currentStatus - The current integration status
 * @returns true if integration can be disconnected
 */
export function canDisconnect(currentStatus: IntegrationStatus): boolean {
  return currentStatus === 'CONNECTED';
}
