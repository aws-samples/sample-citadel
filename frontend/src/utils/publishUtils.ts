/**
 * Mask an API key, showing only the 8-char prefix followed by asterisks.
 * @param prefix - The 8-character prefix of the API key
 * @returns The prefix followed by 8 asterisks (total length 16)
 */
export function maskApiKey(prefix: string): string {
  return prefix + '********';
}

export type HealthStatus = 'green' | 'yellow' | 'red';

export interface Precondition {
  label: string;
  passed: boolean;
  detail?: string;
}

/**
 * Compute health status from error rate.
 * @param errorRate - The error rate as a decimal (e.g. 0.05 = 5%)
 * @returns 'green' if < 0.05, 'yellow' if <= 0.15, 'red' otherwise
 */
export function getHealthStatus(errorRate: number): HealthStatus {
  if (errorRate < 0.05) return 'green';
  if (errorRate <= 0.15) return 'yellow';
  return 'red';
}

/**
 * Determine if publish action should be enabled based on preconditions.
 * @param preconditions - Array of precondition checks
 * @returns true if all preconditions exist and pass
 */
export function shouldEnablePublish(preconditions: Precondition[]): boolean {
  return preconditions.length > 0 && preconditions.every((p) => p.passed);
}
