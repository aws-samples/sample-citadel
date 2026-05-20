"""Fabrication tools — plan, confirm, and trigger agent fabrication."""
import json
import os
import boto3
from strands.tools import tool
from tools.kb import s3_get, s3_put
from config import bedrock, AGENT_MODEL_ID

SECTION_KEY = "{session_id}/design/td_2.md"
PLAN_KEY = "{session_id}/planning/fabrication_plan.md"
FABRICATOR_QUEUE_URL = os.getenv("FABRICATOR_QUEUE_URL", "")
AGENT_CONFIG_TABLE = os.getenv("AGENT_CONFIG_TABLE", "")
AWS_REGION = os.getenv("AWS_REGION", "ap-southeast-2")

sqs = boto3.client("sqs", region_name=AWS_REGION)
dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)


def _llm(system: str, user: str, max_tokens: int = 8192) -> str:
    resp = bedrock.converse(
        modelId=AGENT_MODEL_ID,
        system=[{"text": system}],
        messages=[{"role": "user", "content": [{"text": user}]}],
        inferenceConfig={"maxTokens": max_tokens, "temperature": 0},
    )
    raw = resp["output"]["message"]["content"][0]["text"].strip()
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
- "requires_external": true if this agent requires proprietary SDKs, on-prem systems, hardware, or cannot be auto-built; false otherwise
- "external_reason": brief reason if requires_external is true, else null

Return ONLY a JSON array, no markdown.

{td2_content}"""
    )
    return json.loads(raw)


def _get_existing_agents() -> dict[str, dict]:
    """Returns {agentId: config} for all agents in the factory."""
    if not AGENT_CONFIG_TABLE:
        return {}
    table = dynamodb.Table(AGENT_CONFIG_TABLE)
    resp = table.scan(ProjectionExpression="agentId, config, #s", ExpressionAttributeNames={"#s": "state"})
    return {item["agentId"]: item for item in resp.get("Items", [])}


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
            reason = f"Already in factory (v{existing[name].get('config', {}).get('version', '1')})"
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
    return summary.strip()


@tool
def list_factory_agents() -> str:
    """List all agents that have been built and registered in the factory.

    Returns:
        Summary of registered agents with their name, description, state, and version.
    """
    if not AGENT_CONFIG_TABLE:
        return "Error: AGENT_CONFIG_TABLE environment variable not set."

    existing = _get_existing_agents()
    if not existing:
        return "No agents have been built yet."

    lines = [f"{'Agent':<30} {'State':<12} {'Version':<8} Description"]
    lines.append("-" * 90)
    for agent_id, item in sorted(existing.items()):
        config = item.get("config", {})
        lines.append(
            f"{agent_id:<30} "
            f"{item.get('state', ''):<12} "
            f"{config.get('version', ''):<8} "
            f"{config.get('description', '')[:50]}"
        )
    return "\n".join(lines)
