/**
 * eval-sampling-selector (Phase 2 §2.3) — production sampling entry point.
 *
 * Subscribes to terminal signals: `workflow.completed`/`workflow.failed`
 * (Source citadel.workflows) for EXECUTION-kind targets, and a
 * conversation-completion signal for CONVERSATION-kind targets (see the
 * EVENTBRIDGE_CATALOG.md entry for the current honest-gap status of the
 * conversation-side producer). Per event:
 *
 *  1. Resolve orgId/agentId, load EvalSamplingConfig, resolve the
 *     effective per-agent rate (org opt-in gates everything — a config
 *     that is absent or has optIn!==true always resolves rate=0).
 *  2. `shouldSample(runId, rate)` — deterministic/idempotent decision.
 *  3. IdempotencyGuard on runId so redelivery is a no-op (defence in
 *     depth alongside shouldSample's own determinism).
 *  4. Materialize a sanitized artifact by reusing `assembleReplayPackage`
 *     VERBATIM, written under `prod-samples/{orgId}/{runId}.json`
 *     (distinct from `eval-runs/`). If the fail-closed sanitisation gate
 *     throws (or ANY error occurs during materialization), the sample is
 *     DROPPED — logged, no S3 write, no event. A sample that cannot be
 *     sanitized is never judged.
 *  5. Emit `governance.eval.sample.captured` with the fixed dimension
 *     allowlist (PROD_DIMENSION_ORDER — deliberately EXCLUDES
 *     task_success/tool_accuracy, since no per-case expectation exists
 *     for a production sample).
 *
 * Never throws out of the handler for a single event's processing
 * failure — an unsampled/dropped/errored signal must never fail the
 * EventBridge delivery and retry loop for what is, by design, a
 * best-effort observability side-channel, not a critical path.
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { IdempotencyGuard } from "../utils/idempotency";
import { emitGovernanceEvent } from "../utils/notifier-base";
import {
  assembleReplayPackage,
  type ReplayKind,
} from "./utils/replay-package-builder";
import {
  getEvalSamplingConfig,
  resolveEffectiveRate,
  shouldSample,
} from "./utils/eval-sampling-config";
import { resolveReplayBucketName } from "./utils/eval-artifact-store";
import { PROD_DIMENSION_ORDER } from "./utils/eval-prod-scoring";

const s3Client = new S3Client({});

const EVAL_SAMPLING_CONFIG_TABLE = process.env.EVAL_SAMPLING_CONFIG_TABLE!;
const IDEMPOTENCY_TABLE = process.env.IDEMPOTENCY_TABLE!;

let _idempotencyGuard: IdempotencyGuard | null = null;
function idempotencyGuard(): IdempotencyGuard {
  if (!_idempotencyGuard) {
    _idempotencyGuard = new IdempotencyGuard(IDEMPOTENCY_TABLE);
  }
  return _idempotencyGuard;
}

export interface TerminalSignalInput {
  runId: string;
  orgId: string;
  agentId: string;
  kind: ReplayKind;
  /** executionId (kind=execution) or conversationId (kind=conversation) —
   * the id assembleReplayPackage needs to build the envelope. */
  sourceId: string;
}

function prodSampleKey(orgId: string, runId: string): string {
  return `prod-samples/${orgId}/${runId}.json`;
}

/**
 * Materializes + writes the sanitized prod-sample artifact and emits the
 * capture event. Isolated from the opt-in/rate/idempotency gating above
 * so the "drop on any failure" contract is a single, simple try/catch
 * around exactly this step.
 */
async function materializeAndEmit(input: TerminalSignalInput): Promise<void> {
  let envelope: unknown;
  try {
    envelope = await assembleReplayPackage(
      input.orgId,
      input.kind,
      input.sourceId,
    );
  } catch (err: unknown) {
    // Fail-closed drop: the sanitisation gate (or any other build-time
    // error) throwing means this sample is NEVER written, NEVER judged.
    console.error(
      "eval-sampling-selector: assembleReplayPackage failed — dropping sample (fail-closed)",
      {
        runId: input.runId,
        orgId: input.orgId,
        kind: input.kind,
        error: err instanceof Error ? err.message : String(err),
      },
    );
    return;
  }

  const bucketName = await resolveReplayBucketName();
  if (!bucketName) {
    console.warn(
      "eval-sampling-selector: replay bucket unresolved — dropping sample",
      { runId: input.runId, orgId: input.orgId },
    );
    return;
  }

  const key = prodSampleKey(input.orgId, input.runId);

  try {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: key,
        Body: JSON.stringify(envelope),
        ContentType: "application/json",
      }),
    );
  } catch (err: unknown) {
    console.error("eval-sampling-selector: S3 write failed — dropping sample", {
      runId: input.runId,
      orgId: input.orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  try {
    await emitGovernanceEvent("governance.eval.sample.captured", {
      sampleId: input.runId,
      orgId: input.orgId,
      agentId: input.agentId,
      runId: input.runId,
      kind: input.kind,
      artifactRef: key,
      dimensions: [...PROD_DIMENSION_ORDER],
    });
  } catch (err: unknown) {
    // Best-effort — the artifact is already durably written; a failed
    // event emission is logged but does not retro-actively delete it.
    // The case is simply not picked up by eval-sample-scorer until a
    // future redelivery/backfill.
    console.error(
      "eval-sampling-selector: emit governance.eval.sample.captured failed",
      {
        runId: input.runId,
        orgId: input.orgId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
}

/**
 * Entry point shared by both terminal-signal shapes. Never throws — any
 * unexpected error anywhere in the gating/materialization pipeline is
 * caught, logged, and treated as "sample dropped" rather than propagated,
 * since this is a best-effort side-channel that must never affect the
 * primary workflow/conversation completion path.
 */
export async function handleTerminalSignal(
  input: TerminalSignalInput,
): Promise<void> {
  try {
    const config = await getEvalSamplingConfig(
      EVAL_SAMPLING_CONFIG_TABLE,
      input.orgId,
    );
    const rate = resolveEffectiveRate(config, input.agentId);
    if (rate <= 0) return;

    if (!shouldSample(input.runId, rate)) return;

    await idempotencyGuard().withIdempotency(input.runId, async () => {
      await materializeAndEmit(input);
    });
  } catch (err: unknown) {
    console.error(
      "eval-sampling-selector: handleTerminalSignal failed — sample dropped",
      {
        runId: input.runId,
        orgId: input.orgId,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  }
}

interface WorkflowCompletionDetail {
  executionId?: string;
  workflowId?: string;
  orgId?: string;
  agentId?: string;
  runId?: string;
}

interface ConversationCompleteDetail {
  conversationId?: string;
  orgId?: string;
  agentId?: string;
  runId?: string;
}

/**
 * Lambda entry point, discriminated by EventBridge detail-type:
 *  - `workflow.completed` / `workflow.failed` (Source citadel.workflows)
 *    -> EXECUTION-kind sampling candidate.
 *  - `conversation.completed` (Source citadel.conversations) ->
 *    CONVERSATION-kind sampling candidate. See EVENTBRIDGE_CATALOG.md for
 *    the current status of this event's producer.
 *
 * A signal missing the fields needed to build a TerminalSignalInput
 * (no runId, no orgId, no source id) is skipped — never fabricated, per
 * the same "never invent a runId" discipline as run-id.ts.
 */
export const handler = async (event: {
  "detail-type"?: string;
  detail?: WorkflowCompletionDetail | ConversationCompleteDetail;
}): Promise<void> => {
  const detailType = event["detail-type"];

  if (detailType === "workflow.completed" || detailType === "workflow.failed") {
    const detail = event.detail as WorkflowCompletionDetail;
    const sourceId = detail.executionId;
    if (!sourceId || !detail.orgId || !detail.agentId || !detail.runId) {
      return;
    }
    await handleTerminalSignal({
      runId: detail.runId,
      orgId: detail.orgId,
      agentId: detail.agentId,
      kind: "execution",
      sourceId,
    });
    return;
  }

  if (detailType === "conversation.completed") {
    const detail = event.detail as ConversationCompleteDetail;
    const sourceId = detail.conversationId;
    if (!sourceId || !detail.orgId || !detail.agentId || !detail.runId) {
      return;
    }
    await handleTerminalSignal({
      runId: detail.runId,
      orgId: detail.orgId,
      agentId: detail.agentId,
      kind: "conversation",
      sourceId,
    });
    return;
  }

  console.error("eval-sampling-selector: unrecognized detail-type — no-op", {
    detailType,
  });
};
