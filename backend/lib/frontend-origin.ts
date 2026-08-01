/**
 * Frontend origin resolution for TelemetryStack's cost API CORS config.
 *
 * Precedence: FRONTEND_ORIGIN env var > CDK context `frontendOrigin` > a
 * non-resolvable placeholder. The placeholder exists so `cdk synth` never
 * throws for a fresh account: FrontendStack deploys AFTER TelemetryStack
 * (see deploy.sh dependency graph comment in bin/app.ts), so on a first-ever
 * deploy there is no real origin to source yet. A hard throw here would
 * brick bootstrap. Instead, the placeholder is deliberately non-resolvable
 * (`*.invalid` TLD, RFC 2606) so it can never accidentally match a real
 * browser Origin header, and callers are warned loudly so the gap doesn't
 * go unnoticed.
 */

export const FRONTEND_ORIGIN_PLACEHOLDER =
  "https://frontend-origin-not-configured.invalid";

/** Environments where the placeholder should NOT trigger a warning. */
const SILENT_ENVIRONMENTS = new Set(["local", "test"]);

export interface FrontendOriginResolution {
  /** The resolved origin, normalized (no trailing slash). */
  origin: string;
  /** True if the placeholder was used (env var and context were both unset/empty). */
  isPlaceholder: boolean;
}

/**
 * Strips a single trailing slash from an origin string, if present.
 * Does not otherwise validate or parse the URL.
 */
export function normalizeOrigin(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * Resolves the frontend origin from env var, then CDK context, then a
 * placeholder — normalizing away any trailing slash. Never throws.
 */
export function resolveFrontendOrigin(
  envValue: string | undefined,
  contextValue: string | undefined,
): FrontendOriginResolution {
  const raw = envValue || contextValue;
  if (raw) {
    return { origin: normalizeOrigin(raw), isPlaceholder: false };
  }
  return { origin: FRONTEND_ORIGIN_PLACEHOLDER, isPlaceholder: true };
}

/**
 * Returns true if a loud warning should be emitted for placeholder use in
 * the given environment. Local/test synths are expected to run without a
 * real frontend origin and should stay quiet.
 */
export function shouldWarnOnPlaceholder(environment: string): boolean {
  return !SILENT_ENVIRONMENTS.has(environment.toLowerCase());
}

/** Exact remediation command text surfaced in the CDK Annotations warning. */
export function remediationMessage(environment: string): string {
  return (
    `FRONTEND_ORIGIN is not configured for environment "${environment}" — ` +
    `the cost API's CORS policy is using a non-resolvable placeholder origin ` +
    `(${FRONTEND_ORIGIN_PLACEHOLDER}), so browser requests from the real ` +
    `frontend WILL be blocked by CORS until this is fixed. This is expected ` +
    `on a fresh-account bootstrap deploy, where FrontendStack has not deployed ` +
    `yet (see deploy.sh dependency order). Remediate by setting FRONTEND_ORIGIN ` +
    `and redeploying the telemetry stack, e.g.: ` +
    `FRONTEND_ORIGIN=$(aws cloudformation describe-stacks ` +
    `--stack-name citadel-frontend-${environment} ` +
    `--query "Stacks[0].Outputs[?OutputKey=='FrontendUrl'].OutputValue" ` +
    `--output text) ./deploy.sh citadel-telemetry-${environment}`
  );
}
