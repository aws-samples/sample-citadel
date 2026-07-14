"""Minimal runnable demo agent.

Exposes the ``handler`` entry point the worker's subprocess runner invokes
(``module.handler(**request)``). It deterministically returns its input as its
output — no model call, no external dependencies — so it can execute end to end
under the worker wrapper and drive a workflow to completion.

This file is data for the seed Lambda: it is uploaded verbatim to the agent
code bucket at ``agents/demo_echo_agent.py`` so the worker can resolve it from
the seeded agent config's ``filename`` field. It is never imported by the seed
Lambda itself.
"""


def handler(**kwargs):
    """Echo the supplied keyword arguments back as the agent's output.

    The worker invokes the loaded module as ``handler(**request)`` where
    ``request`` is the workflow node's input payload. Returning the same
    mapping makes this a pure, deterministic echo.

    Returns:
        dict: the input payload, unchanged.
    """
    return kwargs
