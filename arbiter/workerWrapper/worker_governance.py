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

Pure functions; no I/O from this module beyond WARN logs emitted by the
decision 67caf7b0 size-cap enforcement (oversized overrides are skipped,
never truncated, never fatal). The actual ledger write path
for layer 1 is in index.py::process_event where step constraints are
applied; it uses arbiter/governance/ledger.py::write_finding.

Spec: arbiter-governance-engine/requirements.md Requirement 9.6–9.8.
Plan: US-ARB-015 Δ 14. QD-5 distinct-scope rule.
"""

import json
import logging
import os

logger = logging.getLogger(__name__)

# Decision 67caf7b0: size caps on per-task/per-node overrides. Violations
# SKIP the override entirely with a WARN — never truncate, never fail the
# task/node.
DEFAULT_MAX_PROMPT_ADDITION_CHARS = 4000
MAX_MODEL_OVERRIDE_CHARS = 256


def get_max_prompt_addition_chars() -> int:
    """Effective systemPromptAddition cap from WORKER_MAX_PROMPT_ADDITION_CHARS.

    Re-read from the environment on every call (matching the worker's
    per-call ``os.environ`` access idiom, e.g. agent_runner's MODEL_OVERRIDE
    read). Falls back to ``DEFAULT_MAX_PROMPT_ADDITION_CHARS`` when the
    variable is missing, non-integer, or non-positive.
    """
    raw = os.environ.get('WORKER_MAX_PROMPT_ADDITION_CHARS')
    if raw is None:
        return DEFAULT_MAX_PROMPT_ADDITION_CHARS
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_MAX_PROMPT_ADDITION_CHARS
    if value <= 0:
        return DEFAULT_MAX_PROMPT_ADDITION_CHARS
    return value

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

    Enforces the decision 67caf7b0 size cap here so BOTH callers — the
    supervisor task path and the workflow-node path — get the rule with no
    caller changes. The length check runs on the stripped value; an
    over-cap addition is SKIPPED entirely (never truncated) with a WARN,
    and the prompt is returned unchanged so the task/node proceeds.

    Args:
        system_prompt: The agent's existing system prompt / description.
        addition: Optional text to append.

    Returns:
        The combined system prompt, or ``system_prompt`` unchanged when the
        addition is falsy or exceeds the cap.
    """
    if not addition:
        return system_prompt
    if isinstance(addition, str):
        cap = get_max_prompt_addition_chars()
        length = len(addition.strip())
        if length > cap:
            logger.warning(json.dumps({
                'level': 'WARN',
                'component': 'WorkerGovernance',
                'action': 'system_prompt_addition_skipped',
                'reason': 'systemPromptAddition exceeds cap; override skipped '
                          'entirely (never truncated)',
                'length': length,
                'cap': cap,
            }))
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
        # Decision 67caf7b0: 256-char hygiene cap, same skip+WARN semantics
        # as systemPromptAddition — the env var is never installed with an
        # over-cap value and the task/node proceeds without the override.
        override_length = (
            len(model_override.strip()) if isinstance(model_override, str) else None
        )
        if override_length is not None and override_length > MAX_MODEL_OVERRIDE_CHARS:
            logger.warning(json.dumps({
                'level': 'WARN',
                'component': 'WorkerGovernance',
                'action': 'model_override_skipped',
                'reason': 'modelOverride exceeds cap; override skipped '
                          'entirely (never truncated)',
                'length': override_length,
                'cap': MAX_MODEL_OVERRIDE_CHARS,
                'agentId': agent_id,
                'workflowId': workflow_id,
            }))
        else:
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
