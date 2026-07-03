"""
Subprocess agent runner.

Executed by the worker wrapper as an isolated subprocess. Receives the
agent module path and request payload via stdin (JSON). Scoped AWS
credentials are injected into this process's environment by the parent
— they never touch the parent's os.environ.

Writes the agent response as a JSON line to stdout.
"""

import json
import sys
import os
import importlib.util


def _install_governed_tool_handler():
    """Patch ``strands.Agent.__init__`` to inject a GovernedToolHandler.

    Runs inside the subprocess before the agent module is exec'd, so every
    ``Agent(...)`` construction inside the loaded module automatically
    picks up governance enforcement at tool-call time (QD-5 layer 2,
    ``scope_evaluated='worker-tool-handler'``).

    No-op when ``CITADEL_AGENT_ID`` is not set in the environment — that
    preserves backward compatibility with agents running outside the
    governance envelope (local dev, legacy callers).

    Graceful degrade when ``strands`` or ``governed_tool_handler`` cannot
    be imported: WARN to stderr and return False. Best-effort semantics
    (AC 9.4) mean a missing layer-2 handler must not halt execution of
    an otherwise-valid agent.

    Caller-supplied ``tool_handler=...`` on ``Agent(...)`` always wins —
    the injector only fills in the default. This preserves the escape
    hatch for agents that ship their own policy surface.

    Returns True when the patch was installed, False otherwise.
    """
    if not os.environ.get('CITADEL_AGENT_ID'):
        return False

    try:
        import strands  # type: ignore[import-not-found]
    except ImportError as exc:
        sys.stderr.write(
            f'[agent_runner] WARN governance injection skipped — '
            f'strands unavailable: {exc}\n'
        )
        return False

    # governed_tool_handler lives alongside this file in
    # arbiter/workerWrapper/. Its own module-load logic wires the project
    # root onto sys.path so ``arbiter.governance.*`` imports inside the
    # handler resolve correctly.
    _here = os.path.dirname(os.path.abspath(__file__))
    if _here not in sys.path:
        sys.path.insert(0, _here)

    try:
        from governed_tool_handler import GovernedToolHandler
    except ImportError as exc:
        sys.stderr.write(
            f'[agent_runner] WARN governance injection skipped — '
            f'governed_tool_handler unavailable: {exc}\n'
        )
        return False

    original_init = strands.Agent.__init__

    def _governed_init(self, *args, **kwargs):
        # Caller-supplied handler always wins — never override an explicit
        # tool_handler= in generated code.
        if 'tool_handler' not in kwargs or kwargs['tool_handler'] is None:
            kwargs['tool_handler'] = GovernedToolHandler(
                agent_id=os.environ.get('CITADEL_AGENT_ID', 'unknown-agent'),
                workflow_id=os.environ.get('CITADEL_WORKFLOW_ID', 'unknown-workflow'),
                # ``denied_tools=None`` lets GovernedToolHandler read
                # DENIED_TOOLS from env itself, keeping a single source of
                # truth for env parsing semantics.
                denied_tools=None,
            )
        return original_init(self, *args, **kwargs)

    strands.Agent.__init__ = _governed_init
    return True


def _install_model_override():
    """Patch ``strands.models.BedrockModel.__init__`` to force ``model_id``.

    Overrides the model id for operator-selected per-agent overrides; a no-op
    unless ``MODEL_OVERRIDE`` is set in the subprocess environment. Runs inside
    the subprocess before the agent module is exec'd, so every ``BedrockModel``
    construction in the loaded module picks up the operator-selected id.

    Graceful degrade when ``strands`` (or its ``models`` submodule) cannot be
    imported, or when ``BedrockModel`` is absent: WARN to stderr and return
    False. A missing override layer must never halt an otherwise-valid agent.

    Returns True when the patch was installed, False otherwise.
    """
    override = os.environ.get('MODEL_OVERRIDE')
    if not override:
        return False

    try:
        import strands  # type: ignore[import-not-found]  # noqa: F401
        from strands import models as _sm
    except ImportError as exc:
        sys.stderr.write(
            f'[agent_runner] WARN model override skipped — '
            f'strands unavailable: {exc}\n'
        )
        return False

    Bedrock = getattr(_sm, 'BedrockModel', None)
    if Bedrock is None:
        return False

    original_init = Bedrock.__init__

    def _override_init(self, *args, **kwargs):
        kwargs['model_id'] = override
        return original_init(self, *args, **kwargs)

    Bedrock.__init__ = _override_init
    return True


def main():
    # Read input from stdin (single JSON line)
    raw = sys.stdin.read()
    payload = json.loads(raw)

    module_path = payload['modulePath']
    request = payload.get('request', {})

    # Install governance patch BEFORE exec_module so every Agent(...)
    # construction in the loaded module picks it up. Safe no-op when the
    # subprocess env lacks CITADEL_AGENT_ID (backward compatible).
    _install_governed_tool_handler()

    # Overrides the model id for operator-selected per-agent overrides;
    # no-op unless MODEL_OVERRIDE is set in the subprocess environment.
    _install_model_override()

    # Load and execute the agent module
    spec = importlib.util.spec_from_file_location("agent_module", module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    try:
        response = module.handler(**request)
    except Exception as e:
        response = f"Agent execution failed: {e}"

    # Write response as JSON to stdout
    print(json.dumps({"response": str(response)}))


if __name__ == "__main__":
    main()
