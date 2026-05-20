"""
Governance helpers for Worker Wrapper.

Pure functions for step constraint enforcement and agent binding overrides.
These are extracted from process_event for testability.
"""

import json
import os


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
) -> dict:
    """Build the subprocess environment with governance and config overrides.

    Injects APP_CONFIG, MODEL_OVERRIDE, and MAX_ITERATIONS env vars as needed.
    When values are None, the corresponding env var is not set (backward compatible).

    Args:
        base_env: The base environment dict (copy of os.environ).
        app_config: Optional app configuration values to serialize as JSON.
        model_override: Optional Bedrock model ID override.
        max_iterations: Optional max LLM conversation turns.

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

    return env
