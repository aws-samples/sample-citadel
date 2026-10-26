"""Fabrication tools — plan, confirm, and trigger agent fabrication."""
import json
import logging
import os
import time
from datetime import datetime, timezone
import boto3
from boto3.dynamodb.conditions import Key
from strands.tools import tool
from tools.kb import s3_get, s3_put
from tools.converse_utils import extract_text, capture_converse_usage
from config import bedrock, get_agent_model_id
import request_context

logger = logging.getLogger(__name__)

SECTION_KEY = "{session_id}/design/td_2.md"
PLAN_KEY = "{session_id}/planning/fabrication_plan.md"
# Owned-section markers for the living plan document: the per-agent status
# table sits between these so tools/plan_doc.py can regenerate it from live
# state without touching any other prose. Link-reference-definition form
# (`[//]: # (...)`) — invisible in CommonMark. The UI renders these docs with
# react-markdown + remarkGfm and NO rehype-raw (raw HTML would be an XSS
# vector on LLM-authored content), which shows HTML comments as literal
# text — hence this form, not `<!-- -->`. Each marker line must be
# surrounded by blank lines or CommonMark absorbs it into the adjacent
# paragraph/list and renders it visibly. Defined here (the document's
# author) so plan_doc can import them without a circular import; plan_doc's
# read side also accepts the legacy `<!-- -->` forms below and migrates
# docs to this form on their next refresh.
PLAN_STATUS_BEGIN = "[//]: # (intake:agent-status:begin)"
PLAN_STATUS_END = "[//]: # (intake:agent-status:end)"
# Exact byte shapes docs written before the switch carry (read-side only).
PLAN_STATUS_BEGIN_LEGACY = "<!-- intake:agent-status:begin -->"
PLAN_STATUS_END_LEGACY = "<!-- intake:agent-status:end -->"
FABRICATOR_QUEUE_URL = os.getenv("FABRICATOR_QUEUE_URL", "")
# Fabricated agents are written to the AgentCore Registry (via the arbiter's
# store_agent_config_registry), NOT to a DynamoDB table — so the intake
# catalog reads the registry. REGISTRY_ID identifies the registry to list.
REGISTRY_ID = os.getenv("REGISTRY_ID", "")
# Agents cache table (citadel-agents-${env}), written by registry-sync +
# backfill. Carries orgId, citadelKind, registryStatus, name, description
# per record — used as the PRIMARY org-determination source for
# _get_existing_agents (ListRegistryRecords summaries omit descriptors so
# orgId is not derivable from summaries alone).
AGENT_CONFIG_TABLE = os.getenv("AGENT_CONFIG_TABLE", "")
# Durable per-agent fabrication status table (citadel-fabrication-jobs-${env}).
# When unset the PENDING status write is skipped so this stays backward-
# compatible in environments that haven't wired the table yet.
FABRICATION_JOBS_TABLE = os.getenv("FABRICATION_JOBS_TABLE", "")
# Projects table — used ONLY to resolve the session's organization (for the
# orgId stamped onto fabrication-jobs rows below). For intake-driven
# fabrication, orchestrationId == session_id == projectId (see
# fabricatorQueueService.ts / the CDK comment on FabricationJobsTable), so
# the session id is looked up directly as the project id.
PROJECTS_TABLE = os.getenv("PROJECTS_TABLE", "")
AWS_REGION = os.getenv("AWS_REGION", "ap-southeast-2")

# ~7 day TTL (epoch seconds) keeps the fabrication-jobs table self-pruning.
FABRICATION_JOBS_TTL_SECONDS = 7 * 24 * 60 * 60
# Cap the stored task description so rows stay small.
TASK_DESCRIPTION_MAX = 500

# Stale-active threshold for fabrication-jobs rows, shared by the status
# reader (tools/postfab.py) and the retry gate below.
#
# Derivation: the fabricator Lambda's hard timeout is 15 minutes
# (backend/lib/arbiter-stack.ts:474) and its queue's visibilityTimeout is
# 90 minutes with maxReceiveCount 3 (arbiter-stack.ts:459-464). The consumer
# re-stamps the row PROCESSING at the start of every delivery
# (arbiter/fabricator/index.py _write_fabrication_status), so the LONGEST a
# genuinely-live job can go without touching updatedAt is one visibility
# window (90 min) between deliveries plus one full run (15 min) ~= 105 min.
# After the 3rd delivery dies the message parks in the DLQ and the row can
# NEVER be re-stamped again; a timeout/OOM kill writes no terminal status
# either (the except handler is never reached). 120 minutes adds slack over
# the 105-minute bound. A non-terminal row older than this is orphaned: it
# gates like a failure and is eligible for retry, instead of deadlocking the
# flow until the 7-day TTL deletes the row.
STALE_ACTIVE_SECONDS = 2 * 60 * 60

_TERMINAL_STATUSES = ("COMPLETED", "FAILED")

sqs = boto3.client("sqs", region_name=AWS_REGION)
dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)

_registry_client = None


def _get_registry_client():
    """Lazy boto3 client for the AgentCore Registry control-plane APIs.

    Built on first use so module import stays cheap and tests can patch it.
    """
    global _registry_client
    if _registry_client is None:
        _registry_client = boto3.client("bedrock-agentcore-control", region_name=AWS_REGION)
    return _registry_client


def _reset_registry_client_for_test() -> None:
    """Test-only hook — forces the next call to rebuild the cached client."""
    global _registry_client
    _registry_client = None


def _resolve_session_organization(session_id: str) -> str | None:
    """Resolve the intake session's organization for stamping onto the
    fabrication-jobs row.

    session_id == projectId for intake-driven fabrication (see module-level
    PROJECTS_TABLE comment). Best-effort: returns None on any failure or
    when PROJECTS_TABLE is unset — callers must treat None as "omit the
    orgId attribute", never as an empty-string placeholder, so an
    unresolvable org reads as absent rather than as a false match.
    """
    if not PROJECTS_TABLE:
        return None
    try:
        item = dynamodb.Table(PROJECTS_TABLE).get_item(Key={"id": session_id}).get("Item")
        org = item.get("organization") if item else None
        return org if isinstance(org, str) and org.strip() else None
    except Exception as e:  # noqa: BLE001 — best-effort: never block enqueue
        logger.warning(
            "Failed to resolve organization for session=%s: %s", session_id, e,
        )
        return None


def _write_pending_fabrication_status(session_id: str, agent: dict) -> None:
    """Best-effort PENDING row for an intake-driven fabrication request.

    Keyed by orchestrationId (the intake session id) / agentUseId (the agent
    name), mirroring the SQS body. Skipped when FABRICATION_JOBS_TABLE is unset.
    A failure here NEVER fails the fabrication enqueue — the SQS message is
    already sent, so we log and swallow rather than re-raising. Never an empty
    except.
    """
    if not FABRICATION_JOBS_TABLE:
        logger.info(
            "FABRICATION_JOBS_TABLE unset; skipping PENDING status for %s/%s",
            session_id, agent.get("name"),
        )
        return
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    try:
        item = {
            "orchestrationId": session_id,
            "agentUseId": agent["name"],
            "status": "PENDING",
            "agentName": agent["name"],
            "taskDescription": (agent.get("spec") or "")[:TASK_DESCRIPTION_MAX],
            "requestType": "agent-creation",
            "requestedBy": "intake",
            "submittedAt": now,
            "updatedAt": now,
            "ttl": int(time.time()) + FABRICATION_JOBS_TTL_SECONDS,
        }
        org_id = _resolve_session_organization(session_id)
        if org_id:
            item["orgId"] = org_id
        dynamodb.Table(FABRICATION_JOBS_TABLE).put_item(Item=item)
    except Exception as e:  # noqa: BLE001 — best-effort: never block enqueue
        logger.warning(
            "Failed to write PENDING fabrication status for %s/%s: %s",
            session_id, agent.get("name"), e,
        )


def _parse_iso_utc(ts) -> datetime | None:
    """Parse an ISO-8601 timestamp (Z-suffixed or offset) to aware UTC.

    Returns None on anything unparseable so callers can treat unknown ages
    conservatively.
    """
    if not ts or not isinstance(ts, str):
        return None
    try:
        parsed = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _is_stale_active(item: dict, now: datetime | None = None) -> bool:
    """True when a NON-terminal jobs row can no longer be re-stamped.

    See STALE_ACTIVE_SECONDS for the derivation. Missing or unparseable
    updatedAt is treated as fresh (conservative: never misclassify a live
    job as orphaned on bad data).
    """
    if item.get("status") in _TERMINAL_STATUSES:
        return False
    updated = _parse_iso_utc(item.get("updatedAt"))
    if updated is None:
        return False
    now = now or datetime.now(timezone.utc)
    return (now - updated).total_seconds() > STALE_ACTIVE_SECONDS


def _specs_from_plan(session_id: str) -> dict[str, str]:
    """Recover per-agent build specs from the saved fabrication plan in S3.

    The jobs row stores only a truncated taskDescription, so a retry must
    re-read the full spec from the plan's '## Agents to Build' section
    ('### <name>' sub-sections, written by confirm_fabrication_plan).
    Returns {} when the plan is missing or has no build section.
    """
    plan = s3_get(PLAN_KEY.format(session_id=session_id)) or ""
    marker = "## Agents to Build"
    idx = plan.find(marker)
    if idx == -1:
        return {}
    specs: dict[str, str] = {}
    current = None
    lines: list[str] = []
    for line in plan[idx + len(marker):].split("\n"):
        if line.startswith("### "):
            if current:
                specs[current] = "\n".join(lines).strip()
            current = line[4:].strip()
            lines = []
        elif line.startswith("## "):
            break  # next top-level section ends the build block
        elif current:
            lines.append(line)
    if current:
        specs[current] = "\n".join(lines).strip()
    return {name: spec for name, spec in specs.items() if spec}


# Conversational payload helpers for retry_failed_fabrication. Mirrors the
# shape of tools/postfab.py _result/_action — duplicated here (small, stable)
# because postfab imports from this module, so importing back would be a
# circular import.

def _retry_result(ok: bool, status: str, summary: str, consent_question: str,
                  actions: list[dict], **extra) -> str:
    payload = {
        "ok": ok,
        "status": status,
        "summary": summary,
        "consent_question": consent_question,
        "actions": actions,
    }
    payload.update(extra)
    return json.dumps(payload)


def _retry_action(label: str, value: str) -> dict:
    return {"label": label, "value": value}


def _plain_join(names: list[str]) -> str:
    quoted = [f"'{n}'" for n in names]
    if len(quoted) <= 1:
        return quoted[0] if quoted else ""
    return ", ".join(quoted[:-1]) + " and " + quoted[-1]


def _llm(system: str, user: str, session_id: str = "", max_tokens: int = 8192) -> str:
    started_at = time.monotonic()
    resp = bedrock.converse(
        modelId=get_agent_model_id(),
        system=[{"text": system}],
        messages=[{"role": "user", "content": [{"text": user}]}],
        inferenceConfig={"maxTokens": max_tokens},
    )
    if session_id:
        try:
            capture_converse_usage(resp, get_agent_model_id(), session_id, started_at)
        except Exception as exc:
            logger.warning("converse_utils: usage capture failed: %s", exc)
    raw = extract_text(resp)
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return raw.strip()


def _extract_agents(td2_content: str, session_id: str = "") -> list[dict]:
    """Extract agents from td_2.md. Returns list of {name, spec, requires_external}."""
    raw = _llm(
        "You extract structured data from technical design documents. Return only valid JSON.",
        f"""From this Agent Definitions section, extract each agent as a JSON array.
Each item must have:
- "name": agent name (string)
- "spec": full agent specification including responsibility, tools, handler() signature, input/output schema
- "requires_external": true ONLY if this agent absolutely cannot function without proprietary hardware, physical devices, or vendor-locked on-premises systems that have no API. Set false for anything that can be built with AWS services, REST APIs, databases, or standard protocols. Default to false when uncertain.
- "external_reason": brief reason if requires_external is true, else null

IMPORTANT: Most agents should be "requires_external": false. An agent that calls REST APIs, reads databases, processes documents, or orchestrates other services is NOT external — it can be auto-built.

Return ONLY a JSON array, no markdown.

{td2_content}""",
        session_id,
    )
    return json.loads(raw)


def _registry_state_from_status(status: str) -> str:
    """Map an AgentCore Registry record status to a simple lifecycle state.

    Mirrors the spirit of registry-service.ts toInternalState():
    APPROVED-family -> active, DRAFT/CREATING -> draft, everything else
    (deprecated / rejected / failed / unknown) -> inactive.
    """
    s = (status or "").upper()
    if s in ("APPROVED", "UPDATING", "PENDING_APPROVAL"):
        return "active"
    if s in ("DRAFT", "CREATING"):
        return "draft"
    return "inactive"




def _extract_org_from_summary(summary: dict) -> str | None:
    """Extract orgId from a registry record summary.

    The orgId lives inside ``descriptors.custom.data`` (a JSON string) under
    the key ``orgId``.  Returns:

    - The orgId string (possibly ``""``) when descriptors are present and
      parseable.  ``""`` means system/shared — visible to every tenant.
    - ``None`` when descriptors are absent or unparseable — the caller MUST
      treat this as "org undeterminable" and EXCLUDE the record.

    Live verification (2026-10-24): ListRegistryRecords summaries do NOT
    include ``descriptors`` — only id/name/status/description/timestamps.
    Returning ``None`` (not ``""``) for absent descriptors prevents a false
    "system" classification that would let every record through the filter.
    Records whose org cannot be determined from the summary are excluded;
    a system record is identified ONLY by an explicit ``orgId == ""`` in the
    detailed record's custom descriptor data.
    """
    try:
        descriptors = summary.get("descriptors")
        if descriptors is None:
            return None
        custom = descriptors.get("custom") or {}
        data_str = custom.get("data", "")
        if not data_str or not isinstance(data_str, str):
            return None
        data = json.loads(data_str)
        return data.get("orgId", "")
    except (json.JSONDecodeError, AttributeError, TypeError):
        pass
    return None


# Maximum number of sequential GetRegistryRecord detail reads when the
# projection table is empty (fallback path C). Bounded to prevent fan-out
# against large registries.
_DETAIL_READ_CAP = 60
_DETAIL_READ_DELAY_BASE_S = 0.25


def _get_agents_from_projection(session_org: str) -> dict[str, dict] | None:
    """Read the agents cache table (AGENT_CONFIG_TABLE) for org-scoped agents.

    Returns a dict keyed by agent name (same shape as _get_existing_agents),
    or ``None`` when the projection table is unavailable/empty — signalling
    the caller to fall through to the detail-read path.

    Filters: citadelKind == "agent", orgId in {session_org, ""} (own org +
    system), registryStatus in {APPROVED, PENDING_APPROVAL} matching the
    active/draft lifecycle that plan_fabrication consumes.
    """
    if not AGENT_CONFIG_TABLE:
        return None
    try:
        table = dynamodb.Table(AGENT_CONFIG_TABLE)
        items: list[dict] = []
        scan_kwargs: dict = {}
        while True:
            resp = table.scan(**scan_kwargs)
            items.extend(resp.get("Items", []))
            if not resp.get("LastEvaluatedKey"):
                break
            scan_kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    except Exception as e:  # noqa: BLE001 — projection is optional; fall through
        logger.warning("agents projection scan failed: %s", e)
        return None

    if not items:
        return None

    agents: dict[str, dict] = {}
    for item in items:
        # Filter: agents only (exclude tool projection rows).
        if item.get("citadelKind") != "agent":
            continue
        # Org-scope: own org or system (orgId "").
        item_org = item.get("orgId")
        if item_org is None:
            continue  # undeterminable — fail closed
        if item_org != "" and item_org != session_org:
            continue
        # Status filter: only active lifecycle statuses.
        reg_status = (item.get("registryStatus") or "").upper()
        if reg_status not in ("APPROVED", "PENDING_APPROVAL"):
            continue
        name = item.get("name") or ""
        record_id = item.get("agentId") or item.get("registryRecordId") or ""
        if not name or not record_id:
            continue
        agents[name] = {
            "name": name,
            "state": _registry_state_from_status(reg_status),
            "recordId": record_id,
            "description": item.get("description") or "",
        }
    return agents


def _bounded_detail_reads(
    summaries: list[dict], session_org: str,
) -> dict[str, dict]:
    """Fallback path (C): sequential GetRegistryRecord calls to determine org.

    Capped at ``_DETAIL_READ_CAP`` records with backoff. Records whose org
    cannot be determined are excluded (fail-closed).
    """
    client = _get_registry_client()
    agents: dict[str, dict] = {}
    reads = 0
    for summary in summaries:
        if reads >= _DETAIL_READ_CAP:
            logger.warning(
                "detail-read cap (%d) reached; %d summaries unresolved",
                _DETAIL_READ_CAP, len(summaries) - reads,
            )
            break
        name = summary.get("name")
        record_id = summary.get("recordId")
        if not name or not record_id:
            continue
        try:
            detail = client.get_registry_record(
                registryId=REGISTRY_ID, recordId=record_id,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("detail read failed for %s: %s", record_id, e)
            reads += 1
            time.sleep(_DETAIL_READ_DELAY_BASE_S * (1 + reads * 0.1))
            continue
        reads += 1
        # Extract org from the detail record's descriptors.
        record_data = detail if isinstance(detail, dict) else {}
        record_org = _extract_org_from_summary(record_data)
        if record_org is None or (record_org != "" and record_org != session_org):
            continue
        agents[name] = {
            "name": name,
            "state": _registry_state_from_status(summary.get("status", "")),
            "recordId": record_id,
            "description": summary.get("description") or "",
        }
        if reads < _DETAIL_READ_CAP:
            time.sleep(_DETAIL_READ_DELAY_BASE_S)
    return agents


def _get_existing_agents() -> dict[str, dict]:
    """Return factory records from the AgentCore Registry, keyed by record name.

    Fabricated agents are persisted to the AgentCore Registry (via the arbiter's
    store_agent_config_registry), NEVER to a DynamoDB agent-config table — so
    the intake catalog must read the registry to see ap-*-agent-v1 agents.

    **Org-scoped** (C23 fix): only records belonging to the session's
    organisation (from ``request_context``) or system records (orgId ``""``)
    are returned.  This prevents one tenant's agents from leaking into
    another tenant's fabrication prompt or being bound by another tenant's
    session.  The session org_id is REQUIRED — if the session has no org,
    the function fails closed (returns ``{}``) instead of exposing the full
    unscoped registry.

    **Org-source strategy (2026-10-26):** ListRegistryRecords summaries do
    NOT include ``descriptors`` — orgId is not derivable from summaries.
    Three-tier resolution:

    (A) **Projection table** (cheapest, preferred): scan AGENT_CONFIG_TABLE
        (citadel-agents-${env}) — the agents cache written by registry-sync
        + backfill. Rows carry orgId, citadelKind, registryStatus, name,
        description. A single DynamoDB Scan with client-side filtering.
    (B) **Projection empty/unavailable**: fall through to path (C).
    (C) **Bounded detail reads**: sequential GetRegistryRecord calls (capped
        at 60, 250ms backoff) to resolve org from descriptors.custom.data.
        Never the uncapped fan-out.

    Records whose org cannot be determined after all tiers are excluded
    (fail-closed). System records (orgId ``""``) are visible to every tenant.

    Each value is::

        {
            'name': <registry record name>,
            'state': <active|draft|inactive derived from record status>,
            'recordId': <registry recordId, for disambiguation>,
            'description': <human description>,
        }

    Degrades gracefully: when REGISTRY_ID is unset or the list call fails
    this logs and returns {} — it never raises, so the intake agent stays
    usable even without registry visibility.
    """
    if not REGISTRY_ID:
        logger.info("REGISTRY_ID unset; cannot list factory agents from registry")
        return {}

    # C23 fix: resolve the session's org and fail closed when absent.
    try:
        session_org = request_context.current_session().org_id
    except RuntimeError:
        logger.warning("_get_existing_agents called outside request scope; returning empty")
        return {}
    if not session_org:
        logger.warning("session has no org_id; returning empty to avoid cross-tenant leak")
        return {}

    # --- Path (A): projection table ---
    projection = _get_agents_from_projection(session_org)
    if projection is not None:
        return projection

    # --- Paths (B)/(C): list summaries, then bounded detail reads ---
    try:
        client = _get_registry_client()
    except Exception as e:  # noqa: BLE001 — client build must not raise
        logger.warning("Failed to build registry client: %s", e)
        return {}

    all_summaries: list[dict] = []
    next_token = None
    try:
        while True:
            kwargs: dict = {"registryId": REGISTRY_ID, "descriptorType": "CUSTOM"}
            if next_token:
                kwargs["nextToken"] = next_token
            response = client.list_registry_records(**kwargs)
            if not isinstance(response, dict):
                break
            summaries = response.get("registryRecords")
            if summaries is None:
                summaries = response.get("records", [])
            for summary in summaries:
                if isinstance(summary, dict) and summary.get("name") and summary.get("recordId"):
                    all_summaries.append(summary)
            next_token = response.get("nextToken")
            if not isinstance(next_token, str) or not next_token:
                break
    except Exception as e:  # noqa: BLE001 — degrade gracefully, never raise
        logger.warning("Failed to list factory agents from registry: %s", e)
        return {}

    if not all_summaries:
        return {}

    # First pass: check if any summaries carry descriptors (future API).
    agents: dict[str, dict] = {}
    unresolved: list[dict] = []
    for summary in all_summaries:
        record_org = _extract_org_from_summary(summary)
        if record_org is None:
            unresolved.append(summary)
            continue
        if record_org != "" and record_org != session_org:
            continue
        name = summary["name"]
        agents[name] = {
            "name": name,
            "state": _registry_state_from_status(summary.get("status", "")),
            "recordId": summary["recordId"],
            "description": summary.get("description") or "",
        }

    # Path (C): bounded detail reads for unresolved summaries.
    if unresolved:
        detail_agents = _bounded_detail_reads(unresolved, session_org)
        agents.update(detail_agents)

    return agents


def _require_session_organization(session_id: str) -> str:
    """Resolve the session's organization or raise, never enqueuing a
    fabrication request without a tenant.

    Shared by every fabricator-enqueue call site (initial send and retry)
    so tenancy is enforced identically regardless of path.
    """
    org_id = _resolve_session_organization(session_id)
    if not org_id:
        logger.error(
            "cannot fabricate: no organisation resolved for session %s", session_id,
        )
        raise ValueError(
            f"cannot fabricate: no organisation resolved for session {session_id}"
        )
    return org_id


def _send_to_fabricator(session_id: str, agent: dict, agent_index: int = 0, total_agents: int = 1):
    org_id = _require_session_organization(session_id)
    sqs.send_message(
        QueueUrl=FABRICATOR_QUEUE_URL,
        MessageBody=json.dumps({
            "orchestration_id": session_id,
            "agent_use_id": agent["name"],
            "node": "fabricator",
            "agent_input": {"taskDetails": f"Create an agent with the following specification:\n\n{agent['spec']}"},
            "agent_index": agent_index,
            "total_agents": total_agents,
            "org_id": org_id,
        }),
        MessageAttributes={
            "requestType": {"DataType": "String", "StringValue": "agent-creation"},
            "requestId": {"DataType": "String", "StringValue": agent["name"]},
        },
    )
    # Durable PENDING status so the queue UI reflects this request before the
    # consumer picks it up. Best-effort — never fails the enqueue.
    _write_pending_fabrication_status(session_id, agent)


@tool
def plan_fabrication() -> str:
    """Analyse the technical design and existing factory agents to produce a fabrication plan.
    Returns a JSON plan classifying each agent as: build, reuse, or external.
    Present this to the user for confirmation before proceeding.

    Returns:
        JSON string with the fabrication plan for each agent.
    """
    session_id = request_context.current_session_id()
    td2 = s3_get(SECTION_KEY.format(session_id=session_id))
    if not td2:
        return "Error: Agent Definitions (td_2.md) not found. Generate the technical design first."

    needed = _extract_agents(td2, session_id)
    existing = _get_existing_agents()

    plan = []
    for agent in needed:
        name = agent["name"]
        if agent.get("requires_external"):
            action = "external"
            reason = agent.get("external_reason", "Requires external setup")
        elif name in existing:
            action = "reuse"
            rec = existing[name]
            reason = (
                f"Already in factory "
                f"(recordId={rec.get('recordId')}, state={rec.get('state')})"
            )
        else:
            action = "build"
            reason = "Not yet in factory — will be auto-fabricated"

        plan.append({
            "name": name,
            "action": action,
            "reason": reason,
            "spec": agent["spec"],
        })

    return json.dumps(plan, indent=2)


@tool
def confirm_fabrication_plan(plan_json: str) -> str:
    """Save the confirmed fabrication plan to S3 and queue 'build' agents for fabrication.
    Call this after the user has confirmed the plan from plan_fabrication.

    Args:
        plan_json: The confirmed plan JSON (may be modified by user confirmation)

    Returns:
        Summary of what was saved and queued.
    """
    session_id = request_context.current_session_id()
    if not FABRICATOR_QUEUE_URL:
        return "Error: FABRICATOR_QUEUE_URL not set."

    plan = json.loads(plan_json)

    # Write markdown plan to S3. The status table is wrapped in the owned-
    # section markers so the plan-document refresher (tools/plan_doc.py) can
    # regenerate it from live state as fabrication progresses. Blank lines
    # around each marker keep the link-reference-definition form invisible
    # (CommonMark absorbs it into an adjacent paragraph otherwise).
    lines = ["# Fabrication Plan\n"]
    lines.append(PLAN_STATUS_BEGIN)
    lines.append("")
    lines.append("| Agent | Action | Reason |")
    lines.append("|---|---|---|")
    for item in plan:
        emoji = {"build": "🔨", "reuse": "♻️", "external": "⚠️"}.get(item["action"], "")
        lines.append(f"| {item['name']} | {emoji} {item['action'].capitalize()} | {item['reason']} |")
    lines.append("")
    lines.append(PLAN_STATUS_END)

    lines.append("\n## Agents to Build\n")
    build_agents = [a for a in plan if a["action"] == "build"]
    for a in build_agents:
        lines.append(f"### {a['name']}\n{a['spec']}\n")

    s3_put(PLAN_KEY.format(session_id=session_id), "\n".join(lines))

    # Queue build agents
    queued = []
    for i, agent in enumerate(build_agents):
        _send_to_fabricator(session_id, agent, agent_index=i, total_agents=len(build_agents))
        queued.append(agent["name"])

    reuse = [a["name"] for a in plan if a["action"] == "reuse"]
    external = [a["name"] for a in plan if a["action"] == "external"]

    summary = f"Fabrication plan saved.\n"
    if queued:   summary += f"🔨 Queued for build: {', '.join(queued)}\n"
    if reuse:    summary += f"♻️  Reusing existing: {', '.join(reuse)}\n"
    if external: summary += f"⚠️  External (manual): {', '.join(external)}\n"

    from tools.state import _internal_update_progress as update_intake_progress
    # Build-segment window: confirm = 10, fabrication events scale 10-60,
    # post-fabrication milestones land 70-90, app publish finishes at 100.
    # (This previously wrote 100 at queue time, completing the header's Build
    # segment before a single agent had been built.)
    update_intake_progress(session_id=session_id, phase='implementation', progress=10, change_summary=f'Fabrication confirmed: {len(queued)} build, {len(reuse)} reuse, {len(external)} external')

    return summary.strip()


@tool
def retry_failed_fabrication(agent_names: str = "") -> str:
    """Re-queue fabrication for agents whose build failed or stalled.

    Each agent builds independently: this retries ONLY the requested (or all
    eligible) agents whose OWN job has failed or stalled (no progress for
    over two hours). Agents that are already built are never rebuilt, and
    agents actively being built are never interrupted — other agents' builds
    never block a retry. Safe to repeat: a just-retried agent is back in a
    fresh waiting state, so an immediate second call skips it.

    Args:
        agent_names: Optional comma-separated agent names to retry. Leave
            empty to retry every agent that failed or stalled.

    Returns:
        JSON with what was re-queued and what was skipped (with plain
        reasons), a conversational summary, and the consent question for
        the next step.
    """
    session_id = request_context.current_session_id()
    if not FABRICATOR_QUEUE_URL or not FABRICATION_JOBS_TABLE:
        return _retry_result(
            False, "unavailable",
            "I can't re-queue builds automatically right now.",
            "Want me to try again in a moment?",
            [_retry_action("Try again", "Retry the agents that didn't finish"),
             _retry_action("Stop here", "Stop here")],
        )

    items: list[dict] = []
    try:
        kwargs = {"KeyConditionExpression": Key("orchestrationId").eq(session_id)}
        while True:
            resp = dynamodb.Table(FABRICATION_JOBS_TABLE).query(**kwargs)
            items.extend(resp.get("Items", []))
            if not resp.get("LastEvaluatedKey"):
                break
            kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    except Exception as e:  # noqa: BLE001 — degrade to a conversational error
        logger.warning("fabrication-jobs query failed session=%s: %s", session_id, e)
        return _retry_result(
            False, "unavailable",
            "I can't re-queue builds automatically right now.",
            "Want me to try again in a moment?",
            [_retry_action("Try again", "Retry the agents that didn't finish"),
             _retry_action("Stop here", "Stop here")],
        )

    if not items:
        return _retry_result(
            True, "none",
            "I don't see anything queued to build for this session yet.",
            "Want me to check the build status, or shall we review the "
            "fabrication plan together?",
            [_retry_action("Check build status", "Check the build status"),
             _retry_action("Stop here", "Stop here")],
        )

    now = datetime.now(timezone.utc)
    by_name: dict[str, dict] = {}
    for item in items:
        name = item.get("agentName") or item.get("agentUseId")
        if name:
            by_name[name] = item

    requested = [n.strip() for n in agent_names.split(",") if n.strip()]
    eligible: list[str] = []
    stalled: list[str] = []
    skipped: list[tuple[str, str]] = []

    def _classify(name: str, item: dict) -> None:
        # Gate on the TARGET job's own state only — siblings never block.
        if item.get("status") == "FAILED":
            eligible.append(name)
        elif _is_stale_active(item, now):
            eligible.append(name)
            stalled.append(name)
        elif requested:
            # Per-job refusal copy only for explicitly requested targets;
            # an implicit "retry everything" simply doesn't select them.
            if item.get("status") == "COMPLETED":
                skipped.append((name, f"'{name}' is already built"))
            else:
                skipped.append((name, f"'{name}' is still being built"))

    if requested:
        for name in requested:
            item = by_name.get(name)
            if item is None:
                skipped.append((name, f"'{name}' isn't part of this build"))
            else:
                _classify(name, item)
    else:
        for name, item in by_name.items():
            _classify(name, item)

    check_actions = [
        _retry_action("Check build status", "Check the build status"),
        _retry_action("Not now", "Not now"),
    ]

    if not eligible:
        if skipped:
            summary = "Nothing was re-queued — " + "; ".join(r for _, r in skipped) + "."
        else:
            summary = "Nothing needs a rebuild right now — no agents have failed or stalled."
        return _retry_result(
            True, "nothing_to_retry", summary,
            "Want me to check the build status?",
            check_actions,
            retried=[], stalled=[],
            skipped=[{"name": n, "reason": r} for n, r in skipped],
        )

    # The jobs row stores only a truncated taskDescription — recover the full
    # spec from the saved plan so a retry message is shape-identical to the
    # original enqueue.
    specs = _specs_from_plan(session_id)
    targets = [n for n in eligible if specs.get(n)]
    missing = [n for n in eligible if not specs.get(n)]

    if not targets:
        return _retry_result(
            False, "plan_missing",
            f"I couldn't recover the build details for {_plain_join(missing)} "
            "from the fabrication plan, so nothing was re-queued.",
            "Want me to check the build status instead?",
            [_retry_action("Check build status", "Check the build status"),
             _retry_action("Stop here", "Stop here")],
            retried=[], stalled=[], missing=missing,
        )

    # _send_to_fabricator also resets the row to a fresh waiting state, so a
    # repeat call sees the target as in-flight and skips it (idempotent per
    # agentUseId). Coarse per-retry indices (0..n-1 of n) are deliberate —
    # never reuse the original batch's indices.
    for i, name in enumerate(targets):
        _send_to_fabricator(session_id, {"name": name, "spec": specs[name]},
                            agent_index=i, total_agents=len(targets))

    stale_targets = [n for n in stalled if n in targets]
    parts = [f"Re-queued {_plain_join(targets)} to be rebuilt — check back "
             "with me any time for progress."]
    if stale_targets:
        pronoun = "it" if len(stale_targets) == 1 else "them"
        parts.append(
            f"{_plain_join(stale_targets)} had stalled — no progress for over "
            f"two hours — so I've restarted {pronoun}."
        )
    for _, reason in skipped:
        parts.append(f"{reason}, so I left it as is.")
    if missing:
        tail = "it wasn't" if len(missing) == 1 else "they weren't"
        parts.append(
            f"I couldn't recover the build details for {_plain_join(missing)}, "
            f"so {tail} re-queued."
        )

    return _retry_result(
        True, "retried", " ".join(parts),
        "Want me to check the build status now?",
        check_actions,
        retried=targets, stalled=stale_targets,
        skipped=[{"name": n, "reason": r} for n, r in skipped],
        missing=missing,
    )


@tool
def list_factory_agents() -> str:
    """List all agents that have been built and registered in the factory.

    Reads the AgentCore Registry (the source of truth for fabricated agents).

    Returns:
        Summary of registered agents with their name, state, and description.
    """
    existing = _get_existing_agents()
    if not existing:
        return "No agents have been built yet."

    lines = [f"{'Agent':<40} {'State':<10} Description"]
    lines.append("-" * 90)
    for name, item in sorted(existing.items()):
        lines.append(
            f"{name:<40} "
            f"{item.get('state', ''):<10} "
            f"{(item.get('description') or '')[:50]}"
        )
    return "\n".join(lines)
