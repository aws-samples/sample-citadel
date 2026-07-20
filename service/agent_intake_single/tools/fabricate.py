"""Fabrication tools — plan, confirm, and trigger agent fabrication."""
import json
import logging
import os
import time
from datetime import datetime, timezone
import boto3
from strands.tools import tool
from tools.kb import s3_get, s3_put
from tools.converse_utils import extract_text
from config import bedrock, AGENT_MODEL_ID

logger = logging.getLogger(__name__)

SECTION_KEY = "{session_id}/design/td_2.md"
PLAN_KEY = "{session_id}/planning/fabrication_plan.md"
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


def _llm(system: str, user: str, max_tokens: int = 8192) -> str:
    resp = bedrock.converse(
        modelId=AGENT_MODEL_ID,
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


def _get_registry_record_safe(client, record_id: str) -> dict | None:
    """GetRegistryRecord for one record, returning None on any failure (logged).

    Never raises — a single record's detail being unavailable must not abort
    the whole catalog listing.
    """
    try:
        resp = client.get_registry_record(registryId=REGISTRY_ID, recordId=record_id)
        return resp if isinstance(resp, dict) else None
    except Exception as e:  # noqa: BLE001 — per-record best effort, never raise
        logger.warning("get_registry_record failed for %s: %s", record_id, e)
        return None


def _parse_inline_metadata(detail: dict) -> dict:
    """Parse the CUSTOM descriptor inlineContent JSON from a registry record.

    Returns {} when the content is missing or malformed (logged) — never raises.
    """
    try:
        content = (
            (detail.get("descriptors") or {})
            .get("custom", {})
            .get("inlineContent")
        )
        if not content:
            return {}
        parsed = json.loads(content)
        return parsed if isinstance(parsed, dict) else {}
    except Exception as e:  # noqa: BLE001 — malformed metadata must not raise
        logger.warning("Failed to parse registry inlineContent: %s", e)
        return {}


def _get_existing_agents() -> dict[str, dict]:
    """Return factory agents from the AgentCore Registry, keyed by record name.

    Fabricated agents are persisted to the AgentCore Registry (via the arbiter's
    store_agent_config_registry), NEVER to a DynamoDB agent-config table — so
    the intake catalog must read the registry to see ap-*-agent-v1 agents.

    Each value is::

        {
            'name': <registry record name>,
            'state': <active|draft|inactive derived from record status>,
            'recordId': <registry recordId, for disambiguation>,
            'description': <human description>,
            'sourceProjectId': <intake project id from custom metadata, or None>,
        }

    Tool records (custom metadata without a ``manifest`` discriminator) are
    excluded so only agents surface. Degrades gracefully: when REGISTRY_ID is
    unset or the list call fails this logs and returns {} — it never raises, so
    the intake agent stays usable even without registry visibility.
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
                detail = _get_registry_record_safe(client, record_id)
                meta = _parse_inline_metadata(detail) if detail else {}
                # Agents always carry a `manifest` in custom metadata; tools do
                # not (the manifest is the agent/tool discriminator). When we
                # have detail and it is clearly a tool record, skip it so the
                # factory catalog lists agents only. When detail is unavailable
                # we include the record rather than guess.
                if detail is not None and meta and "manifest" not in meta:
                    continue
                status = (detail.get("status") if detail else None) or summary.get("status", "")
                description = (detail.get("description") if detail else None) or summary.get("description", "")
                agents[name] = {
                    "name": name,
                    "state": _registry_state_from_status(status),
                    "recordId": record_id,
                    "description": description or "",
                    "sourceProjectId": meta.get("sourceProjectId"),
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

    # Write markdown plan to S3
    lines = ["# Fabrication Plan\n"]
    lines.append("| Agent | Action | Reason |")
    lines.append("|---|---|---|")
    for item in plan:
        emoji = {"build": "🔨", "reuse": "♻️", "external": "⚠️"}.get(item["action"], "")
        lines.append(f"| {item['name']} | {emoji} {item['action'].capitalize()} | {item['reason']} |")

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
