/**
 * eval-evaluator-registry.ts (CIT-107) — pluggable evaluator interface +
 * registry. Mirrors the AgentSourceAdapterRegistry precedent
 * (backend/src/adapters/agent-source/base.ts +
 * registry-factory.ts): a small, fully-typed interface plus a single
 * registry that is the ONLY lookup point for evaluator-id -> evaluator
 * dispatch. A custom evaluator registers itself and contributes a
 * dimension to run reports WITHOUT any change to eval-scoring.ts,
 * eval-score-aggregate.ts, or eval-case-scorer.ts — the acceptance
 * criterion from the story.
 *
 * `dimension` in eval-scoring.ts is a closed union (`DimensionName`) —
 * deliberately NOT widened here. A custom evaluator's dimension name is
 * an arbitrary string (see EvaluatorDimensionScore), so `runAll()`
 * returns a wider type than `DimensionScore[]`; callers that persist a
 * combined vector go through `mergeEvaluatorResults`
 * (eval-evaluator-compose.ts) rather than assuming canonicalScoreVector
 * accepts custom names.
 */
import type {
  DimensionName,
  DimensionStatus,
  EvalCaseForScoring,
  EvalCaseRowForScoring,
  ScoreBasis,
  ScoringArtifact,
} from "./eval-scoring";

/** Either a built-in DimensionName or an org-defined custom dimension id. */
export type EvaluatorDimensionName = DimensionName | string;

/**
 * Same shape as eval-scoring.ts's DimensionScore, but with a widened
 * `dimension` so a custom evaluator can name its own dimension. Built-in
 * evaluators (the eval-scoring.ts adapter) still only ever populate
 * DimensionName values here.
 */
export interface EvaluatorDimensionScore {
  dimension: EvaluatorDimensionName;
  status: DimensionStatus;
  basis: ScoreBasis;
  verdict?:
    { kind: "boolean"; pass: boolean } | { kind: "score"; score: number };
  measurement?: number | null;
  judgeModelId?: string;
  judgeModelVersion?: string;
  judgePromptHash?: string;
  detail: string;
}

/**
 * The pluggable evaluator contract: score one eval case's artifacts and
 * return zero or more dimension scores. `dimensions` declares which
 * dimension name(s) this evaluator is expected to contribute — used for
 * registry introspection/reporting. It is NOT enforced by
 * EvaluatorRegistry.runAll() or by validateExternalScoreVector() against
 * an in-process (trusted, first-party) Evaluator's return value — an
 * in-process evaluator is trusted code, same trust level as the built-in
 * scorer, so no additional gate is applied here.
 *
 * For an EXTERNAL (Lambda/HTTP) evaluator built via
 * createExternalEvaluator (eval-external-evaluator-adapter.ts), this
 * allowlist IS enforced — but at that adapter's boundary, not here in
 * the registry. `createExternalEvaluator`'s score() drops (and logs) any
 * per-field-valid response entry whose `dimension` is outside the
 * evaluator's own declared `dimensions[]`, before the result is ever
 * returned to runAll(). The registry itself remains transport-agnostic
 * and never inspects `dimensions` against `score()`'s output; the
 * external-adapter boundary is where declared-vs-actual enforcement
 * belongs, because that is the one place with both untrusted response
 * data and the owning evaluator's declaration in scope.
 */
export interface Evaluator {
  /** Unique registry key. Convention: `builtin.core` for the adapted
   * built-in scorer; org-registered evaluators use a namespaced id
   * (e.g. `org.<orgId>.<name>`) to avoid collisions across tenants. */
  id: string;
  /** Dimension name(s) this evaluator contributes. */
  dimensions: EvaluatorDimensionName[];
  score(
    caseRow: EvalCaseRowForScoring,
    artifact: ScoringArtifact,
    evalCase: EvalCaseForScoring,
  ): EvaluatorDimensionScore[] | Promise<EvaluatorDimensionScore[]>;
}

/**
 * Thrown by {@link EvaluatorRegistry.resolve} when no evaluator is
 * registered under the requested id. Typed (not a generic Error) so
 * callers can branch via `instanceof`, mirroring UnknownProtocolError.
 */
export class UnknownEvaluatorError extends Error {
  public readonly evaluatorId: string;

  constructor(evaluatorId: string) {
    super(`No evaluator registered with id: ${evaluatorId}`);
    this.name = "UnknownEvaluatorError";
    this.evaluatorId = evaluatorId;
    Object.setPrototypeOf(this, UnknownEvaluatorError.prototype);
  }
}

/**
 * The single lookup point for evaluator-id -> evaluator dispatch.
 * Concrete evaluators (the built-in adapter, org-registered external
 * evaluators) register themselves under a unique id; callers resolve/run
 * through this registry rather than invoking evaluator instances
 * directly.
 */
export class EvaluatorRegistry {
  private readonly evaluators = new Map<string, Evaluator>();

  /** Register (or replace) the evaluator for its declared id. */
  register(evaluator: Evaluator): void {
    this.evaluators.set(evaluator.id, evaluator);
  }

  /**
   * Resolve the evaluator for an id.
   * @throws {UnknownEvaluatorError} when no evaluator is registered.
   */
  resolve(evaluatorId: string): Evaluator {
    const evaluator = this.evaluators.get(evaluatorId);
    if (!evaluator) {
      throw new UnknownEvaluatorError(evaluatorId);
    }
    return evaluator;
  }

  /** True when an evaluator is registered under the id. */
  has(evaluatorId: string): boolean {
    return this.evaluators.has(evaluatorId);
  }

  /** All registered evaluators, in registration order. */
  list(): Evaluator[] {
    return [...this.evaluators.values()];
  }

  /**
   * Runs every registered evaluator's score() against the same
   * case/artifact/evalCase input and flattens the results. An evaluator
   * that throws (or rejects) is isolated: its error is logged and its
   * contribution is dropped — it never aborts the other evaluators' runs
   * and never poisons the combined result (mirrors the story's "malformed
   * external scores are rejected, never poison the vector" acceptance
   * criterion at the registry-fan-out level; per-field rejection of an
   * external evaluator's response happens one layer down, in
   * eval-external-evaluator.ts).
   */
  async runAll(
    caseRow: EvalCaseRowForScoring,
    artifact: ScoringArtifact,
    evalCase: EvalCaseForScoring,
  ): Promise<EvaluatorDimensionScore[]> {
    const results: EvaluatorDimensionScore[] = [];
    for (const evaluator of this.list()) {
      try {
        const scores = await evaluator.score(caseRow, artifact, evalCase);
        results.push(...scores);
      } catch (err) {
        console.error(
          "eval-evaluator-registry: evaluator threw — dropping its contribution",
          {
            evaluatorId: evaluator.id,
            error: err instanceof Error ? err.message : String(err),
          },
        );
      }
    }
    return results;
  }
}
