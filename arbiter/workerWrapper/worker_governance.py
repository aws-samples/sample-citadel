"""Governance helpers for the Worker Wrapper (worker-pre-filter scope).

Citadel enforces tool-call governance at TWO independent layers per QD-5:

  Layer 1 — worker-pre-filter (this module, scope_evaluated='worker-pre-filter'):
    Functions `get_blocked_tools`, `apply_tool_restrictions`, and
    `apply_step_constraints` run at dispatch time BEFORE the agent
    subprocess starts. They strip forbidden tool IDs from the agent's
    tool list based on step_constraints coming from the orchestration
    payload. Findings emitted here carry scope='worker-pre-filter'.

  Layer 2 — worker-tool-handler (see governed_tool_handler.py,
    scope_evaluated='worker-tool-handler'):
    A Strands AgentToolHandler subclass whose preprocess() method
    intercepts each individual tool invocation inside the running
    agent subprocess and short-circuits it if the tool is denied.
    Findings emitted here carry scope='worker-tool-handler'.

Per QD-5 the two layers' findings MUST NEVER be merged or deduplicated
— they represent independent defensive checkpoints. A denied tool call
normally produces TWO findings (one per layer).

Each layer's scope constant is exported here and in governed_tool_handler
for symmetric reference:

  - SCOPE_WORKER_PRE_FILTER    = 'worker-pre-filter'
  - SCOPE_WORKER_TOOL_HANDLER  = 'worker-tool-handler'  (governed_tool_handler.py)

Pure functions; no I/O from this module. The actual ledger write path
for layer 1 is in index.py::process_event where step constraints are
applied; it uses arbiter/governance/ledger.py::write_finding.

Spec: arbiter-governance-engine/requirements.md Requirement 9.6–9.8.
Plan: US-ARB-015 Δ 14. QD-5 distinct-scope rule.
"""

import json
import os

# US-ARB-015: scope identifier for findings emitted from this layer. Paired
# with SCOPE_WORKER_TOOL_HANDLER in governed_tool_handler.py. QD-5 mandates
# both layers fire independently; the constants are exported here purely for
# symmetric reference and type-safe imports.
SCOPE_WORKER_PRE_FILTER = 'worker-pre-filter'


def apply_step_constraints(tools: list[str], step_constraints: dict | None) -> list[str]:
    """Filter agent tools to intersection with stepConstraints.allowedTools.

    If step_constraints is None or has no allowedTools, returns all tools unchanged
    (backward compatible — Req 13.5).

    Args:
        tools: The agent's configured tool IDs.
        step_constraints: Optional dict with 'allowedTools', 'maxIterations', etc.

    Returns:
        Filtered list of tool IDs (intersection of agent tools and allowedTools).
    """
    if not step_constraints or 'allowedTools' not in step_constraints:
        return list(tools)

    allowed = set(step_constraints['allowedTools'])
    filtered = [t for t in tools if t in allowed]
    blocked = [t for t in tools if t not in allowed]
    return filtered


def get_blocked_tools(tools: list[str], step_constraints: dict | None) -> list[str]:
    """Return the list of tools that were blocked by step constraints.

    Used for governance enforcement logging (Req 13 AC 7).
    """
    if not step_constraints or 'allowedTools' not in step_constraints:
        return []
    allowed = set(step_constraints['allowedTools'])
    return [t for t in tools if t not in allowed]


def apply_tool_restrictions(tools: list[str], tool_restrictions: list[str] | None) -> list[str]:
    """Exclude tools listed in binding toolRestrictions.

    Unrecognized tool IDs (not in agent tools) are silently ignored (Req 3.7).

    Args:
        tools: The agent's current tool IDs.
        tool_restrictions: Optional list of tool IDs to exclude.

    Returns:
        Filtered list with restricted tools removed.
    """
    if not tool_restrictions:
        return list(tools)

    restrictions = set(tool_restrictions)
    return [t for t in tools if t not in restrictions]


def apply_system_prompt_addition(system_prompt: str, addition: str | None) -> str:
    """Append systemPromptAddition to the agent's system prompt.

    Args:
        system_prompt: The agent's existing system prompt / description.
        addition: Optional text to append.

    Returns:
        The combined system prompt.
    """
    if not addition:
        return system_prompt
    return system_prompt + '\n' + addition


def build_subprocess_env(
    base_env: dict,
    app_config: dict | None = None,
    model_override: str | None = None,
    max_iterations: int | None = None,
    agent_id: str | None = None,
    workflow_id: str | None = None,
    denied_tools: list[str] | None = None,
) -> dict:
    """Build the subprocess environment with governance and config overrides.

    Injects ``APP_CONFIG``, ``MODEL_OVERRIDE``, ``MAX_ITERATIONS``, and the
    US-ARB-012a governance-injection triplet (``CITADEL_AGENT_ID``,
    ``CITADEL_WORKFLOW_ID``, ``DENIED_TOOLS``) as needed. When a value is
    ``None``/empty the corresponding env var is not set — keeps the
    existing callers backward compatible.

    The governance triplet drives ``agent_runner._install_governed_tool_handler``:
      - ``CITADEL_AGENT_ID`` is the trigger. When absent the runner does
        NOT patch ``strands.Agent``, so legacy callers see no change.
      - ``CITADEL_WORKFLOW_ID`` flows into every finding written at scope
        ``'worker-tool-handler'`` for trace correlation.
      - ``DENIED_TOOLS`` is the comma-separated allow-list of tools the
        handler will deny at preprocess time.

    Args:
        base_env: The base environment dict (typically ``os.environ.copy()``).
        app_config: Optional app configuration values to serialise as JSON.
        model_override: Optional Bedrock model ID override.
        max_iterations: Optional max LLM conversation turns.
        agent_id: Optional agent identifier for QD-5 layer-2 findings.
        workflow_id: Optional workflow/orchestration identifier for QD-5
            layer-2 findings.
        denied_tools: Optional list of tool IDs the layer-2 handler must
            deny. Non-string entries and empty strings are filtered out
            so a stray ``None`` from upstream doesn't produce garbage.

    Returns:
        The augmented environment dict.
    """
    env = dict(base_env)

    if app_config is not None:
        env['APP_CONFIG'] = json.dumps(app_config)

    if model_override is not None:
        env['MODEL_OVERRIDE'] = model_override

    if max_iterations is not None:
        env['MAX_ITERATIONS'] = str(max_iterations)

    # US-ARB-012a layer-2 governance triplet.
    if agent_id:
        env['CITADEL_AGENT_ID'] = agent_id
    if workflow_id:
        env['CITADEL_WORKFLOW_ID'] = workflow_id
    if denied_tools:
        # Preserve order for determinism and strip falsy entries so a
        # caller-supplied ``[None, '']`` does not serialise to ``,,``.
        cleaned = [str(t) for t in denied_tools if t]
        if cleaned:
            env['DENIED_TOOLS'] = ','.join(cleaned)

    return env
