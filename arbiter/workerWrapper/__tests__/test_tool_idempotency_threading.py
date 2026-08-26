"""Tests for tool-call idempotency context threading (PR1).

Covers the three additive env vars in ``build_subprocess_env`` (back-compat
byte-identity when absent), the server-side orgId resolver in ``index.py``
(never trusts a payload value), and the hook's back-compat no-op contract.
"""
from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock

_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from worker_governance import build_subprocess_env  # noqa: E402


class TestSubprocessEnvThreading:
    def test_idempotency_context_set_when_provided(self):
        env = build_subprocess_env(
            {}, execution_id="exec1", node_id="node1", org_id="orgA"
        )
        assert env["CITADEL_EXECUTION_ID"] == "exec1"
        assert env["CITADEL_NODE_ID"] == "node1"
        assert env["CITADEL_ORG_ID"] == "orgA"

    def test_absent_context_is_byte_identical_backcompat(self):
        base = build_subprocess_env({}, agent_id="a", workflow_id="w")
        assert "CITADEL_EXECUTION_ID" not in base
        assert "CITADEL_NODE_ID" not in base
        assert "CITADEL_ORG_ID" not in base

    def test_empty_org_id_omitted_but_exec_node_kept(self):
        # An empty orgId is allowed (executionId is globally unique); it is
        # simply not written as an env var, so the hook reads '' by default.
        env = build_subprocess_env({}, execution_id="e", node_id="n", org_id="")
        assert env["CITADEL_EXECUTION_ID"] == "e"
        assert env["CITADEL_NODE_ID"] == "n"
        assert "CITADEL_ORG_ID" not in env

    def test_breaker_targets_serialized_to_json_env(self):
        # task 28d624b1: the per-dispatch tool NAME -> [kind, id] map is
        # serialized to TOOL_BREAKER_TARGETS (delivered like DENIED_TOOLS,
        # NEVER via the S3 tool module).
        import json
        env = build_subprocess_env({}, tool_breaker_targets={
            "remote_tool": ["mcp_server", "mcp-1"],
            "jira_tool": ("integration", "jira-1"),
        })
        parsed = json.loads(env["TOOL_BREAKER_TARGETS"])
        assert parsed["remote_tool"] == ["mcp_server", "mcp-1"]
        assert parsed["jira_tool"] == ["integration", "jira-1"]

    def test_breaker_targets_absent_is_backcompat(self):
        env = build_subprocess_env({}, agent_id="a")
        assert "TOOL_BREAKER_TARGETS" not in env

    def test_breaker_targets_malformed_entries_dropped(self):
        import json
        env = build_subprocess_env({}, tool_breaker_targets={
            "ok": ["mcp_server", "m1"],
            "bad_len": ["only-one"],
            "empty_id": ["mcp_server", ""],
        })
        parsed = json.loads(env["TOOL_BREAKER_TARGETS"])
        assert parsed == {"ok": ["mcp_server", "m1"]}


class TestServerSideOrgResolution:
    def _index(self):
        import index  # resolved to workerWrapper/index by conftest
        return index

    def test_org_id_read_from_execution_row(self, monkeypatch):
        index = self._index()
        monkeypatch.setenv("EXECUTIONS_TABLE", "citadel-executions-test")
        table = MagicMock()
        table.get_item.return_value = {"Item": {"executionId": "e1", "orgId": "org-trusted"}}
        ddb = MagicMock()
        ddb.Table.return_value = table
        monkeypatch.setattr(index, "_get_dynamodb", lambda: ddb)
        assert index._resolve_execution_org_id("e1") == "org-trusted"

    def test_falls_back_to_env_when_row_missing_org(self, monkeypatch):
        index = self._index()
        monkeypatch.setenv("EXECUTIONS_TABLE", "citadel-executions-test")
        monkeypatch.setenv("RELEASE_DEFAULT_ORG_ID", "org-default")
        table = MagicMock()
        table.get_item.return_value = {"Item": {"executionId": "e1"}}  # no orgId
        ddb = MagicMock()
        ddb.Table.return_value = table
        monkeypatch.setattr(index, "_get_dynamodb", lambda: ddb)
        assert index._resolve_execution_org_id("e1") == "org-default"

    def test_returns_empty_when_no_table_and_no_env(self, monkeypatch):
        index = self._index()
        monkeypatch.delenv("EXECUTIONS_TABLE", raising=False)
        monkeypatch.delenv("RELEASE_DEFAULT_ORG_ID", raising=False)
        assert index._resolve_execution_org_id("e1") == ""

    def test_read_failure_is_non_fatal(self, monkeypatch):
        index = self._index()
        monkeypatch.setenv("EXECUTIONS_TABLE", "citadel-executions-test")
        monkeypatch.delenv("RELEASE_DEFAULT_ORG_ID", raising=False)
        ddb = MagicMock()
        ddb.Table.side_effect = RuntimeError("ddb down")
        monkeypatch.setattr(index, "_get_dynamodb", lambda: ddb)
        assert index._resolve_execution_org_id("e1") == ""  # never raises


class TestHookBackCompat:
    def test_hook_disabled_without_execution_node(self):
        from tool_idempotency_hook import IdempotencyToolHook

        assert IdempotencyToolHook(org_id="o", execution_id="", node_id="").enabled is False
        assert IdempotencyToolHook(org_id="o", execution_id="e", node_id="").enabled is False

    def test_hook_enabled_with_execution_and_node(self):
        from tool_idempotency_hook import IdempotencyToolHook

        assert IdempotencyToolHook(org_id="", execution_id="e", node_id="n").enabled is True

    def test_register_hooks_noop_when_disabled(self):
        from tool_idempotency_hook import IdempotencyToolHook

        registry = MagicMock()
        IdempotencyToolHook(org_id="o", execution_id="", node_id="").register_hooks(registry)
        registry.add_callback.assert_not_called()

    def test_mode_resolver_failure_defaults_to_ledger(self):
        from tool_idempotency import MODE_LEDGER
        from tool_idempotency_hook import IdempotencyToolHook

        def boom(_name):
            raise ValueError("resolver blew up")

        hook = IdempotencyToolHook(
            org_id="o", execution_id="e", node_id="n", mode_resolver=boom
        )
        assert hook._resolve_mode("anyTool") == MODE_LEDGER  # fail-safe
