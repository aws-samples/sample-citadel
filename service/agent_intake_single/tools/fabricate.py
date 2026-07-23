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
from tools.converse_utils import extract_text
from config import bedrock, get_agent_model_id

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
# Durable per-agent fabrication status table (citadel-fabrication-jobs-${env}).
# When unset the PENDING status write is skipped so this stays backward-
# compatible in environments that haven't wired the table yet.
FABRICATION_JOBS_TABLE = os.getenv("FABRICATION_JOBS_TABLE", "")
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
        dynamodb.Table(FABRICATION_JOBS_TABLE).put_item(Item={
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
        })
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


def _llm(system: str, user: str, max_tokens: int = 8192) -> str:
    resp = bedrock.converse(
        modelId=get_agent_model_id(),
        system=[{"text": system}],
        messages=[{"role": "user", "content": [{"text": user}]}],
        inferenceConfig={"maxTokens": max_tokens},
    )
    raw = extract_text(resp)
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
    return raw.strip()


def _extract_agents(td2_content: str) -> list[dict]:
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

{td2_content}"""
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




def _get_existing_agents() -> dict[str, dict]:
    """Return factory records from the AgentCore Registry, keyed by record name.

    Fabricated agents are persisted to the AgentCore Registry (via the arbiter's
    store_agent_config_registry), NEVER to a DynamoDB agent-config table — so
    the intake catalog must read the registry to see ap-*-agent-v1 agents.

    Built from LIST-PAGE SUMMARIES ONLY — no per-record GetRegistryRecord
    calls. The previous implementation issued one GET per record to read the
    CUSTOM descriptor inlineContent (the agent/tool ``manifest`` discriminator
    plus ``sourceProjectId``); at 340 live records that sequential N+1 (each
    GET carrying SDK retries) blew the 30s tool budget. Every consumer
    (plan_fabrication reuse-matching, list_factory_agents, postfab
    _compose_steps, plan_doc) reads only name/state/recordId/description —
    all present on summaries — and nothing consumed sourceProjectId, so the
    GETs bought nothing the common path needs.

    Documented tradeoff: without inlineContent the agent/tool discriminator
    is invisible, so tool records sharing the registry are no longer filtered
    out. Consumers match exact designed-agent names, so this surfaces only as
    extra rows in the human-facing catalog — accepted in exchange for
    removing the live timeout.

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

    try:
        client = _get_registry_client()
    except Exception as e:  # noqa: BLE001 — client build must not raise
        logger.warning("Failed to build registry client: %s", e)
        return {}

    agents: dict[str, dict] = {}
    next_token = None
    try:
        while True:
            kwargs = {"registryId": REGISTRY_ID, "descriptorType": "CUSTOM"}
            if next_token:
                kwargs["nextToken"] = next_token
            response = client.list_registry_records(**kwargs)
            if not isinstance(response, dict):
                break
            # Real API shape: summaries under "registryRecords" (matches the
            # backend's registry-service.ts). Tolerate the legacy "records"
            # key as a fallback for older/local stubs.
            summaries = response.get("registryRecords")
            if summaries is None:
                summaries = response.get("records", [])
            for summary in summaries:
                if not isinstance(summary, dict):
                    continue
                name = summary.get("name")
                record_id = summary.get("recordId")
                if not name or not record_id:
                    continue
                agents[name] = {
                    "name": name,
                    "state": _registry_state_from_status(summary.get("status", "")),
                    "recordId": record_id,
                    "description": summary.get("description") or "",
                }
            next_token = response.get("nextToken")
            if not isinstance(next_token, str) or not next_token:
                break
    except Exception as e:  # noqa: BLE001 — degrade gracefully, never raise
        logger.warning("Failed to list factory agents from registry: %s", e)
        return {}

    return agents


def _send_to_fabricator(session_id: str, agent: dict, agent_index: int = 0, total_agents: int = 1):
    sqs.send_message(
        QueueUrl=FABRICATOR_QUEUE_URL,
        MessageBody=json.dumps({
            "orchestration_id": session_id,
            "agent_use_id": agent["name"],
            "node": "fabricator",
            "agent_input": {"taskDetails": f"Create an agent with the following specification:\n\n{agent['spec']}"},
            "agent_index": agent_index,
            "total_agents": total_agents,
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
def plan_fabrication(session_id: str) -> str:
    """Analyse the technical design and existing factory agents to produce a fabrication plan.
    Returns a JSON plan classifying each agent as: build, reuse, or external.
    Present this to the user for confirmation before proceeding.

    Args:
        session_id: The current session ID

    Returns:
        JSON string with the fabrication plan for each agent.
    """
    td2 = s3_get(SECTION_KEY.format(session_id=session_id))
    if not td2:
        return "Error: Agent Definitions (td_2.md) not found. Generate the technical design first."

    needed = _extract_agents(td2)
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
def confirm_fabrication_plan(session_id: str, plan_json: str) -> str:
    """Save the confirmed fabrication plan to S3 and queue 'build' agents for fabrication.
    Call this after the user has confirmed the plan from plan_fabrication.

    Args:
        session_id: The current session ID
        plan_json: The confirmed plan JSON (may be modified by user confirmation)

    Returns:
        Summary of what was saved and queued.
    """
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
def retry_failed_fabrication(session_id: str, agent_names: str = "") -> str:
    """Re-queue fabrication for agents whose build failed or stalled.

    Each agent builds independently: this retries ONLY the requested (or all
    eligible) agents whose OWN job has failed or stalled (no progress for
    over two hours). Agents that are already built are never rebuilt, and
    agents actively being built are never interrupted — other agents' builds
    never block a retry. Safe to repeat: a just-retried agent is back in a
    fresh waiting state, so an immediate second call skips it.

    Args:
        session_id: The current session ID
        agent_names: Optional comma-separated agent names to retry. Leave
            empty to retry every agent that failed or stalled.

    Returns:
        JSON with what was re-queued and what was skipped (with plain
        reasons), a conversational summary, and the consent question for
        the next step.
    """
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
