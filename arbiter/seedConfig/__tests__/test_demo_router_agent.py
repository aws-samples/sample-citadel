"""Unit tests for the demo_router_agent module.

Validates that the router agent:
  - Returns {"route": <input_route>} when a route is provided.
  - Defaults to "branch-a" when no route is supplied.
  - Defaults to "branch-a" when route is empty string or None.
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from demo_router_agent import handler, DEFAULT_ROUTE


class TestDemoRouterAgentDefaults:
    """Default routing when no route is supplied."""

    def test_default_route_is_branch_a(self):
        assert DEFAULT_ROUTE == "branch-a"

    def test_handler_returns_default_when_no_route(self):
        result = handler()
        assert result == {"route": "branch-a"}

    def test_handler_returns_default_when_empty_string(self):
        result = handler(route="")
        assert result == {"route": "branch-a"}

    def test_handler_returns_default_when_none(self):
        result = handler(route=None)
        assert result == {"route": "branch-a"}


class TestDemoRouterAgentExplicitRoute:
    """Explicit route selection via input."""

    def test_handler_returns_branch_a_when_requested(self):
        result = handler(route="branch-a")
        assert result == {"route": "branch-a"}

    def test_handler_returns_branch_b_when_requested(self):
        result = handler(route="branch-b")
        assert result == {"route": "branch-b"}

    def test_handler_returns_arbitrary_route(self):
        result = handler(route="custom-branch")
        assert result == {"route": "custom-branch"}

    def test_handler_ignores_extra_kwargs(self):
        result = handler(route="branch-b", message="hello", extra="ignored")
        assert result == {"route": "branch-b"}


class TestDemoRouterAgentOutputShape:
    """Output shape is always {"route": str}."""

    def test_output_has_exactly_one_key(self):
        result = handler(route="branch-a")
        assert set(result.keys()) == {"route"}

    def test_output_route_is_string(self):
        result = handler(route="branch-b")
        assert isinstance(result["route"], str)
