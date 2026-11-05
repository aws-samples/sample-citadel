"""Minimal routing demo agent.

Exposes the ``handler`` entry point the worker's subprocess runner invokes
(``module.handler(**request)``).  Returns ``{"route": <value>}`` where
*value* is taken from the input payload's ``route`` key, defaulting to
``"branch-a"`` when no route is supplied.

This makes the seeded *Conditional Router* blueprint work end to end: the
blueprint's conditional edges match on ``result.route equals branch-a`` /
``result.route equals branch-b``, so providing ``{"route": "branch-b"}`` at
execution time steers the workflow down the branch-b path.

This file is data for the seed Lambda: it is uploaded verbatim to the agent
code bucket at ``agents/demo_router_agent.py`` so the worker can resolve it
from the seeded agent config's ``filename`` field.  It is never imported by
the seed Lambda itself.
"""

DEFAULT_ROUTE = "branch-a"


def handler(**kwargs):
    """Return a routing decision based on the input payload.

    The ``route`` key in the input selects which conditional branch fires.
    When absent, defaults to ``"branch-a"`` so the blueprint always takes
    at least one branch.

    Returns:
        dict: ``{"route": "<branch-a|branch-b>"}``
    """
    route = kwargs.get("route") or DEFAULT_ROUTE
    return {"route": route}
