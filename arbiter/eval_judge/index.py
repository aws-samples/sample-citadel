"""arbiter/eval_judge/index.py (CIT-103 Pass B) — judge-basis dimension
scorer Lambda.

Consumes ``governance.eval.case.judge.requested`` (TS -> Py, FROZEN
contract, design §1/§7 + Pass A report). For each requested dimension:

1. Resolves the effective model for the ``"judge"`` slot via the shared,
   pure ``common.model_resolver.resolve_model`` (``requires_converse=True``,
   modality=TEXT) — reusing the same precedence chain (agent -> org -> slot
   -> global -> bootstrap) and region-aware inference-profile mapping every
   other arbiter slot uses (design §1: "Slot name: judge — added to
   ModelConfig.slot_defaults; free-form slots ⇒ zero schema change").
2. Fetches the replay-package artifact the same way Pass A's TS consumer
   does: SSM ``GetParameter`` on the bucket-name param, then S3
   ``GetObject`` on ``eval-runs/{evalRunId}/{caseId}.json``
   (arbiter/../backend/src/lambda/utils/eval-artifact-store.ts naming,
   mirrored here so both sides agree on where an artifact lives without a
   second contract). Read-only — this module NEVER writes eval tables (the
   single-writer invariant is enforced entirely by never calling any
   DynamoDB write API; TS is the only writer, design §7).
3. Invokes Bedrock Converse at temperature=0 with a versioned+hashed
   judge-prompt template, wrapped so a malformed/unparseable response NEVER
   fabricates a score: the dimension is emitted ``status=UNKNOWN`` with no
   ``verdict`` key, only a structured warning log (the frozen judged
   payload has no ``detail`` field — see notifier-base.ts
   GovernancePayloadMap["governance.eval.case.judged"], verbatim).
4. Emits ``governance.eval.case.judged`` (Py -> TS, FROZEN) with the
   reproducibility stamp (judgeModelId/judgeModelVersion/judgePromptHash)
   ALWAYS present, regardless of parse outcome — the stamp describes which
   model was called, not whether its output parsed.

Contract-route note (per task instructions): the requested event already
carries everything the judge needs (evalRunId/caseId/orgId/artifactRef/
judgeDimensions/judgeSlot) — no additional read-only fetch from the eval
tables is required beyond the S3 artifact GetObject the frozen contract
already names. The judge never queries EvalCases/EvalRunCaseResults tables
directly; it works entirely from the event payload + artifact.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from typing import Any

from common.model_resolver import resolve_model
from common.model_types import Modality, SlotRequirements
from common.model_mapping import model_config_from_item, catalog_from_items
from common.region import cross_region_prefix

logger = logging.getLogger(__name__)

_SLOT = "judge"
JUDGE_SLOT_REQUIREMENTS = SlotRequirements(
    requires_tools=False,
    modality=Modality.TEXT,
    requires_converse=True,
)

_JUDGE_SYSTEM_PROMPT = """
You are an evaluation judge. Given a rubric and the relevant context from an
agent run, you MUST return ONLY a single JSON object (no prose, no markdown
fences) of the exact shape:
{"score": <number between 0 and 1 inclusive>}

Rules:
- Your entire output MUST be valid JSON and nothing else.
- The score MUST be a number in the closed interval [0, 1].
- Do not explain your reasoning in the output.
""".strip()

# Prompt-template version pinned alongside the system prompt above. Bumping
# either changes judgePromptHash for every future invocation, which is the
# point (design §1: "a prompt change is detectable").
_PROMPT_TEMPLATE_VERSION = "v1"

_JUDGEABLE_DIMENSIONS = {"task_success", "groundedness_faithfulness"}


# ---------------------------------------------------------------------------
# Lazily-constructed client factories (patched out in every test — no live
# AWS call in the suite; mirrors manifest_proposal.py's _invoke_model /
# supervisor's module-level boto3 clients, but as functions so each can be
# monkeypatched independently without a module reload).
# ---------------------------------------------------------------------------
def _bedrock_client():
    import boto3

    region = os.environ.get("AWS_REGION", "us-west-2")
    return boto3.client("bedrock-runtime", region_name=region)


def _ddb_resource():
    import boto3

    return boto3.resource("dynamodb")


def _ssm_client():
    import boto3

    region = os.environ.get("AWS_REGION", "us-west-2")
    return boto3.client("ssm", region_name=region)


def _s3_client():
    import boto3

    return boto3.client("s3")


def _events_client():
    import boto3

    region = os.environ.get("AWS_REGION", "us-west-2")
    return boto3.client("events", region_name=region)


# ---------------------------------------------------------------------------
# Model resolution.
# ---------------------------------------------------------------------------
def _resolve_judge_model():
    """Resolve the effective model for the "judge" slot.

    Reuses the full pure resolver (not the id-only
    ``resolve_model_id_from_items`` helper) because the reproducibility
    stamp needs ``model_key``/``source``/``profile_scope`` in addition to
    the resolved ``model_id``. Never raises: any I/O failure (missing env
    vars, missing/malformed DDB items) degrades to the bootstrap default,
    exactly like every other arbiter slot loader.
    """
    region = os.environ.get("AWS_REGION", "us-west-2")
    bootstrap_default = f"{cross_region_prefix(region)}.anthropic.claude-sonnet-4-6"
    try:
        config_table_name = os.environ.get("MODEL_CONFIG_TABLE")
        catalog_table_name = os.environ.get("MODEL_CATALOG_TABLE")
        if not config_table_name or not catalog_table_name:
            return _bootstrap_resolved_model(bootstrap_default)
        resource = _ddb_resource()
        config_item = resource.Table(config_table_name).get_item(
            Key={"scope": "platform"}
        ).get("Item")
        catalog_items = resource.Table(catalog_table_name).scan().get("Items", [])
        if not config_item:
            return _bootstrap_resolved_model(bootstrap_default)
        config = model_config_from_item(config_item)
        catalog = catalog_from_items(catalog_items or [])
        return resolve_model(
            _SLOT,
            JUDGE_SLOT_REQUIREMENTS,
            config,
            catalog,
            region,
            bootstrap_default,
        )
    except Exception as exc:  # noqa: BLE001 — never let resolution crash the judge
        logger.warning("eval_judge: judge slot resolution failed; using bootstrap default: %s", exc)
        return _bootstrap_resolved_model(bootstrap_default)


def _bootstrap_resolved_model(bootstrap_default_model_id: str):
    from common.model_types import ProfileScope, ResolutionSource, ResolvedModel

    return ResolvedModel(
        model_id=bootstrap_default_model_id,
        model_key=None,
        source=ResolutionSource.BOOTSTRAP,
        profile_scope=ProfileScope.NONE,
        warnings=("resolved via bootstrap default; no valid configured model",),
    )


def _judge_model_version(resolved) -> str:
    """Derive the reproducibility-stamp model-version string.

    Design §1 NEEDS-CONFIRM: CatalogEntry carries no explicit version field
    today, so the stable fallback is ``{model_key}:{profile_scope}``. When a
    resolution fell through to the bootstrap default (model_key is None),
    the resolved model_id itself is the most specific available identifier.
    """
    if resolved.model_key:
        return f"{resolved.model_key}:{resolved.profile_scope.value}"
    return f"bootstrap:{resolved.model_id}"


# ---------------------------------------------------------------------------
# Artifact fetch (read-only; mirrors eval-artifact-store.ts naming).
# ---------------------------------------------------------------------------
def _replay_bucket_param_name() -> str:
    return os.environ.get(
        "REPLAY_BUCKET_PARAM",
        f"/citadel/eval-replay-bucket-{os.environ.get('ENVIRONMENT', 'dev')}",
    )


def _fetch_artifact(artifact_ref: str | None) -> dict[str, Any]:
    """Fetch the replay-package artifact. Never raises: any failure
    (missing artifactRef, missing SSM param, missing S3 object, malformed
    JSON) degrades to an empty context so the judge can still run — the
    same graceful-degradation discipline as the TS-side readEvalArtifact."""
    if not artifact_ref:
        return {}
    try:
        ssm = _ssm_client()
        bucket_name = ssm.get_parameter(Name=_replay_bucket_param_name())["Parameter"]["Value"]
        s3 = _s3_client()
        obj = s3.get_object(Bucket=bucket_name, Key=artifact_ref)
        body = obj["Body"].read()
        return json.loads(body)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "eval_judge: artifact fetch failed (evalRunId/caseId unknown at this layer) — "
            "judging with empty context: %s",
            exc,
        )
        return {}


# ---------------------------------------------------------------------------
# Prompt construction + hashing.
# ---------------------------------------------------------------------------
def _build_prompt(dimension: str, rubric: str, artifact: dict[str, Any]) -> str:
    context_text = _extract_context_text(artifact)
    return (
        f"Rubric ({dimension}):\n{rubric}\n\n"
        f"Context:\n{context_text}\n\n"
        "Return ONLY the JSON object described in your instructions."
    )


def _extract_context_text(artifact: dict[str, Any]) -> str:
    sections = artifact.get("sections") if isinstance(artifact, dict) else None
    if not isinstance(sections, dict):
        return ""
    messages = sections.get("messages")
    if isinstance(messages, list) and messages:
        parts = []
        for m in messages:
            if isinstance(m, dict):
                parts.append(f"{m.get('role', '')}: {m.get('content', '')}")
        return "\n".join(parts)
    nodes = sections.get("nodes")
    if isinstance(nodes, list) and nodes:
        return json.dumps(
            [{"nodeId": n.get("nodeId"), "outputs": n.get("outputs")} for n in nodes if isinstance(n, dict)],
            sort_keys=True,
            default=str,
        )
    return ""


def _prompt_hash(prompt: str) -> str:
    """Deterministic hash of the exact judge prompt (system prompt +
    template version + case-specific prompt body). Same case + artifact ->
    same hash: no timestamps, no randomness, no non-deterministic ordering
    feed into this input."""
    payload = f"{_PROMPT_TEMPLATE_VERSION}\n{_JUDGE_SYSTEM_PROMPT}\n{prompt}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Structured verdict parsing — strict: never fabricate.
# ---------------------------------------------------------------------------
def _parse_verdict(raw_text: str) -> dict[str, Any] | None:
    """Parse the judge's raw text output into a verdict dict, or return
    None on ANY malformation. Never raises. A syntactically valid JSON
    object whose "score" is not a number in [0, 1] is ALSO treated as
    malformed — an out-of-range or wrong-typed score must never be
    silently clamped or coerced into a fabricated in-range value."""
    if not isinstance(raw_text, str) or not raw_text.strip():
        return None
    try:
        parsed = json.loads(raw_text)
    except (json.JSONDecodeError, ValueError, TypeError):
        return None
    if not isinstance(parsed, dict):
        return None
    score = parsed.get("score")
    if isinstance(score, bool) or not isinstance(score, (int, float)):
        return None
    if not (0.0 <= float(score) <= 1.0):
        return None
    return {"kind": "score", "score": float(score)}


# ---------------------------------------------------------------------------
# Core per-dimension judging.
# ---------------------------------------------------------------------------
def _judge_dimension(
    *,
    eval_run_id: str,
    case_id: str,
    org_id: str,
    dimension: str,
    rubric: str,
    artifact: dict[str, Any],
    resolved_model,
) -> dict[str, Any]:
    """Judge a single dimension and return the FROZEN judged payload dict
    (governance.eval.case.judged — verbatim keys, no extras)."""
    prompt = _build_prompt(dimension, rubric, artifact)
    prompt_hash = _prompt_hash(prompt)
    judge_model_version = _judge_model_version(resolved_model)

    payload: dict[str, Any] = {
        "evalRunId": eval_run_id,
        "caseId": case_id,
        "orgId": org_id,
        "dimension": dimension,
        "judgeModelId": resolved_model.model_id,
        "judgeModelVersion": judge_model_version,
        "judgePromptHash": prompt_hash,
    }

    try:
        client = _bedrock_client()
        response = client.converse(
            modelId=resolved_model.model_id,
            system=[{"text": _JUDGE_SYSTEM_PROMPT}],
            messages=[{"role": "user", "content": [{"text": prompt}]}],
            inferenceConfig={"temperature": 0, "maxTokens": 512},
        )
        raw_text = _extract_response_text(response)
    except Exception as exc:  # noqa: BLE001 — a Bedrock call failure is UNKNOWN, not a crash
        logger.warning(
            "eval_judge: bedrock invocation failed for dimension=%s caseId=%s: %s",
            dimension,
            case_id,
            exc,
        )
        raw_text = None

    verdict = _parse_verdict(raw_text) if raw_text is not None else None
    if verdict is None:
        payload["status"] = "UNKNOWN"
        logger.warning(
            "eval_judge: malformed or missing judge output for dimension=%s caseId=%s — "
            "emitting UNKNOWN, never fabricating a score",
            dimension,
            case_id,
        )
    else:
        payload["status"] = "SCORED"
        payload["verdict"] = verdict

    return payload


def _extract_response_text(response: dict[str, Any]) -> str | None:
    try:
        content = response["output"]["message"]["content"]
        for block in content:
            if isinstance(block, dict) and "text" in block:
                return block["text"]
        return None
    except (KeyError, IndexError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Public entry points.
# ---------------------------------------------------------------------------
def handle_judge_requested(detail: dict[str, Any]) -> None:
    """Handle one governance.eval.case.judge.requested event (FROZEN
    shape). Judges every requested dimension and emits one
    governance.eval.case.judged event per dimension. Never raises: any
    per-dimension failure degrades that dimension to UNKNOWN (never drops
    the event and never crashes the batch)."""
    eval_run_id = detail["evalRunId"]
    case_id = detail["caseId"]
    org_id = detail["orgId"]
    artifact_ref = detail.get("artifactRef")
    judge_dimensions = detail.get("judgeDimensions") or []

    resolved_model = _resolve_judge_model()
    artifact = _fetch_artifact(artifact_ref)
    events_client = _events_client()

    for entry in judge_dimensions:
        dimension = entry.get("dimension")
        rubric = entry.get("rubric", "")
        if dimension not in _JUDGEABLE_DIMENSIONS:
            logger.warning("eval_judge: skipping unrecognized dimension %r", dimension)
            continue
        payload = _judge_dimension(
            eval_run_id=eval_run_id,
            case_id=case_id,
            org_id=org_id,
            dimension=dimension,
            rubric=rubric,
            artifact=artifact,
            resolved_model=resolved_model,
        )
        events_client.put_events(
            Entries=[
                {
                    "Source": "citadel.governance",
                    "DetailType": "governance.eval.case.judged",
                    "Detail": json.dumps(payload, sort_keys=True),
                    "EventBusName": os.environ.get("EVENT_BUS_NAME", "default"),
                }
            ]
        )


def handler(event: dict[str, Any], _context: Any) -> None:
    """Lambda entrypoint. Unwraps the EventBridge envelope and dispatches
    only on governance.eval.case.judge.requested; no-ops (logs) on any
    other detail-type so a mis-wired rule cannot crash the function."""
    detail_type = event.get("detail-type")
    if detail_type == "governance.eval.case.judge.requested":
        handle_judge_requested(event.get("detail") or {})
        return
    logger.info("eval_judge: unrecognized detail-type=%r — no-op", detail_type)
