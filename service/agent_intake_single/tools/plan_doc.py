"""Living fabrication-plan document refresher.

The fabrication plan at ``{session_id}/planning/fabrication_plan.md`` is
written once by ``confirm_fabrication_plan`` and then goes stale: build
agents keep the 'Not yet in factory — will be auto-fabricated' reason
forever, and the delivered artifacts (activated agents, app, blueprint,
workflow) never appear. ``refresh_plan_document`` turns it into a living
document by idempotently regenerating ONLY the sections this module owns:

- the per-agent status table (between the agent-status markers written by
  ``confirm_fabrication_plan``, with a structural fallback for docs written
  before markers existed), recomputed from live state: fabrication-jobs
  terminal statuses + the AgentCore Registry via ``_get_existing_agents``;
- a ``## Delivered Artifacts`` section (between artifact markers, appended
  at the end of the document) built from the ``intake:postfab`` marker.

Regeneration strategy: owned sections between markers — NOT a full rebuild —
because the document embeds LLM-authored agent specs (``## Agents to
Build``) whose template inputs are not persisted; rebuilding would require
re-running the LLM (non-deterministic, costly) and could clobber prose. All
content outside the owned sections is preserved byte-for-byte.

Copy rules: status wording uses human phrases ('Built', 'Active — ready to
use'), never raw job/registry enums.

Idempotency: artifact lines keep their first-written timestamp (the postfab
marker only carries a single updatedAt, so timestamps are stamped at write
time and preserved verbatim on later runs); an unchanged document is not
rewritten, so a double run is byte-identical and adds no S3 version.
Last-writer-wins is acceptable: a single sequential conversation writes it,
and the bucket is versioned.

Best-effort by contract: ``refresh_plan_document`` NEVER raises — a failed
refresh must never fail the primary tool that triggered it.
"""
import logging
import os
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key

from tools.fabricate import (
    PLAN_KEY,
    PLAN_STATUS_BEGIN,
    PLAN_STATUS_END,
    _get_existing_agents,
)
from tools.kb import s3_get, s3_put
from tools.state import get_postfab_marker
from config import SESSION_BUCKET

logger = logging.getLogger(__name__)

AWS_REGION = os.environ.get("AWS_REGION", "ap-southeast-2")
FABRICATION_JOBS_TABLE = os.environ.get("FABRICATION_JOBS_TABLE", "")

dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)

ARTIFACTS_BEGIN = "<!-- intake:delivered-artifacts:begin -->"
ARTIFACTS_END = "<!-- intake:delivered-artifacts:end -->"

# Human status phrases (copy rules: no raw enums in the document).
_PHRASE_ACTIVE = "Active — ready to use"
_PHRASE_BUILT = "Built"
_PHRASE_FAILED = "Didn't finish building"
_PHRASE_BUILDING = "Being built"
_PHRASE_WAITING = "Waiting to start"

_TIMESTAMP_SEP = " — recorded "


def _job_statuses(session_id: str) -> dict[str, str]:
    """Per-agent fabrication job status keyed by agent name. {} on any failure."""
    if not FABRICATION_JOBS_TABLE:
        return {}
    statuses: dict[str, str] = {}
    try:
        kwargs = {"KeyConditionExpression": Key("orchestrationId").eq(session_id)}
        while True:
            resp = dynamodb.Table(FABRICATION_JOBS_TABLE).query(**kwargs)
            for item in resp.get("Items", []):
                name = item.get("agentName") or item.get("agentUseId")
                if name:
                    statuses[name] = item.get("status") or ""
            if not resp.get("LastEvaluatedKey"):
                break
            kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    except Exception as e:  # noqa: BLE001 — degrade to no status flips
        logger.warning("plan refresh: jobs query failed session=%s: %s", session_id, e)
        return {}
    return statuses


def _safe_registry() -> dict[str, dict]:
    try:
        registry = _get_existing_agents()
        return registry if isinstance(registry, dict) else {}
    except Exception as e:  # noqa: BLE001 — degrade to no registry signal
        logger.warning("plan refresh: registry listing failed: %s", e)
        return {}


def _safe_marker(session_id: str) -> dict:
    try:
        marker = get_postfab_marker(session_id)
        return marker if isinstance(marker, dict) else {}
    except Exception as e:  # noqa: BLE001 — degrade to no artifacts
        logger.warning("plan refresh: marker read failed session=%s: %s", session_id, e)
        return {}


def _status_phrase(agent_name: str, jobs: dict[str, str], registry: dict[str, dict]) -> str | None:
    """Human status for one agent, or None when live state has no signal
    (the existing cell is preserved in that case)."""
    record = registry.get(agent_name)
    if record and record.get("state") == "active":
        return _PHRASE_ACTIVE
    job = jobs.get(agent_name)
    if job == "COMPLETED" or record:
        return _PHRASE_BUILT
    if job == "FAILED":
        return _PHRASE_FAILED
    if job == "PROCESSING":
        return _PHRASE_BUILDING
    if job == "PENDING":
        return _PHRASE_WAITING
    return None


def _locate_table_region(lines: list[str]) -> tuple[int, int, bool] | None:
    """(start, end, had_markers) for the owned status-table region.

    With markers: the exclusive slice between them. Without (legacy docs
    written before markers existed): the first markdown table whose header
    carries Agent + Action, through its last consecutive ``|`` row.
    """
    if PLAN_STATUS_BEGIN in lines and PLAN_STATUS_END in lines:
        begin = lines.index(PLAN_STATUS_BEGIN)
        end = lines.index(PLAN_STATUS_END)
        if end > begin:
            return begin + 1, end, True
    start = None
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("|") and "Agent" in stripped and "Action" in stripped:
            start = index
            break
    if start is None:
        return None
    end = start
    while end < len(lines) and lines[end].strip().startswith("|"):
        end += 1
    return start, end, False


def _rebuild_status_table(table_lines: list[str], jobs: dict[str, str],
                          registry: dict[str, dict]) -> tuple[list[str], bool]:
    """Regenerate the status table: Agent/Action cells preserved verbatim,
    the third cell recomputed from live state (or preserved when live state
    has no signal for that agent).

    Returns (lines, changed). ``changed`` is False when no cell differs, so
    the caller can leave the document untouched — a refresh with nothing to
    say must not add an S3 version (or restructure a legacy table)."""
    rows: list[list[str]] = []
    for line in table_lines:
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        cells = [c.strip() for c in stripped.strip("|").split("|")]
        if len(cells) < 3:
            continue
        if cells[0] == "Agent" or set(cells[0]) <= {"-", ":", " "}:
            continue  # header / separator rows
        rows.append(cells[:3])
    if not rows:
        return list(table_lines), False
    changed = False
    rebuilt = ["| Agent | Action | Status |", "|---|---|---|"]
    for agent, action, existing in rows:
        phrase = _status_phrase(agent, jobs, registry)
        if phrase is not None and phrase != existing:
            changed = True
        rebuilt.append(f"| {agent} | {action} | {phrase or existing} |")
    return rebuilt, changed


def _artifact_entries(marker: dict) -> list[str]:
    """Ordered artifact line prefixes (without timestamps) from the marker."""
    entries: list[str] = []
    activation = marker.get("activation") or {}
    names = list(activation.get("activated") or []) + list(activation.get("alreadyActive") or [])
    if names:
        quoted = ", ".join(f"'{n}'" for n in names)
        entries.append(f"- Agents activated: {len(names)} ({quoted})")
    app_name = marker.get("appName")
    if marker.get("appId") and app_name:
        entries.append(f"- App created: '{app_name}' (id: {marker['appId']})")
    if marker.get("blueprintId") and app_name:
        node_count = marker.get("nodeCount")
        if isinstance(node_count, int) and node_count > 0:
            noun = "step" if node_count == 1 else "steps"
            entries.append(f"- Blueprint published: '{app_name} Process' ({node_count} {noun})")
        else:
            entries.append(f"- Blueprint published: '{app_name} Process'")
    if marker.get("workflowId") and app_name:
        entries.append(f"- Workflow imported: '{app_name} Process' (id: {marker['workflowId']})")
    return entries


def _upsert_artifacts_section(lines: list[str], marker: dict) -> list[str]:
    """Replace or append the Delivered Artifacts section.

    Lines whose content (everything before the timestamp separator) is
    unchanged are reused verbatim so their first-written timestamp survives —
    that is what makes a double run byte-identical.
    """
    entries = _artifact_entries(marker)
    begin = lines.index(ARTIFACTS_BEGIN) if ARTIFACTS_BEGIN in lines else None
    end = lines.index(ARTIFACTS_END) if ARTIFACTS_END in lines else None
    existing_by_prefix: dict[str, str] = {}
    if begin is not None and end is not None and end > begin:
        for line in lines[begin + 1:end]:
            if _TIMESTAMP_SEP in line:
                existing_by_prefix[line.split(_TIMESTAMP_SEP)[0]] = line
    if not entries:
        return lines  # nothing delivered yet — leave the document alone

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    section = [ARTIFACTS_BEGIN, "## Delivered Artifacts", ""]
    for prefix in entries:
        section.append(existing_by_prefix.get(prefix) or f"{prefix}{_TIMESTAMP_SEP}{stamp}")
    section.append(ARTIFACTS_END)

    if begin is not None and end is not None and end > begin:
        return lines[:begin] + section + lines[end + 1:]
    appended = list(lines)
    if appended and appended[-1].strip():
        appended.append("")
    return appended + section


def refresh_plan_document(session_id: str) -> None:
    """Best-effort regeneration of the plan document's owned sections.

    NEVER raises: a failed refresh must never fail the tool that triggered
    it (the plan document is a projection, not the unit of work).
    """
    try:
        if not SESSION_BUCKET:
            # Bucket not wired (e.g. unit-test env): skip outright rather
            # than paying a doomed S3 round trip on every triggering tool.
            return
        key = PLAN_KEY.format(session_id=session_id)
        doc = s3_get(key)
        if not doc:
            return
        jobs = _job_statuses(session_id)
        registry = _safe_registry()
        marker = _safe_marker(session_id)

        lines = doc.split("\n")
        region = _locate_table_region(lines)
        if region is not None:
            start, end, had_markers = region
            table, changed = _rebuild_status_table(lines[start:end], jobs, registry)
            if changed:
                if had_markers:
                    lines = lines[:start] + table + lines[end:]
                else:
                    lines = (lines[:start] + [PLAN_STATUS_BEGIN] + table
                             + [PLAN_STATUS_END] + lines[end:])
        lines = _upsert_artifacts_section(lines, marker)

        refreshed = "\n".join(lines)
        if refreshed != doc:
            s3_put(key, refreshed)
    except Exception as e:  # noqa: BLE001 — best-effort by contract
        logger.warning("fabrication plan refresh failed session=%s: %s", session_id, e)
