"""Post-fabrication tools — status polling, activation, app, blueprint, import.

Implements the consent-gated, resumable 4-step flow that follows fabrication:
activate agents -> create app -> generate blueprint -> import workflow. Each
tool maps to exactly one governed intake* AppSync mutation (server-side org
derivation), is idempotent via the ``intake:postfab`` marker in
SESSION_MEMORY_TABLE, and NEVER auto-advances: every return carries the
consent question for the next gate, verbatim from the approved copy.

Copy rules baked in (UX review, task 11e23706):
- pull-only framing — never promise unprompted follow-up;
- no raw enums, error text, or record ids in user-facing strings;
- every completion says where to see it; every failure says what changed
  (nothing), one plain reason, one recommended next action;
- action labels are verb-first and emoji-free; "Not now" defers, "Stop here"
  ends.
"""
import json
import logging
import os
import uuid
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key
from strands.tools import tool

from tools import appsync_client
from tools.appsync_client import AppSyncError
from tools.fabricate import PLAN_KEY, SECTION_KEY, _get_existing_agents, _llm
from tools.kb import s3_get
from tools.state import get_postfab_marker, set_postfab_marker, _internal_update_progress
from tools.registry_name import sanitize_registry_name

logger = logging.getLogger(__name__)

AWS_REGION = os.environ.get("AWS_REGION", "ap-southeast-2")
FABRICATION_JOBS_TABLE = os.environ.get("FABRICATION_JOBS_TABLE", "")
PROJECTS_TABLE = os.environ.get("PROJECTS_TABLE", "")
CONVERSATIONS_TABLE = os.environ.get("CONVERSATIONS_TABLE", "")

dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)

# Plain-language translations for fabrication job statuses — raw enums must
# never reach the conversation.
_STATUS_PLAIN = {
    "PENDING": "waiting to start",
    "PROCESSING": "being built",
    "COMPLETED": "built",
    "FAILED": "didn't finish",
}
_TERMINAL = ("COMPLETED", "FAILED")

_STAGE_ORDER = [
    "fabrication_pending", "built", "activated", "app_created",
    "blueprint_created", "workflow_imported", "done",
]

# Build-segment milestone map (project header progress.implementation):
# fabrication confirm = 10, fabrication in-flight scales 10-60 (fabricator
# events), then each post-fabrication stage lands a fixed value; the backend
# publish handler finishes the segment at 100 when the app is published.
_STAGE_PROGRESS = {
    "activated": 70,
    "app_created": 80,
    "blueprint_created": 85,
    "workflow_imported": 90,
}


def _record_stage_progress(session_id: str, stage: str, summary: str) -> None:
    """Best-effort Build-segment milestone — never fails the calling tool.

    Routes through ``_internal_update_progress`` so all three sinks stay
    consistent: session intake state (baked into the agent prompt), the UI
    progress event, and the project record (whose write is monotonic, so an
    idempotent re-run or out-of-order call can never regress the segment).
    """
    pct = _STAGE_PROGRESS.get(stage)
    if pct is None:
        return
    try:
        _internal_update_progress(session_id, "implementation", pct, summary)
    except Exception as e:  # noqa: BLE001 — milestone telemetry must never break the flow
        logger.warning(
            "stage progress update failed session=%s stage=%s: %s",
            session_id, stage, e,
        )

# --- GraphQL documents (selection sets per the phase-1 schema) ---------------

_ACTIVATE_MUTATION = """mutation IntakeActivate($sessionId: ID!) {
  intakeActivateProjectAgents(sessionId: $sessionId) {
    activated failed alreadyActive matchedBy
  }
}"""

_CREATE_APP_MUTATION = """mutation IntakeCreateApp($sessionId: ID!, $name: String!, $description: String) {
  intakeCreateApp(sessionId: $sessionId, name: $name, description: $description) {
    appId name status agentBindings { agentId }
  }
}"""

_CREATE_BLUEPRINT_MUTATION = """mutation IntakeCreateBlueprint($sessionId: ID!, $name: String!, $definition: AWSJSON!) {
  intakeCreateBlueprint(sessionId: $sessionId, name: $name, definition: $definition) {
    ok blueprintId status nodeCount missing errors
  }
}"""

_IMPORT_MUTATION = """mutation IntakeImport($sessionId: ID!, $blueprintId: ID!, $appId: ID!, $name: String) {
  intakeImportBlueprintToApp(sessionId: $sessionId, blueprintId: $blueprintId, appId: $appId, name: $name) {
    workflowId name status
  }
}"""

# --- shared helpers -----------------------------------------------------------


def _stage_rank(stage) -> int:
    return _STAGE_ORDER.index(stage) if stage in _STAGE_ORDER else -1


def _result(ok: bool, status: str, summary: str, consent_question: str,
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


def _action(label: str, value: str) -> dict:
    return {"label": label, "value": value}


def _join_names(names: list[str]) -> str:
    quoted = [f"'{n}'" for n in names]
    if len(quoted) <= 1:
        return quoted[0] if quoted else ""
    return ", ".join(quoted[:-1]) + " and " + quoted[-1]


def _error_return(session_id: str, err: AppSyncError, step: str) -> str:
    """Approved any-error copy: plain reason, nothing-changed reassurance,
    Try again / Stop here (no misleading Skip on a strictly sequential flow)."""
    logger.warning(
        "postfab step failed step=%s session=%s type=%s retryable=%s",
        step, session_id, err.error_type, err.retryable,
    )
    summary = (
        f"That didn't go through — I hit a problem while {step}. "
        "Nothing has been changed."
    )
    return _result(
        False, "error", summary,
        "Want to try again?",
        [_action("Try again", "Yes, try again"), _action("Stop here", "Stop here")],
        retryable=bool(err.retryable),
    )


def _find_linked_project_id(session_id: str) -> str | None:
    """Paginated conversations lookup: the table is keyed PK=projectId/
    SK=timestamp with no GSI on ``id``, so a filtered Scan is the only
    correct read — and Scan's ``Limit`` caps items EVALUATED (pre-filter),
    so a single page routinely misses the row once the table grows. Follow
    LastEvaluatedKey until the linked row is found."""
    table = dynamodb.Table(CONVERSATIONS_TABLE)
    scan_kwargs = dict(
        FilterExpression="#cid = :cid",
        ExpressionAttributeNames={"#cid": "id"},
        ExpressionAttributeValues={":cid": session_id},
        ProjectionExpression="projectId",
    )
    while True:
        resp = table.scan(**scan_kwargs)
        for item in resp.get("Items", []):
            if item.get("projectId"):
                return item["projectId"]
        last_key = resp.get("LastEvaluatedKey")
        if not last_key:
            return None
        scan_kwargs["ExclusiveStartKey"] = last_key


def _derive_project_context(session_id: str) -> tuple[str, str | None]:
    """session -> conversations.projectId (fallback session_id) -> projects.name."""
    project_id = session_id
    project_name = None
    try:
        if CONVERSATIONS_TABLE:
            linked = _find_linked_project_id(session_id)
            if linked:
                project_id = linked
    except Exception as e:
        logger.warning("conversation lookup failed session=%s: %s", session_id, e)
    try:
        if PROJECTS_TABLE:
            item = dynamodb.Table(PROJECTS_TABLE).get_item(Key={"id": project_id}).get("Item")
            if item and isinstance(item.get("name"), str) and item["name"].strip():
                project_name = item["name"].strip()
    except Exception as e:
        logger.warning("project lookup failed session=%s: %s", session_id, e)
    return project_id, project_name


def _propose_app_name(session_id: str) -> str:
    """Fallback chain: projects.name -> dated intake name -> short session tag.

    The result is pre-sanitized to the registry-safe form (the backend
    applies the same rules at creation) so the consent gate shows exactly
    the name that will be created — never a name the registry would reject.
    """
    _, project_name = _derive_project_context(session_id)
    if project_name:
        raw = project_name
    else:
        try:
            raw = f"Intake Request {datetime.now(timezone.utc).strftime('%Y-%m-%d')}"
        except Exception as e:  # noqa: BLE001 — naming must never block the flow
            logger.warning("date-based app name failed session=%s: %s", session_id, e)
            raw = f"Intake {session_id[:8]}"
    return sanitize_registry_name(raw)


def _app_gate(session_id: str, marker: dict) -> tuple[str, list[dict]]:
    proposed = marker.get("appName") or _propose_app_name(session_id)
    return (
        f"Shall I create a new app named '{proposed}' to bring them together?",
        [
            _action(f"Create '{proposed}'", f"Yes, create the app named {proposed}"),
            _action("Choose a different name", "I'd like a different name"),
            _action("Not now", "Not now"),
        ],
    )


def _blueprint_gate() -> tuple[str, list[dict]]:
    return (
        "Next, I can capture the process we designed as a reusable blueprint. "
        "Want me to generate it?",
        [_action("Generate blueprint", "Yes, generate the blueprint"),
         _action("Not now", "Not now")],
    )


def _import_gate(app_name: str) -> tuple[str, list[dict]]:
    return (
        f"Want me to add it to '{app_name}' as a workflow?",
        [
            _action(f"Add it to '{app_name}'", "Yes, add the blueprint to the app"),
            _action("Show me the steps first", "Show me the steps first"),
            _action("Not now", "Not now"),
        ],
    )


def _publish_next_steps(app_name: str) -> list[str]:
    """Ordered plain-language path from the draft workflow to a published app.

    Mirrors the real click-path: publish the workflow (enables Run), then
    Activate the app (the app-level Publish button stays hidden until then),
    then Publish -> Confirm Publish, which shows the endpoint URL and API key
    exactly once, after which the API Dashboard appears.
    """
    return [
        f"Open '{app_name}' from your Apps list and go to its Workflows tab.",
        "Publish the workflow from its card, or open it and use Publish on "
        "the canvas — publishing the workflow is what enables Run.",
        f"Back in the app header, select Activate — the app-level Publish "
        f"button only appears once '{app_name}' is activated.",
        "Select Publish, then Confirm Publish. You'll get the endpoint URL "
        "and an API key — the API key is shown only once, so copy it right "
        "away.",
        "After publishing, an API Dashboard appears in the app so you can "
        "watch requests, latency, and errors.",
    ]


def _final_gate(app_name: str) -> tuple[str, list[dict]]:
    return (
        f"Would you like to open '{app_name}' to review it?",
        [
            _action(f"Open '{app_name}'", f"Open {app_name}"),
            _action("Show me how to publish",
                    "Show me the steps to publish the workflow and the app"),
            _action("Done for now", "Done for now"),
        ],
    )


def _next_gate(session_id: str, marker: dict) -> tuple[str, list[dict]]:
    """Consent question + actions for the NEXT step given the marker stage."""
    stage = marker.get("stage")
    rank = _stage_rank(stage)
    app_name = marker.get("appName") or "your new app"
    if rank >= _stage_rank("workflow_imported"):
        return _final_gate(app_name)
    if rank >= _stage_rank("blueprint_created"):
        return _import_gate(app_name)
    if rank >= _stage_rank("app_created"):
        return _blueprint_gate()
    if rank >= _stage_rank("activated"):
        return _app_gate(session_id, marker)
    return (
        "Want me to activate them so they're ready to use?",
        [_action("Activate the agents", "Yes, activate the agents"),
         _action("Not now", "Not now")],
    )


# --- tool 1: check_fabrication_status -----------------------------------------


@tool
def check_fabrication_status(session_id: str) -> str:
    """Check how the queued agent builds are going for this session.

    Call this at the START of every turn while a fabrication is in flight
    (you cannot receive push notifications). Read-only; safe to repeat.

    Args:
        session_id: The current session ID

    Returns:
        JSON with aggregate counts, per-agent states in plain language, a
        conversational summary, and the consent question for the next step.
    """
    marker = get_postfab_marker(session_id)
    current_stage = marker.get("stage")

    if not FABRICATION_JOBS_TABLE:
        return _result(
            False, "unavailable",
            "I can't check the build status automatically right now.",
            "Do you know if the agents have finished building? We can also just try again in a bit.",
            [_action("Try again", "Check the build status again"),
             _action("Stop here", "Stop here")],
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
    except Exception as e:
        logger.warning("fabrication-jobs query failed session=%s: %s", session_id, e)
        return _result(
            False, "unavailable",
            "I can't check the build status automatically right now.",
            "Want me to try again in a moment?",
            [_action("Try again", "Check the build status again"),
             _action("Stop here", "Stop here")],
        )

    total = len(items)
    succeeded = [i.get("agentName") or i.get("agentUseId") for i in items if i.get("status") == "COMPLETED"]
    failed = [i.get("agentName") or i.get("agentUseId") for i in items if i.get("status") == "FAILED"]
    building = [i.get("agentName") or i.get("agentUseId") for i in items if i.get("status") not in _TERMINAL]
    agents = [
        {"name": i.get("agentName") or i.get("agentUseId"),
         "state": _STATUS_PLAIN.get(i.get("status"), "in an unknown state")}
        for i in items
    ]
    counts = {
        "built": len(succeeded),
        "failed": len(failed),
        "being_built": sum(1 for i in items if i.get("status") == "PROCESSING"),
        "waiting_to_start": sum(1 for i in items if i.get("status") == "PENDING"),
    }
    all_terminal = total > 0 and not building
    all_succeeded = all_terminal and not failed
    any_failed = bool(failed)

    if total == 0:
        status = "none"
    elif not all_terminal:
        status = "in_progress"
    elif all_succeeded:
        status = "complete"
    elif succeeded:
        status = "partial"
    else:
        status = "all_failed"

    extra = {
        "session_id": session_id, "total": total, "counts": counts,
        "agents": agents, "succeeded": succeeded, "failed": failed,
        "building": building, "all_terminal": all_terminal,
        "all_succeeded": all_succeeded, "any_failed": any_failed,
    }

    if status == "none":
        return _result(
            True, "none",
            "I don't see anything queued to build for this session yet.",
            "Want me to check again, or shall we review the fabrication plan together?",
            [_action("Check again", "Check the build status again"),
             _action("Review the plan", "Let's review the fabrication plan"),
             _action("Stop here", "Stop here")],
            **extra,
        )

    if status == "in_progress":
        if _stage_rank(current_stage) < _stage_rank("fabrication_pending"):
            set_postfab_marker(session_id, stage="fabrication_pending")
        detail = f", and {_join_names(building)} " + ("is" if len(building) == 1 else "are") + " in progress" if building else ""
        summary = (
            f"Still building — {len(succeeded)} of {total} agents are done{detail}. "
            "Check back with me any time and I'll give you the latest."
        )
        return _result(
            True, "in_progress", summary,
            "Want me to check again, or is there anything else while we wait?",
            [_action("Check again", "Check the build status again"),
             _action("Not now", "Not now")],
            **extra,
        )

    # Terminal: advance fabrication_pending -> built, never regress a later stage.
    if status in ("complete", "partial") and _stage_rank(current_stage) <= _stage_rank("fabrication_pending"):
        set_postfab_marker(session_id, stage="built")

    if status == "complete":
        return _result(
            True, "complete",
            f"All {total} agents built successfully.",
            "Want me to activate them so they're ready to use?",
            [_action(f"Activate {total} agents", "Yes, activate the agents"),
             _action("Not now", "Not now")],
            **extra,
        )

    if status == "partial":
        summary = (
            f"{len(succeeded)} of {total} agents built successfully. "
            f"{_join_names(failed)} didn't finish — I'll keep the details so we can come back to it."
        )
        return _result(
            True, "partial", summary,
            f"Want me to activate the {len(succeeded)} that are ready?",
            [_action(f"Activate {len(succeeded)} agents", "Yes, activate the agents that are ready"),
             _action(f"Look at {_join_names(failed[:1])} first", "Let's look at the failed agent first"),
             _action("Not now", "Not now")],
            **extra,
        )

    return _result(
        True, "all_failed",
        "None of the agents finished building this time. Nothing has been activated.",
        "Want to take another look at the fabrication plan together?",
        [_action("Review the plan", "Let's review the fabrication plan"),
         _action("Stop here", "Stop here")],
        **extra,
    )


# --- tool 2: activate_agents ---------------------------------------------------


@tool
def activate_agents(session_id: str) -> str:
    """Activate the agents fabricated for this session (consent step 1 of 4).

    Only call this after the user has explicitly confirmed. Idempotent —
    re-running a completed activation is safe and reports what was done.

    Args:
        session_id: The current session ID

    Returns:
        JSON with itemized per-agent results, a conversational summary, and
        the consent question for the app-creation gate.
    """
    marker = get_postfab_marker(session_id)
    if _stage_rank(marker.get("stage")) >= _stage_rank("activated") and marker.get("activation"):
        activation = marker["activation"]
        done = len(activation.get("activated", [])) + len(activation.get("alreadyActive", []))
        question, actions = _next_gate(session_id, marker)
        return _result(
            True, "already_done",
            f"The agents are already activated — {done} are active and they'll show as Active in your agent list.",
            question, actions, activation=activation,
        )

    try:
        data = appsync_client.execute(_ACTIVATE_MUTATION, {"sessionId": session_id}, session_id)
    except AppSyncError as err:
        return _error_return(session_id, err, "activating the agents")

    outcome = data.get("intakeActivateProjectAgents") or {}
    activated = outcome.get("activated") or []
    failed = outcome.get("failed") or []
    already = outcome.get("alreadyActive") or []
    matched_by = outcome.get("matchedBy")
    activation = {
        "activated": activated, "failed": failed,
        "alreadyActive": already, "matchedBy": matched_by,
    }

    if matched_by is None and not activated and not already:
        # Approved zero-activated explanation (failure mode 6) — do NOT advance.
        return _result(
            True, "zero_matched",
            "I couldn't match any built agents to this session, so nothing was "
            "activated — they may have been registered under a different project. "
            "Nothing has been changed.",
            "Want me to check the build status again?",
            [_action("Check build status", "Check the build status again"),
             _action("Stop here", "Stop here")],
            activation=activation,
        )

    set_postfab_marker(session_id, stage="activated", activation=activation)
    _record_stage_progress(session_id, "activated", "Agents activated")
    marker = get_postfab_marker(session_id)
    total = len(activated) + len(failed) + len(already)

    if failed:
        summary = (
            f"Activated {len(activated) + len(already)} of {total} agents. "
            f"{_join_names(failed)} couldn't be activated — it might need a "
            "governance sign-off before it can run. I'd suggest trying that one again first."
        )
        return _result(
            True, "partial", summary,
            "How would you like to proceed?",
            [_action(f"Retry {_join_names(failed[:1])}", "Retry the failed agent"),
             _action(f"Continue without {_join_names(failed[:1])}", "Continue without the failed agent"),
             _action("Stop here", "Stop here")],
            activation=activation,
        )

    if already and activated:
        summary = (
            f"Done — {len(activated)} agents are now active and {len(already)} "
            "were already active; they'll show as Active in your agent list."
        )
    elif already and not activated:
        summary = (
            f"Done — all {len(already)} agents were already active; "
            "they'll show as Active in your agent list."
        )
    else:
        summary = (
            f"Done — all {len(activated)} agents are now active and ready to use; "
            "they'll show as Active in your agent list."
        )

    question, actions = _app_gate(session_id, marker)
    return _result(True, "activated", summary, question, actions, activation=activation)


# --- tool 3: create_agent_app --------------------------------------------------


@tool
def create_agent_app(session_id: str, confirmed_name: str = "") -> str:
    """Propose or create the Agent App for this session (consent step 2 of 4).

    Call with NO confirmed_name first: it returns a name PROPOSAL from the
    project (no changes are made). Only after the user confirms or renames,
    call again with confirmed_name to actually create the app.

    Args:
        session_id: The current session ID
        confirmed_name: The user-confirmed app name; leave empty to propose.

    Returns:
        JSON with the proposal or creation result, a conversational summary,
        and the consent question for the next gate.
    """
    marker = get_postfab_marker(session_id)
    if marker.get("appId"):
        question, actions = _next_gate(session_id, marker)
        return _result(
            True, "already_done",
            f"The app '{marker.get('appName') or 'for this project'}' is already "
            "created — you'll find it in your Apps list.",
            question, actions, app_id=marker["appId"],
        )

    if not (confirmed_name or "").strip():
        proposed = _propose_app_name(session_id)
        return _result(
            True, "proposal",
            f"I can create a new app named '{proposed}' to bring your agents together.",
            f"Shall I create '{proposed}', or would you like a different name?",
            [_action(f"Create '{proposed}'", f"Yes, create the app named {proposed}"),
             _action("Choose a different name", "I'd like a different name"),
             _action("Not now", "Not now")],
            proposed_name=proposed,
        )

    name = confirmed_name.strip()
    try:
        data = appsync_client.execute(
            _CREATE_APP_MUTATION,
            {"sessionId": session_id, "name": name,
             "description": "Agents and workflow captured from an intake session"},
            session_id,
        )
    except AppSyncError as err:
        return _error_return(session_id, err, "creating the app")

    record = data.get("intakeCreateApp") or {}
    app_id = record.get("appId")
    app_name = record.get("name") or name
    if not app_id:
        return _error_return(
            session_id,
            AppSyncError("createApp returned no appId", retryable=True, error_type="EmptyResult"),
            "creating the app",
        )

    set_postfab_marker(session_id, stage="app_created", appId=app_id, appName=app_name)
    _record_stage_progress(session_id, "app_created", "Agent app created")
    question, actions = _blueprint_gate()
    summary = f"Created the app '{app_name}' — you'll find it in your Apps list."
    extras = {"app_id": app_id, "app_name": app_name}
    # The backend binds the session's activated agents at creation; surface
    # the count when the result carries them (itemized partial success: only
    # successfully-linked agents appear in agentBindings).
    linked = len(record.get("agentBindings") or [])
    if linked:
        noun = "agent" if linked == 1 else "agents"
        summary += f" I've linked {linked} {noun} from this session to it."
        extras["linked_agents"] = linked
    return _result(True, "created", summary, question, actions, **extras)


# --- tool 4: generate_process_blueprint -----------------------------------------


def _compose_steps(session_id: str, td2: str, plan: str, available: list[str]) -> list[dict]:
    """LLM-compose the ordered process steps from the design documents."""
    raw = _llm(
        "You turn technical design documents into an ordered agent workflow. "
        "Return only valid JSON.",
        f"""From the Agent Definitions and the fabrication plan below, produce the
business-process workflow as a JSON array. Each item must be:
- "agent": an agent name, chosen ONLY from this list: {json.dumps(available)}
- "depends_on": array of agent names (from the same list) whose output this agent consumes

Order the array by process sequence. Use every relevant agent from the list at
most once. Return ONLY the JSON array, no markdown.

## Agent Definitions
{td2}

## Fabrication Plan
{plan}""",
    )
    steps = json.loads(raw)
    if not isinstance(steps, list):
        raise ValueError("steps must be a JSON array")
    return steps


def _layout_positions(node_ids: list[str], edges: list[tuple[str, str]]) -> dict[str, dict]:
    """Deterministic layered layout: x = 100 + 300*depth, y = 200 + 250*lane.

    Raises ValueError on a cycle so the caller can fall back to a linear chain.
    """
    preds: dict[str, list[str]] = {n: [] for n in node_ids}
    succs: dict[str, list[str]] = {n: [] for n in node_ids}
    for src, tgt in edges:
        preds[tgt].append(src)
        succs[src].append(tgt)

    # Kahn topological order (cycle detection).
    in_deg = {n: len(preds[n]) for n in node_ids}
    queue = [n for n in node_ids if in_deg[n] == 0]
    topo: list[str] = []
    while queue:
        node = queue.pop(0)
        topo.append(node)
        for nxt in succs[node]:
            in_deg[nxt] -= 1
            if in_deg[nxt] == 0:
                queue.append(nxt)
    if len(topo) != len(node_ids):
        raise ValueError("cycle detected in composed workflow")

    depth = {n: 0 for n in node_ids}
    for node in topo:
        for nxt in succs[node]:
            depth[nxt] = max(depth[nxt], depth[node] + 1)

    lanes: dict[int, int] = {}
    positions: dict[str, dict] = {}
    for node in topo:
        lane = lanes.get(depth[node], 0)
        lanes[depth[node]] = lane + 1
        positions[node] = {"x": 100 + 300 * depth[node], "y": 200 + 250 * lane}
    return positions


def _is_weakly_connected(node_ids: list[str], edges: list[tuple[str, str]]) -> bool:
    if len(node_ids) <= 1:
        return True
    adjacency: dict[str, set[str]] = {n: set() for n in node_ids}
    for src, tgt in edges:
        adjacency[src].add(tgt)
        adjacency[tgt].add(src)
    seen = {node_ids[0]}
    stack = [node_ids[0]]
    while stack:
        for neighbour in adjacency[stack.pop()]:
            if neighbour not in seen:
                seen.add(neighbour)
                stack.append(neighbour)
    return len(seen) == len(node_ids)


def _build_envelope(name: str, node_ids: list[str], edges: list[tuple[str, str]]) -> dict:
    """Canonical WorkflowDefinition envelope (matches the seed-blueprint shape)."""
    try:
        positions = _layout_positions(node_ids, edges)
        connected = _is_weakly_connected(node_ids, edges)
    except ValueError:
        connected = False
    if not connected:
        # Fallback: linear chain in given order — always connected + acyclic.
        edges = [(node_ids[i], node_ids[i + 1]) for i in range(len(node_ids) - 1)]
        positions = _layout_positions(node_ids, edges)

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "version": "1.0.0",
        "id": str(uuid.uuid4()),
        "name": name,
        "createdAt": now,
        "updatedAt": now,
        "nodes": [
            {"id": node_id, "agentId": node_id,
             "position": positions[node_id], "configuration": {}}
            for node_id in node_ids
        ],
        "edges": [
            {"id": f"e-{index}", "source": src, "target": tgt,
             "sourceHandle": "output", "targetHandle": "input"}
            for index, (src, tgt) in enumerate(edges)
        ],
    }


@tool
def generate_process_blueprint(session_id: str) -> str:
    """Generate and publish the process blueprint (consent step 3 of 4).

    Composes the captured business process from the technical design and
    fabrication plan into a workflow blueprint whose steps are the real
    fabricated agents. Only call after the user has explicitly confirmed.

    Args:
        session_id: The current session ID

    Returns:
        JSON with the blueprint result, a conversational summary, and the
        consent question for the import gate.
    """
    marker = get_postfab_marker(session_id)
    app_name = marker.get("appName") or "your new app"

    if marker.get("blueprintId") and _stage_rank(marker.get("stage")) >= _stage_rank("blueprint_created"):
        question, actions = _next_gate(session_id, marker)
        return _result(
            True, "already_done",
            "The process blueprint is already generated and published.",
            question, actions, blueprint_id=marker["blueprintId"],
        )

    if not marker.get("appId"):
        question, actions = _app_gate(session_id, marker)
        return _result(
            False, "app_required",
            "We'll need the app in place before I can add a blueprint to it.",
            question, actions,
        )

    td2 = s3_get(SECTION_KEY.format(session_id=session_id))
    if not td2:
        return _result(
            False, "design_missing",
            "I couldn't find the technical design for this session, which I need "
            "to build the blueprint from. Nothing has been changed.",
            "Want me to try again?",
            [_action("Try again", "Try generating the blueprint again"),
             _action("Stop here", "Stop here")],
        )
    plan = s3_get(PLAN_KEY.format(session_id=session_id)) or ""

    registry = _get_existing_agents()
    resolvable = {name: rec["recordId"] for name, rec in registry.items() if rec.get("recordId")}

    try:
        steps = _compose_steps(session_id, td2, plan, sorted(resolvable))
    except Exception as e:
        logger.warning("blueprint composition failed session=%s: %s", session_id, e)
        return _result(
            False, "composition_failed",
            "I wasn't able to lay out the process steps this time. Nothing has been changed.",
            "Want me to try again?",
            [_action("Try again", "Try generating the blueprint again"),
             _action("Stop here", "Stop here")],
        )

    ordered_names: list[str] = []
    excluded: list[str] = []
    for step in steps:
        agent_name = step.get("agent") if isinstance(step, dict) else None
        if not agent_name or agent_name in ordered_names + excluded:
            continue
        (ordered_names if agent_name in resolvable else excluded).append(agent_name)

    if not ordered_names:
        return _result(
            False, "no_agents",
            "None of the process steps map to built agents yet, so there's "
            "nothing to put in the blueprint. Nothing has been changed.",
            "Want me to try again, or check the build status first?",
            [_action("Try again", "Try generating the blueprint again"),
             _action("Check build status", "Check the build status"),
             _action("Stop here", "Stop here")],
            excluded=excluded,
        )

    name_to_id = {n: resolvable[n] for n in ordered_names}
    edges = [
        (name_to_id[dep], name_to_id[step["agent"]])
        for step in steps if isinstance(step, dict) and step.get("agent") in name_to_id
        for dep in (step.get("depends_on") or []) if dep in name_to_id and dep != step["agent"]
    ]
    envelope = _build_envelope(
        f"{app_name} Process", [name_to_id[n] for n in ordered_names], edges,
    )

    try:
        data = appsync_client.execute(
            _CREATE_BLUEPRINT_MUTATION,
            {"sessionId": session_id, "name": envelope["name"],
             "definition": json.dumps(envelope)},
            session_id,
        )
    except AppSyncError as err:
        return _error_return(session_id, err, "publishing the blueprint")

    outcome = data.get("intakeCreateBlueprint") or {}
    status = outcome.get("status")

    if status == "PUBLISHED" and outcome.get("blueprintId"):
        blueprint_id = outcome["blueprintId"]
        set_postfab_marker(session_id, stage="blueprint_created", blueprintId=blueprint_id)
        _record_stage_progress(session_id, "blueprint_created", "Process blueprint published")
        node_count = outcome.get("nodeCount") or len(ordered_names)
        summary = (
            f"Done — the blueprint maps your {node_count} agents into "
            f"{node_count} connected steps."
        )
        if excluded:
            summary += (
                f" Note: I left out {_join_names(excluded)} — "
                "not one of the built agents."
            )
        question, actions = _import_gate(app_name)
        return _result(
            True, "published", summary, question, actions,
            blueprint_id=blueprint_id, node_count=node_count,
            steps=ordered_names, excluded=excluded,
        )

    if status == "AGENTS_SYNCING":
        # Approved sync-race copy: the button IS the retry — never promise
        # an autonomous retry.
        return _result(
            False, "agents_syncing",
            "Your agents are still being set up behind the scenes — this "
            "usually takes under a minute.",
            "Want me to try again?",
            [_action("Try again", "Try generating the blueprint again"),
             _action("Stop here", "Stop here")],
            retryable=True, excluded=excluded,
        )

    logger.warning(
        "blueprint rejected session=%s status=%s errors=%d",
        session_id, status, len(outcome.get("errors") or []),
    )
    return _result(
        False, "validation_failed",
        "That didn't go through — the blueprint I generated didn't pass "
        "validation. Nothing has been added to your app.",
        "Want me to try generating it again?",
        [_action("Try again", "Try generating the blueprint again"),
         _action("Stop here", "Stop here")],
        retryable=False, excluded=excluded,
    )


# --- tool 5: import_blueprint_to_app --------------------------------------------


@tool
def import_blueprint_to_app(session_id: str) -> str:
    """Import the published blueprint into the app (consent step 4 of 4).

    The imported workflow stays a draft for the user to review and publish on
    the canvas. Only call after the user has explicitly confirmed.

    Args:
        session_id: The current session ID

    Returns:
        JSON with the import result, a conversational summary including where
        to find the workflow, and the closing actions.
    """
    marker = get_postfab_marker(session_id)
    app_name = marker.get("appName") or "your new app"

    if marker.get("workflowId") and _stage_rank(marker.get("stage")) >= _stage_rank("workflow_imported"):
        # Re-issue the (idempotent) import: the backend returns the existing
        # workflow instead of duplicating it AND re-ensures the app's agent
        # bindings — this heals apps whose workflow was imported before
        # app-level bindings existed. Best-effort: the workflow IS imported,
        # so a failed call never turns this answer into an error.
        if marker.get("blueprintId") and marker.get("appId"):
            try:
                appsync_client.execute(
                    _IMPORT_MUTATION,
                    {"sessionId": session_id, "blueprintId": marker["blueprintId"],
                     "appId": marker["appId"], "name": f"{app_name} Process"},
                    session_id,
                )
            except AppSyncError as err:
                logger.warning(
                    "already_done binding heal failed session=%s type=%s",
                    session_id, err.error_type,
                )
        question, actions = _final_gate(app_name)
        return _result(
            True, "already_done",
            f"The workflow is already in '{app_name}' — you'll find it in the "
            f"Workflows tab of '{app_name}', saved as a draft.",
            question, actions, workflow_id=marker["workflowId"],
            next_steps=_publish_next_steps(app_name),
        )

    if not marker.get("blueprintId") or not marker.get("appId"):
        question, actions = (
            _blueprint_gate() if marker.get("appId") else _app_gate(session_id, marker)
        )
        return _result(
            False, "blueprint_required" if marker.get("appId") else "app_required",
            "We'll need the blueprint in place before I can add it to the app."
            if marker.get("appId") else
            "We'll need the app in place before I can import a workflow into it.",
            question, actions,
        )

    try:
        data = appsync_client.execute(
            _IMPORT_MUTATION,
            {"sessionId": session_id, "blueprintId": marker["blueprintId"],
             "appId": marker["appId"], "name": f"{app_name} Process"},
            session_id,
        )
    except AppSyncError as err:
        return _error_return(session_id, err, "importing the workflow")

    workflow = data.get("intakeImportBlueprintToApp") or {}
    workflow_id = workflow.get("workflowId")
    if not workflow_id:
        return _error_return(
            session_id,
            AppSyncError("import returned no workflowId", retryable=True, error_type="EmptyResult"),
            "importing the workflow",
        )

    set_postfab_marker(session_id, stage="workflow_imported", workflowId=workflow_id)
    _record_stage_progress(session_id, "workflow_imported", "Workflow imported into app")
    activation = marker.get("activation") or {}
    activated_count = len(activation.get("activated", [])) + len(activation.get("alreadyActive", []))
    question, actions = _final_gate(app_name)
    return _result(
        True, "imported",
        f"Added your workflow to '{app_name}' as a draft — you'll find it in "
        f"the Workflows tab of '{app_name}', saved as a draft. When you're "
        "ready to take it live, I can walk you through the steps to publish "
        "the workflow and then the app.",
        question, actions, workflow_id=workflow_id,
        next_steps=_publish_next_steps(app_name),
        recap=(
            f"All set. Here's what we did: activated {activated_count} agents, "
            f"created the app '{app_name}', and added your process to it as a "
            f"draft workflow. You can open '{app_name}' from your Apps list any "
            "time. Publishing the workflow and then the app is the last "
            "stretch — it ends with an endpoint URL and an API key other "
            "systems can use to call it."
        ),
    )
