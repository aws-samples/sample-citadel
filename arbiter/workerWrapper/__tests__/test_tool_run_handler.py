"""RED-phase tests for the governed single-tool-run request path.

Board task 10c3bf48 (Slice 1), architect design decision 84107e22.

Covers:
- ``_is_tool_run_message`` discriminator.
- ``invoke_binding`` (Slice 0 shared primitive) dispatch on lambda/http/mcp/
  aws-service, plus the structured UNSUPPORTED_BINDING error for anything
  else.
- ``_resolve_tool_credential_mode`` fail-closed 'scoped' default / explicit
  'none' sentinel (mirrors index.py's ``_resolve_credential_mode`` for
  agents).
- ``_process_tool_run`` end to end: governance deny, idempotent replay of
  the same runId, org mismatch (tenant_guard), per-binding dispatch with
  scoped creds, unsupported binding, and credentialMode='none' runs without
  invoking the credential vender.
"""
from __future__ import annotations

import sys
import os
import importlib
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import tool_run_handler as trh  # noqa: E402


@pytest.fixture(autouse=True)
def _reload_module():
    """Reload the module under test between tests so module-level caches
    (none expected, but defensive) never leak."""
    importlib.reload(trh)
    yield


# ---------------------------------------------------------------------------
# _is_tool_run_message
# ---------------------------------------------------------------------------

class TestIsToolRunMessage:
    def test_true_for_kind_tool_run(self):
        assert trh.is_tool_run_message({"kind": "tool-run", "toolId": "t1"}) is True

    def test_false_for_absent_kind(self):
        assert trh.is_tool_run_message({"orchestration_id": "x"}) is False

    def test_false_for_other_kind(self):
        assert trh.is_tool_run_message({"kind": "workflow-node"}) is False

    def test_false_for_non_dict(self):
        assert trh.is_tool_run_message(None) is False
        assert trh.is_tool_run_message("tool-run") is False


# ---------------------------------------------------------------------------
# resolve_binding_type
# ---------------------------------------------------------------------------

class TestResolveBindingType:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("lambda", "lambda"),
            ("http", "http"),
            ("mcp", "mcp"),
            ("mcp_server", "mcp"),
            ("agentcore_mcp", "mcp"),
            ("external_mcp", "mcp"),
            ("aws-service", "aws-service"),
            ("aws_service", "aws-service"),
        ],
    )
    def test_known_types_normalise(self, raw, expected):
        assert trh.resolve_binding_type({"integrationType": raw}) == expected

    def test_unknown_type_returns_none(self):
        assert trh.resolve_binding_type({"integrationType": "a2a"}) is None

    def test_absent_binding_returns_none(self):
        assert trh.resolve_binding_type(None) is None
        assert trh.resolve_binding_type({}) is None


# ---------------------------------------------------------------------------
# invoke_binding — Slice 0 shared primitive
# ---------------------------------------------------------------------------

class TestInvokeBinding:
    def test_lambda_binding_dispatches_to_lambda_executor(self):
        executor = MagicMock(return_value={"ok": True})
        with patch.object(trh, "_EXECUTORS", {"lambda": executor}):
            result = trh.invoke_binding(
                "lambda", {"functionArn": "arn:aws:lambda:..:fn"}, {"x": 1}, {"accessKeyId": "a"},
            )
        assert result == {"ok": True}
        executor.assert_called_once_with(
            {"functionArn": "arn:aws:lambda:..:fn"}, {"x": 1}, {"accessKeyId": "a"},
        )

    def test_http_binding_dispatches_to_http_executor(self):
        executor = MagicMock(return_value={"status": 200})
        with patch.object(trh, "_EXECUTORS", {"http": executor}):
            result = trh.invoke_binding("http", {"url": "https://x"}, {}, None)
        assert result == {"status": 200}

    def test_mcp_binding_dispatches_to_mcp_executor(self):
        executor = MagicMock(return_value={"content": []})
        with patch.object(trh, "_EXECUTORS", {"mcp": executor}):
            result = trh.invoke_binding("mcp", {"serverUrl": "https://mcp"}, {}, None)
        assert result == {"content": []}

    def test_aws_service_binding_dispatches_to_aws_service_executor(self):
        executor = MagicMock(return_value={"ResponseMetadata": {}})
        with patch.object(trh, "_EXECUTORS", {"aws-service": executor}):
            result = trh.invoke_binding("aws-service", {"service": "s3"}, {}, {"accessKeyId": "a"})
        assert result == {"ResponseMetadata": {}}

    def test_unsupported_binding_raises_structured_error(self):
        with pytest.raises(trh.UnsupportedBindingError) as exc_info:
            trh.invoke_binding("a2a", {}, {}, None)
        assert exc_info.value.binding_type == "a2a"

    def test_none_binding_type_raises_unsupported(self):
        with pytest.raises(trh.UnsupportedBindingError):
            trh.invoke_binding(None, {}, {}, None)


# ---------------------------------------------------------------------------
# _resolve_tool_credential_mode
# ---------------------------------------------------------------------------

class TestResolveToolCredentialMode:
    def test_explicit_none_sentinel_on_tool_config(self):
        assert trh.resolve_tool_credential_mode({"credentialMode": "none"}) == "none"

    def test_default_is_scoped(self):
        assert trh.resolve_tool_credential_mode({"integrationBindings": []}) == "scoped"

    def test_absent_config_defaults_scoped(self):
        assert trh.resolve_tool_credential_mode({}) == "scoped"


# ---------------------------------------------------------------------------
# _process_tool_run — integration-style unit tests with mocked collaborators
# ---------------------------------------------------------------------------

def _base_event(**overrides):
    event = {
        "kind": "tool-run",
        "toolId": "echo-tool",
        "inputs": {"msg": "hi"},
        "orgId": "org-a",
        "runId": "run-123",
        "caller": {"userId": "u1", "roles": ["architect"]},
    }
    event.update(overrides)
    return event


class TestProcessToolRun:
    def _tool_config(self, **overrides):
        cfg = {
            "toolId": "echo-tool",
            "orgId": "org-a",
            "integrationBindings": [{"integrationId": "int-1", "integrationType": "lambda"}],
        }
        cfg.update(overrides)
        return cfg

    def test_governance_deny_short_circuits_before_execute(self):
        executor = MagicMock()
        with (
            patch.object(trh, "_load_tool_config", return_value=self._tool_config()),
            patch.object(trh, "record_governance_decision", return_value=(True, {"error": "denied"})),
            patch.object(trh, "_EXECUTORS", {"lambda": executor}),
        ):
            result = trh.process_tool_run(_base_event())
        assert result["status"] == "error"
        assert result["error"]["code"] == "GOVERNANCE_DENIED"
        executor.assert_not_called()

    def test_org_mismatch_refused_before_execute(self):
        executor = MagicMock()
        with (
            patch.object(trh, "_load_tool_config", return_value=self._tool_config(orgId="org-b")),
            patch.object(trh, "_EXECUTORS", {"lambda": executor}),
        ):
            result = trh.process_tool_run(_base_event(orgId="org-a"))
        assert result["status"] == "error"
        assert result["error"]["code"] == "TOOL_NOT_FOUND"
        executor.assert_not_called()

    def test_tool_not_found(self):
        with patch.object(trh, "_load_tool_config", return_value=None):
            result = trh.process_tool_run(_base_event())
        assert result["status"] == "error"
        assert result["error"]["code"] == "TOOL_NOT_FOUND"

    def test_unsupported_binding_returns_structured_error(self):
        cfg = self._tool_config(
            integrationBindings=[{"integrationId": "i1", "integrationType": "a2a"}],
        )
        with (
            patch.object(trh, "_load_tool_config", return_value=cfg),
            patch.object(trh, "record_governance_decision", return_value=(False, None)),
        ):
            result = trh.process_tool_run(_base_event())
        assert result["status"] == "error"
        assert result["error"]["code"] == "UNSUPPORTED_BINDING"

    def test_credential_mode_none_runs_without_vending(self):
        cfg = self._tool_config(credentialMode="none")
        executor = MagicMock(return_value={"out": 1})
        vend = MagicMock()
        with (
            patch.object(trh, "_load_tool_config", return_value=cfg),
            patch.object(trh, "record_governance_decision", return_value=(False, None)),
            patch.object(trh, "_EXECUTORS", {"lambda": executor}),
            patch.object(trh, "_vend_scoped_credentials", vend),
            patch.object(trh, "execute_idempotent", side_effect=lambda **kw: kw["run_tool"]()),
        ):
            result = trh.process_tool_run(_base_event())
        assert result["status"] == "success"
        assert result["output"] == {"out": 1}
        vend.assert_not_called()
        executor.assert_called_once()
        # credentials arg passed to the executor must be None for 'none' mode
        assert executor.call_args.args[2] is None

    def test_scoped_credential_mode_vends_before_execute(self):
        cfg = self._tool_config()
        executor = MagicMock(return_value={"out": 2})
        vend = MagicMock(return_value={"accessKeyId": "a", "secretAccessKey": "s", "sessionToken": "t"})
        with (
            patch.object(trh, "_load_tool_config", return_value=cfg),
            patch.object(trh, "record_governance_decision", return_value=(False, None)),
            patch.object(trh, "_EXECUTORS", {"lambda": executor}),
            patch.object(trh, "_vend_scoped_credentials", vend),
            patch.object(trh, "execute_idempotent", side_effect=lambda **kw: kw["run_tool"]()),
        ):
            result = trh.process_tool_run(_base_event())
        assert result["status"] == "success"
        vend.assert_called_once()
        creds_arg = executor.call_args.args[2]
        assert creds_arg == {"accessKeyId": "a", "secretAccessKey": "s", "sessionToken": "t"}

    def test_credential_vend_failure_returns_structured_error(self):
        cfg = self._tool_config()
        with (
            patch.object(trh, "_load_tool_config", return_value=cfg),
            patch.object(trh, "record_governance_decision", return_value=(False, None)),
            patch.object(trh, "_vend_scoped_credentials", side_effect=trh.CredentialVendError("boom")),
        ):
            result = trh.process_tool_run(_base_event())
        assert result["status"] == "error"
        assert result["error"]["code"] == "CREDENTIAL_VEND_FAILED"

    def test_idempotent_replay_of_same_run_id_does_not_reexecute(self):
        """execute_idempotent is the ledger seam; verify process_tool_run
        passes runId as the idempotency key and does not itself re-derive
        or bypass the seam — it must delegate every call to
        execute_idempotent."""
        cfg = self._tool_config()
        executor = MagicMock(return_value={"out": 3})
        idem = MagicMock(return_value={"out": "replayed"})
        with (
            patch.object(trh, "_load_tool_config", return_value=cfg),
            patch.object(trh, "record_governance_decision", return_value=(False, None)),
            patch.object(trh, "_EXECUTORS", {"lambda": executor}),
            patch.object(trh, "_vend_scoped_credentials", return_value={"accessKeyId": "a", "secretAccessKey": "s", "sessionToken": "t"}),
            patch.object(trh, "execute_idempotent", idem),
        ):
            result = trh.process_tool_run(_base_event(runId="run-999"))
        assert result["output"] == {"out": "replayed"}
        _, kwargs = idem.call_args
        assert kwargs["sk"].startswith("tool-run#0#echo-tool#")
        assert kwargs["pk"] == "org-a#run-999"
        executor.assert_not_called()  # idempotency coordinator owns execution

    def test_each_binding_type_dispatched_with_mocked_executor(self):
        for binding_type in ("lambda", "http", "mcp", "aws-service"):
            cfg = self._tool_config(
                integrationBindings=[{"integrationId": "i1", "integrationType": binding_type}],
            )
            executor = MagicMock(return_value={"binding": binding_type})
            with (
                patch.object(trh, "_load_tool_config", return_value=cfg),
                patch.object(trh, "record_governance_decision", return_value=(False, None)),
                patch.object(trh, "_EXECUTORS", {binding_type: executor}),
                patch.object(trh, "_vend_scoped_credentials", return_value={"accessKeyId": "a", "secretAccessKey": "s", "sessionToken": "t"}),
                patch.object(trh, "execute_idempotent", side_effect=lambda **kw: kw["run_tool"]()),
            ):
                result = trh.process_tool_run(_base_event())
            assert result["status"] == "success", binding_type
            assert result["output"] == {"binding": binding_type}

    def test_result_shape_has_runid_status_duration(self):
        cfg = self._tool_config()
        with (
            patch.object(trh, "_load_tool_config", return_value=cfg),
            patch.object(trh, "record_governance_decision", return_value=(False, None)),
            patch.object(trh, "_EXECUTORS", {"lambda": MagicMock(return_value={"ok": 1})}),
            patch.object(trh, "_vend_scoped_credentials", return_value={"accessKeyId": "a", "secretAccessKey": "s", "sessionToken": "t"}),
            patch.object(trh, "execute_idempotent", side_effect=lambda **kw: kw["run_tool"]()),
        ):
            result = trh.process_tool_run(_base_event(runId="run-xyz"))
        assert result["runId"] == "run-xyz"
        assert result["status"] == "success"
        assert isinstance(result["durationMs"], int)
        assert "error" not in result or result.get("error") is None
