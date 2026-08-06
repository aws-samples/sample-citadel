/**
 * eval-prod-scoring-io.ts (Phase 2 §2.4) — I/O layer for eval-sample-scorer.ts.
 *
 * Mirrors eval-scoring-io.ts's own split (pure scoring module + a thin,
 * I/O-performing sibling that maps a persisted/S3 shape onto the pure
 * scorer's input type) but for the prod-sample surface specifically. Kept
 * as its OWN module — not a reuse/extension of eval-scoring-io.ts — so
 * that eval-prod-scoring.ts's "no expectation type reachable" guarantee
 * cannot be defeated by a shared IO module accidentally importing
 * EvalCaseForScoring on the prod code path.
 *
 * Reads ONLY the sanitized S3 artifact (the same object
 * eval-sampling-selector.ts wrote under `prod-samples/{orgId}/{runId}.json`
 * via assembleReplayPackage) — never toolResults, same pinned invariant as
 * eval-scoring.ts/eval-scoring-io.ts.
 */
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { resolveReplayBucketName } from "./eval-artifact-store";
import type {
  ProdObservedArtifact,
  ProdScoringFinding,
} from "./eval-prod-scoring";

const s3Client = new S3Client({});

interface ReplayEnvelopeNode {
  nodeId: string;
  outputs: unknown;
  startedAt?: string | null;
  completedAt?: string | null;
  agentId?: string | null;
  status?: unknown;
}

interface ReplayEnvelopeSubset {
  kind?: "execution" | "conversation";
  sections?: {
    nodes?: ReplayEnvelopeNode[];
    findings?: unknown[] | { partial: true };
    messages?: Array<{ role: string; content: string }>;
    usageTotals?: unknown;
  };
}

const TOOL_PERMITTED_PREFIX = "tool_permitted:not_on_deny_list:";
const KB_TOOL_PERMITTED = `${TOOL_PERMITTED_PREFIX}query_knowledge_base`;

function findingsFromSection(
  findings: unknown[] | { partial: true } | undefined,
): ProdScoringFinding[] {
  if (!findings || !Array.isArray(findings)) return [];
  return findings
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f) => ({
      decision: typeof f.decision === "string" ? f.decision : "",
      reason: typeof f.reason === "string" ? f.reason : "",
    }));
}

function orderingKey(value: string | null | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function buildSteps(nodes: ReplayEnvelopeNode[]) {
  const sorted = [...nodes].sort((a, b) => {
    const startDiff = orderingKey(a.startedAt) - orderingKey(b.startedAt);
    if (startDiff !== 0) return startDiff;
    const completeDiff =
      orderingKey(a.completedAt) - orderingKey(b.completedAt);
    if (completeDiff !== 0) return completeDiff;
    return a.nodeId.localeCompare(b.nodeId);
  });
  return sorted.map((n, i) => ({
    stepIndex: i,
    nodeId: n.nodeId,
    agentId: typeof n.agentId === "string" ? n.agentId : null,
    status: typeof n.status === "string" ? n.status : null,
  }));
}

function buildToolSet(findings: ProdScoringFinding[]): string[] {
  const tools = new Set<string>();
  for (const f of findings) {
    if (f.reason.startsWith(TOOL_PERMITTED_PREFIX)) {
      tools.add(f.reason.slice(TOOL_PERMITTED_PREFIX.length));
    }
  }
  return [...tools].sort();
}

/**
 * Reads the sanitized prod-sample S3 object and maps it to
 * ProdObservedArtifact. Returns `undefined` on ANY failure (missing
 * bucket, missing object, parse error) — the caller (eval-sample-scorer.ts)
 * treats an undefined artifact as "drop, do not score" rather than
 * fabricating an empty-but-present artifact.
 */
export async function readSanitizedArtifact(
  artifactRef: string,
  latencyMs?: number,
  costRows?: ProdObservedArtifact["costRows"],
): Promise<ProdObservedArtifact | undefined> {
  try {
    const bucketName = await resolveReplayBucketName();
    if (!bucketName) return undefined;

    const res = await s3Client.send(
      new GetObjectCommand({ Bucket: bucketName, Key: artifactRef }),
    );
    const text = await res.Body?.transformToString();
    if (!text) return undefined;
    const envelope = JSON.parse(text) as ReplayEnvelopeSubset;

    const nodes = envelope.sections?.nodes ?? [];
    const messages = envelope.sections?.messages ?? [];
    const findings = findingsFromSection(envelope.sections?.findings);
    const toolSet = buildToolSet(findings);
    const kbConsulted = findings.some((f) => f.reason === KB_TOOL_PERMITTED);

    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === "assistant");
    const citationText =
      envelope.kind === "conversation"
        ? (lastAssistant?.content ?? "")
        : nodes
            .map((n) =>
              typeof n.outputs === "string"
                ? n.outputs
                : JSON.stringify(n.outputs ?? ""),
            )
            .join("\n");

    return {
      findings,
      observedTrajectory: {
        steps: envelope.kind === "conversation" ? [] : buildSteps(nodes),
        turnCount: messages.filter((m) => m.role === "assistant").length,
        toolSet,
        toolOrder: null,
      },
      kbConsulted,
      citationText,
      latencyMs,
      costRows: costRows ?? [],
    };
  } catch (err: unknown) {
    console.error(
      "eval-prod-scoring-io: readSanitizedArtifact failed — treating as unscoreable",
      { artifactRef, error: err instanceof Error ? err.message : String(err) },
    );
    return undefined;
  }
}
