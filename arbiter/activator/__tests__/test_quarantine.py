"""Quarantine regression tests — US-ARB-010.

Two pieces of behaviour were investigated already and found in-place:
  1. `arbiter/fabricator/index.py` writes `'state': 'inactive'` when
     creating an agent-config record.
  2. `arbiter/supervisor/agent_config.py::load_config_from_dynamodb`
     filters for `state == 'active'` so quarantined agents are invisible
     to the supervisor until explicitly activated.

These tests are regression guards: they fail loudly if either behaviour
disappears. They also verify end-to-end that calling the activator flips
a quarantined agent so the supervisor then sees it.

Spec: arbiter-governance-engine/requirements.md Requirement 7.5–7.6.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Repo root = two levels up from __tests__/.
_REPO_ROOT = Path(__file__).resolve().parents[3]

# Add activator (for post-activation integration test) and supervisor
# (for load_config_from_dynamodb import) to sys.path.
sys.path.insert(0, str(_REPO_ROOT / "arbiter" / "activator"))
sys.path.insert(0, str(_REPO_ROOT / "arbiter" / "supervisor"))

os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-quarantine-table")


# ---------------------------------------------------------------------------
# 1. Regression: fabricator writes state='inactive' exactly once.
# ---------------------------------------------------------------------------
def test_fabricator_writes_state_inactive_exactly_once():
    """Guard against accidental removal of the quarantine default."""
    fabricator_src = (_REPO_ROOT / "arbiter" / "fabricator" / "index.py").read_text()
    # Accept either single or double quotes to be resilient to formatting.
    patterns = [
        re.compile(r"""['"]state['"]\s*:\s*['"]inactive['"]"""),
    ]
    total = 0
    for pat in patterns:
        total += len(pat.findall(fabricator_src))
    assert total == 1, (
        f"Expected exactly 1 `'state': 'inactive'` write in fabricator "
        f"index.py, found {total}. Quarantine default must not be removed "
        f"or duplicated (US-ARB-010)."
    )


# ---------------------------------------------------------------------------
# 2. Regression: supervisor filters on state == 'active'.
# ---------------------------------------------------------------------------
def test_supervisor_filters_on_state_active():
    """Guard against supervisor loading inactive agents."""
    supervisor_src = (
        _REPO_ROOT / "arbiter" / "supervisor" / "agent_config.py"
    ).read_text()
    # Must contain an equality check on state == 'active'. We allow
    # either == or != variations but require an 'active' string literal
    # checked against the `state` attribute.
    pattern = re.compile(
        r"""item\.get\(\s*['"]state['"]\s*\)\s*==\s*['"]active['"]"""
    )
    assert pattern.search(supervisor_src), (
        "supervisor/agent_config.py must filter agents on state == 'active'. "
        "Missing this filter would let inactive (quarantined) agents through "
        "to the supervisor (US-ARB-010)."
    )


# ---------------------------------------------------------------------------
# 3. Integration (mocked DDB): supervisor excludes state='inactive' rows.
# ---------------------------------------------------------------------------
def test_load_config_excludes_inactive_rows():
    import agent_config  # from arbiter/supervisor

    items = [
        {
            "agentId": "the-inactive-one",
            "state": "inactive",
            "config": {"name": "inactive-agent", "description": "x", "schema": {}},
        },
        {
            "agentId": "the-active-one",
            "state": "active",
            "config": {"name": "active-agent", "description": "y", "schema": {}},
        },
    ]

    mock_table = MagicMock()
    mock_table.scan.return_value = {"Items": items}

    with patch.object(agent_config, "dynamodb") as mock_dynamo:
        mock_dynamo.Table.return_value = mock_table
        result = agent_config.load_config_from_dynamodb()

    names = [cfg.get("name") for cfg in result["agents"]]
    assert names == ["active-agent"], (
        f"Supervisor must filter out inactive agents. Got: {names}"
    )


# ---------------------------------------------------------------------------
# 4. Post-activation: activator flips the inactive row → supervisor sees it.
# ---------------------------------------------------------------------------
def test_post_activation_both_rows_load():
    import agent_config  # from arbiter/supervisor
    import index as activator  # from arbiter/activator

    activator.__reset_clients_for_test()

    # In-memory store keyed by agentId; values are full rows.
    store = {
        "the-inactive-one": {
            "agentId": "the-inactive-one",
            "state": "inactive",
            "config": {"name": "inactive-agent", "description": "x", "schema": {}},
        },
        "the-active-one": {
            "agentId": "the-active-one",
            "state": "active",
            "config": {"name": "active-agent", "description": "y", "schema": {}},
        },
    }

    mock_table = MagicMock()

    def _scan(**_kwargs):
        return {"Items": list(store.values())}

    def _update_item(**kwargs):
        key = kwargs["Key"]["agentId"]
        if key not in store:
            from botocore.exceptions import ClientError
            raise ClientError(
                {"Error": {"Code": "ConditionalCheckFailedException"}},
                "UpdateItem",
            )
        values = kwargs["ExpressionAttributeValues"]
        store[key]["state"] = values[":s"]
        return {}

    mock_table.scan.side_effect = _scan
    mock_table.update_item.side_effect = _update_item

    # Sanity: before activation, supervisor sees only one agent.
    with patch.object(agent_config, "dynamodb") as mock_dynamo:
        mock_dynamo.Table.return_value = mock_table
        pre = agent_config.load_config_from_dynamodb()
    assert len(pre["agents"]) == 1

    # Invoke activator directly; patch the module-level table getter.
    with patch.object(activator, "_get_table", return_value=mock_table):
        result = activator.activate_agent("the-inactive-one", "admin")
    assert result["statusCode"] == 200
    assert store["the-inactive-one"]["state"] == "active"

    # Now supervisor sees both rows.
    with patch.object(agent_config, "dynamodb") as mock_dynamo:
        mock_dynamo.Table.return_value = mock_table
        post = agent_config.load_config_from_dynamodb()
    names = sorted(cfg.get("name") for cfg in post["agents"])
    assert names == ["active-agent", "inactive-agent"], (
        f"After activation both rows should be returned. Got: {names}"
    )
