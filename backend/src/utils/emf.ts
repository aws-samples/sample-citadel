/**
 * Hand-rolled CloudWatch Embedded Metric Format (EMF) emitter.
 *
 * Wave 0 intake instrumentation — OBSERVABILITY ONLY. One flush = one
 * structured-JSON line on stdout (a single console.log call) carrying the
 * `_aws.CloudWatchMetrics` envelope; Lambda ships stdout to CloudWatch Logs,
 * where EMF is translated into metrics automatically. No dependency on
 * aws-embedded-metrics (deliberately hand-rolled — the package is not in this
 * project's dependency set and this envelope is tiny).
 *
 * Conventions:
 * - Namespace defaults to `Citadel/Intake`.
 * - Dimensions default to `{ Environment: process.env.ENVIRONMENT || 'dev' }`.
 *   Keep dimensions LOW-cardinality; high-cardinality identifiers (sessionId,
 *   requestId) belong in `properties`, which land as top-level log fields that
 *   are queryable in Logs Insights but do NOT create metric dimensions.
 * - NEVER throws. Metrics must never break the handler: all failures are
 *   swallowed (and logged via console.error for operator visibility).
 */

/** A single metric datum within one EMF flush. */
export interface EmfMetric {
  name: string;
  value: number;
  /** CloudWatch unit; defaults to `Milliseconds`. */
  unit?: string;
}

export interface EmitMetricsOptions {
  metrics: EmfMetric[];
  /** High-cardinality log-only fields (e.g. sessionId, requestId). */
  properties?: Record<string, unknown>;
  /** Metric namespace; defaults to `Citadel/Intake`. */
  namespace?: string;
  /** Dimension key/value pairs; defaults to `{ Environment: $ENVIRONMENT }`. */
  dimensions?: Record<string, string>;
}

const DEFAULT_NAMESPACE = "Citadel/Intake";
const DEFAULT_UNIT = "Milliseconds";

/**
 * Emit one EMF-formatted line to stdout (single console.log call).
 *
 * Invalid metric values (non-finite / non-number) are dropped; when no valid
 * metric remains, nothing is emitted. If the payload cannot be serialised
 * (e.g. a circular property), the flush retries once WITHOUT properties so
 * the metrics themselves are not lost. Never throws.
 */
export function emitMetrics(options: EmitMetricsOptions): void {
  try {
    if (!options || !Array.isArray(options.metrics)) {
      return;
    }

    const metrics = options.metrics.filter(
      (m): m is EmfMetric =>
        !!m &&
        typeof m.name === "string" &&
        m.name.length > 0 &&
        typeof m.value === "number" &&
        Number.isFinite(m.value),
    );
    if (metrics.length === 0) {
      return;
    }

    const namespace = options.namespace || DEFAULT_NAMESPACE;
    const dimensions = options.dimensions ?? {
      Environment: process.env.ENVIRONMENT || "dev",
    };

    const buildBlob = (withProperties: boolean): Record<string, unknown> => {
      const blob: Record<string, unknown> = {
        // Properties first so reserved keys below always win on collision.
        ...(withProperties && options.properties ? options.properties : {}),
        ...dimensions,
      };
      for (const metric of metrics) {
        blob[metric.name] = metric.value;
      }
      blob._aws = {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: namespace,
            Dimensions: [Object.keys(dimensions)],
            Metrics: metrics.map((m) => ({
              Name: m.name,
              Unit: m.unit || DEFAULT_UNIT,
            })),
          },
        ],
      };
      return blob;
    };

    let line: string;
    try {
      line = JSON.stringify(buildBlob(true));
    } catch {
      // Unserialisable properties (e.g. circular) — keep the metrics anyway.
      line = JSON.stringify(buildBlob(false));
    }

    console.log(line);
  } catch (err) {
    // Metrics must never break the caller — swallow, but keep it observable.
    console.error("emf: emit failed", err);
  }
}
