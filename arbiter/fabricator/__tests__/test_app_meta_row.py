"""
Tests for arbiter/fabricator/index.py _write_app_meta_row's org_id handling
(finding 10a12ba4).

orgId is the AppsTable OrgIndex GSI partition key (backend-stack.ts). An
empty-string org_id produces a GUARANTEED ValidationException on every
attempt -- it is not a transient/eventually-consistent failure, and the
scheduled reconciler (backend/scripts/reconcile-apps-meta.ts) cannot recover
it either, since its own orgId projection is read from the same Registry
record this function stamped from org_id. _write_app_meta_row must skip the
write explicitly (INFO log) rather than attempt it and swallow a guaranteed
exception, and must never call update_item in that case.
"""

import sys
import os
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("TOOL_CONFIG_TABLE", "fake-tool-table")
os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("AGENT_BUCKET_NAME", "fake-bucket")
os.environ.setdefault("COMPLETION_BUS_NAME", "fake-bus")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/queue")

import index


class TestWriteAppMetaRowOrgIdEmpty:
    def setup_method(self):
        self._prior_apps_table = os.environ.get("APPS_TABLE")
        os.environ["APPS_TABLE"] = "citadel-apps-test"

    def teardown_method(self):
        if self._prior_apps_table is None:
            os.environ.pop("APPS_TABLE", None)
        else:
            os.environ["APPS_TABLE"] = self._prior_apps_table

    def test_org_id_empty_string_skips_write_returns_false(self):
        mock_client = MagicMock()
        with patch.object(index.boto3, "client", return_value=mock_client):
            result = index._write_app_meta_row(
                record_id="rec-123",
                agent_id="my-agent",
                agent_description="desc",
                requested_by="fabricator",
                org_id="",
            )
        assert result is False
        mock_client.update_item.assert_not_called()

    def test_org_id_none_skips_write_returns_false(self):
        # org_id is typed str but callers may pass through a falsy value;
        # the guard must be a truthiness check, not an `is not None` check.
        mock_client = MagicMock()
        with patch.object(index.boto3, "client", return_value=mock_client):
            result = index._write_app_meta_row(
                record_id="rec-123",
                agent_id="my-agent",
                agent_description="desc",
                requested_by="fabricator",
                org_id=None,
            )
        assert result is False
        mock_client.update_item.assert_not_called()

    def test_org_id_empty_never_reaches_the_swallowed_exception_path(self):
        # Bite: if the guard were removed, update_item would be called and
        # (on the real service) raise ValidationException, which the except
        # block swallows and logs as "eventually-consistent, reconciler will
        # recover". With the guard, update_item must never even be attempted
        # for an empty org_id.
        #
        # Note: the AssertionError raised by the mock's side_effect would
        # itself be caught by _write_app_meta_row's broad except (the same
        # swallow path exercised by test_org_id_populated_but_update_item_
        # raises_still_swallowed below) and would NOT propagate to this test
        # -- it would instead surface as a `result is False` return, making
        # this assertion pass even if the guard were missing. The `assert_
        # not_called` in the populated-guard tests above is the real bite;
        # this test only documents intent and must not be relied on alone.
        mock_client = MagicMock()
        mock_client.update_item.side_effect = AssertionError(
            "update_item must not be called when org_id is empty"
        )
        with patch.object(index.boto3, "client", return_value=mock_client):
            result = index._write_app_meta_row(
                record_id="rec-123",
                agent_id="my-agent",
                agent_description="desc",
                requested_by="fabricator",
                org_id="",
            )
        assert result is False
        mock_client.update_item.assert_not_called()

    def test_org_id_populated_path_unchanged_writes_update_item(self):
        mock_client = MagicMock()
        with patch.object(index.boto3, "client", return_value=mock_client):
            result = index._write_app_meta_row(
                record_id="rec-123",
                agent_id="my-agent",
                agent_description="desc",
                requested_by="fabricator",
                org_id="org-abc",
            )
        assert result is True
        mock_client.update_item.assert_called_once()
        kwargs = mock_client.update_item.call_args.kwargs
        assert kwargs["TableName"] == "citadel-apps-test"
        assert kwargs["Key"] == {"appId": {"S": "rec-123"}}
        assert kwargs["ExpressionAttributeValues"][":orgId"] == {"S": "org-abc"}

    def test_org_id_populated_but_update_item_raises_still_swallowed(self):
        # Genuinely transient failure on a non-empty org_id: existing
        # eventually-consistent swallow behavior must be unchanged.
        mock_client = MagicMock()
        mock_client.update_item.side_effect = Exception("ddb throttled")
        with patch.object(index.boto3, "client", return_value=mock_client):
            result = index._write_app_meta_row(
                record_id="rec-123",
                agent_id="my-agent",
                agent_description="desc",
                requested_by="fabricator",
                org_id="org-abc",
            )
        assert result is False
        mock_client.update_item.assert_called_once()

    def test_apps_table_unset_still_skips_before_org_id_check(self):
        os.environ.pop("APPS_TABLE", None)
        mock_client = MagicMock()
        with patch.object(index.boto3, "client", return_value=mock_client):
            result = index._write_app_meta_row(
                record_id="rec-123",
                agent_id="my-agent",
                agent_description="desc",
                requested_by="fabricator",
                org_id="org-abc",
            )
        assert result is False
        mock_client.update_item.assert_not_called()
