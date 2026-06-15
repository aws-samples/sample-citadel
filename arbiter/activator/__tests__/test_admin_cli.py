"""Tests for arbiter/activator/admin_cli.py — US-ARB-018.

Covers:
  1. activate-agent publishes EventBridge event with action='activate'
  2. suspend-agent publishes action='suspend'
  3. Both print a correlationId in JSON output
  4. list-pending-activation filters state='inactive', sorts by createdAt
  5. activation-history found → exit 0, JSON on stdout
  6. activation-history not found → exit 1, message on stderr
  7. --actor flag propagates into event detail
  8. Property test — argparse is deterministic across inputs (100 iters)
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
from unittest.mock import MagicMock, patch

import pytest
from hypothesis import given, settings, strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-activator-cli-table")
os.environ.setdefault("EVENT_BUS_NAME", "fake-bus")

import admin_cli  # noqa: E402


UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)


@pytest.fixture(autouse=True)
def _reset_clients():
    admin_cli.__reset_clients_for_test()
    yield
    admin_cli.__reset_clients_for_test()


def _mock_events_client():
    mock = MagicMock()
    mock.put_events.return_value = {"FailedEntryCount": 0, "Entries": []}
    return mock


# ---------------------------------------------------------------------------
# 1. activate-agent publishes action='activate'
# ---------------------------------------------------------------------------
def test_activate_agent_publishes_activate_event(capsys):
    mock_events = _mock_events_client()
    with patch.object(admin_cli, "_get_events", return_value=mock_events):
        rc = admin_cli.main(["activate-agent", "agent-1"])

    assert rc == 0
    mock_events.put_events.assert_called_once()
    entries = mock_events.put_events.call_args.kwargs["Entries"]
    assert len(entries) == 1
    entry = entries[0]
    assert entry["Source"] == "agent.activate"
    assert entry["DetailType"] == "agent.activation.requested"
    detail = json.loads(entry["Detail"])
    assert detail["agentId"] == "agent-1"
    assert detail["action"] == "activate"


# ---------------------------------------------------------------------------
# 2. suspend-agent publishes action='suspend'
# ---------------------------------------------------------------------------
def test_suspend_agent_publishes_suspend_event(capsys):
    mock_events = _mock_events_client()
    with patch.object(admin_cli, "_get_events", return_value=mock_events):
        rc = admin_cli.main(["suspend-agent", "agent-2"])

    assert rc == 0
    entries = mock_events.put_events.call_args.kwargs["Entries"]
    detail = json.loads(entries[0]["Detail"])
    assert detail["action"] == "suspend"
    assert detail["agentId"] == "agent-2"


# ---------------------------------------------------------------------------
# 3. Both commands print a correlationId in JSON output
# ---------------------------------------------------------------------------
def test_activate_prints_correlation_id(capsys):
    mock_events = _mock_events_client()
    with patch.object(admin_cli, "_get_events", return_value=mock_events):
        admin_cli.main(["activate-agent", "agent-1"])

    stdout = capsys.readouterr().out.strip()
    payload = json.loads(stdout)
    assert payload["status"] == "queued"
    assert payload["action"] == "activate"
    assert UUID_RE.match(payload["correlationId"])


def test_suspend_prints_correlation_id(capsys):
    mock_events = _mock_events_client()
    with patch.object(admin_cli, "_get_events", return_value=mock_events):
        admin_cli.main(["suspend-agent", "agent-9"])

    stdout = capsys.readouterr().out.strip()
    payload = json.loads(stdout)
    assert payload["action"] == "suspend"
    assert UUID_RE.match(payload["correlationId"])


# ---------------------------------------------------------------------------
# 4. list-pending-activation filters state='inactive', sorts by createdAt
# ---------------------------------------------------------------------------
def test_list_pending_filters_and_sorts(capsys):
    items = [
        {"agentId": "a1", "state": "active", "createdAt": "2024-01-01"},
        {"agentId": "a2", "state": "inactive", "createdAt": "2024-03-01",
         "appId": "app-x", "ownerAlias": "owner-b"},
        {"agentId": "a3", "state": "suspended", "createdAt": "2024-02-01"},
        {"agentId": "a4", "state": "inactive", "createdAt": "2024-01-15",
         "appId": "app-y", "ownerAlias": "owner-a"},
    ]
    mock_table = MagicMock()
    mock_table.scan.return_value = {"Items": items}  # no LastEvaluatedKey
    mock_dynamo = MagicMock()
    mock_dynamo.Table.return_value = mock_table

    with patch.object(admin_cli, "_get_dynamodb", return_value=mock_dynamo):
        rc = admin_cli.main(["list-pending-activation"])

    assert rc == 0
    stdout = capsys.readouterr().out.strip().splitlines()
    # Only inactive rows should be printed — sorted by createdAt ascending.
    parsed = [json.loads(line) for line in stdout]
    assert len(parsed) == 2
    assert parsed[0]["agentId"] == "a4"  # createdAt 2024-01-15
    assert parsed[1]["agentId"] == "a2"  # createdAt 2024-03-01


def test_list_pending_paginates_scan(capsys):
    page1 = {
        "Items": [{"agentId": "x1", "state": "inactive", "createdAt": "2024-01-01"}],
        "LastEvaluatedKey": {"agentId": "x1"},
    }
    page2 = {
        "Items": [{"agentId": "x2", "state": "inactive", "createdAt": "2024-02-01"}]
    }
    mock_table = MagicMock()
    mock_table.scan.side_effect = [page1, page2]
    mock_dynamo = MagicMock()
    mock_dynamo.Table.return_value = mock_table

    with patch.object(admin_cli, "_get_dynamodb", return_value=mock_dynamo):
        rc = admin_cli.main(["list-pending-activation"])

    assert rc == 0
    assert mock_table.scan.call_count == 2
    lines = capsys.readouterr().out.strip().splitlines()
    assert len(lines) == 2


# ---------------------------------------------------------------------------
# 5. activation-history found → exit 0, JSON on stdout
# ---------------------------------------------------------------------------
def test_history_found_returns_0(capsys):
    item = {
        "agentId": "agent-42",
        "state": "active",
        "createdAt": "2024-01-01T00:00:00+00:00",
        "activatedAt": "2024-01-02T10:00:00+00:00",
        "activatedBy": "admin",
        "suspendedAt": None,
        "suspendedBy": None,
    }
    mock_table = MagicMock()
    mock_table.get_item.return_value = {"Item": item}
    mock_dynamo = MagicMock()
    mock_dynamo.Table.return_value = mock_table

    with patch.object(admin_cli, "_get_dynamodb", return_value=mock_dynamo):
        rc = admin_cli.main(["activation-history", "agent-42"])

    assert rc == 0
    stdout = capsys.readouterr().out.strip()
    parsed = json.loads(stdout)
    assert parsed["agentId"] == "agent-42"
    assert parsed["state"] == "active"
    assert parsed["activatedBy"] == "admin"


# ---------------------------------------------------------------------------
# 6. activation-history not found → exit 1, stderr message
# ---------------------------------------------------------------------------
def test_history_not_found_returns_1(capsys):
    mock_table = MagicMock()
    mock_table.get_item.return_value = {}  # no 'Item' key
    mock_dynamo = MagicMock()
    mock_dynamo.Table.return_value = mock_table

    with patch.object(admin_cli, "_get_dynamodb", return_value=mock_dynamo):
        rc = admin_cli.main(["activation-history", "ghost-agent"])

    assert rc == 1
    captured = capsys.readouterr()
    assert "Agent not found" in captured.err
    assert "ghost-agent" in captured.err


# ---------------------------------------------------------------------------
# 7. --actor flag propagates into the event detail
# ---------------------------------------------------------------------------
def test_actor_flag_propagates_to_event():
    mock_events = _mock_events_client()
    with patch.object(admin_cli, "_get_events", return_value=mock_events):
        admin_cli.main(["--actor", "alice@corp.com", "activate-agent", "agent-77"])

    entries = mock_events.put_events.call_args.kwargs["Entries"]
    detail = json.loads(entries[0]["Detail"])
    assert detail["actor"] == "alice@corp.com"


def test_actor_flag_defaults_to_cli():
    mock_events = _mock_events_client()
    with patch.dict(os.environ, {}, clear=False):
        os.environ.pop("CLI_ACTOR", None)
        with patch.object(admin_cli, "_get_events", return_value=mock_events):
            admin_cli.main(["activate-agent", "agent-77"])

    entries = mock_events.put_events.call_args.kwargs["Entries"]
    detail = json.loads(entries[0]["Detail"])
    assert detail["actor"] == "cli"


# ---------------------------------------------------------------------------
# 8. Property test: argparse parses any combination of flags deterministically.
# ---------------------------------------------------------------------------
# Hypothesis generates random agent-id strings and random actor strings,
# builds argv lists covering every subcommand, and asserts that:
#   * build_parser() produces the same parsed Namespace across repeated
#     calls with the same argv (no hidden state leakage),
#   * --actor propagates deterministically.
#
# Only values that argparse considers safe (no leading dashes, non-empty)
# are generated for positional args.
# ---------------------------------------------------------------------------
safe_id_chars = st.text(
    alphabet=st.characters(whitelist_categories=("L", "N"), whitelist_characters="-_"),
    min_size=1,
    max_size=30,
).filter(lambda s: not s.startswith("-"))


@given(
    subcommand=st.sampled_from(["activate-agent", "suspend-agent", "activation-history"]),
    agent_id=safe_id_chars,
    actor=safe_id_chars,
)
@settings(max_examples=100, deadline=None)
def test_parser_is_deterministic(subcommand, agent_id, actor):
    # Build argv twice and make sure the Namespace is identical.
    argv = ["--actor", actor, subcommand, agent_id]
    ns1 = admin_cli.build_parser().parse_args(argv)
    ns2 = admin_cli.build_parser().parse_args(argv)
    assert ns1.actor == ns2.actor == actor
    assert ns1.command == ns2.command == subcommand
    assert ns1.agent_id == ns2.agent_id == agent_id


@given(actor=safe_id_chars)
@settings(max_examples=20, deadline=None)
def test_list_pending_parser_has_no_agent_id(actor):
    argv = ["--actor", actor, "list-pending-activation"]
    ns = admin_cli.build_parser().parse_args(argv)
    assert ns.command == "list-pending-activation"
    assert ns.actor == actor
    assert not hasattr(ns, "agent_id") or ns.agent_id is None or ns.agent_id == ""
