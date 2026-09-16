"""Wave 2b (branch fix/vender-org-scoping) — workerWrapper forwards orgId
from the Supervisor dispatch payload to the credential vender.

The Supervisor's ``process_agent_call`` dispatch payload already carries a
server-derived, non-empty ``orgId`` (see supervisor/index.py ~L1024). This
slice makes ``process_event`` read that field off the SQS event and forward
it as ``org`` on the credential-vender invoke payload built by
``get_scoped_credentials``. Fail CLOSED — no credential request at all,
plus a clear log — when the dispatch payload lacks orgId, rather than
silently vending without an org (which is exactly the gap wave 2b closes).
"""

import sys
import os
import json
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("CREDENTIAL_VENDER_FUNCTION", "fake-vender-fn")

import index  # noqa: E402


def _base_agent_config():
    return {
        "config": json.dumps({
            "tools": [],
            "filename": "agent.zip",
            "description": "test agent",
            "requiredPermissions": {"dataStores": ["ds-1"]},
        })
    }


def _run_process_event(event, agent_config=None):
    agent_config = agent_config or _base_agent_config()
    with patch.object(index, "load_config_from_dynamodb", return_value=agent_config), \
         patch.object(index, "load_file_from_s3_into_tmp"), \
         patch.object(index, "run_agent_in_subprocess", return_value="ok"), \
         patch.object(index, "post_task_complete"), \
         patch.object(index, "CREDENTIAL_VENDER_FUNCTION", "fake-vender-fn"), \
         patch.object(index, "TOOLS_CONFIG_TABLE", None):
        index.process_event(event, {})


class TestOrgIdForwardedToVender:
    def test_org_id_forwarded_on_vender_invoke_payload(self):
        event = {
            "orchestration_id": "orch-1",
            "agent_use_id": "use-1",
            "agent_input": {"x": 1},
            "node": "agent1",
            "orgId": "org-abc",
        }
        mock_lambda_client = MagicMock()
        mock_lambda_client.invoke.return_value = {
            "Payload": MagicMock(read=lambda: json.dumps({"credentials": {}}).encode())
        }
        with patch.object(index, "_get_lambda_client", return_value=mock_lambda_client):
            _run_process_event(event)

        assert mock_lambda_client.invoke.called
        payload = json.loads(mock_lambda_client.invoke.call_args.kwargs["Payload"])
        assert payload["org"] == "org-abc"

    def test_missing_org_id_fails_closed_no_vender_call(self):
        """No orgId on the dispatch payload -> get_scoped_credentials must
        refuse to invoke the vender at all (fail closed), not silently vend
        org-less credentials."""
        event = {
            "orchestration_id": "orch-2",
            "agent_use_id": "use-2",
            "agent_input": {"x": 1},
            "node": "agent1",
        }
        mock_lambda_client = MagicMock()
        with patch.object(index, "_get_lambda_client", return_value=mock_lambda_client):
            _run_process_event(event)

        assert not mock_lambda_client.invoke.called

    def test_empty_string_org_id_fails_closed(self):
        event = {
            "orchestration_id": "orch-3",
            "agent_use_id": "use-3",
            "agent_input": {"x": 1},
            "node": "agent1",
            "orgId": "",
        }
        mock_lambda_client = MagicMock()
        with patch.object(index, "_get_lambda_client", return_value=mock_lambda_client):
            _run_process_event(event)

        assert not mock_lambda_client.invoke.called
