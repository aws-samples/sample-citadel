"""Registry-record seeding tests for arbiter/seedConfig/index.py.

The out-of-box demo flow gates app publish on the demo agent's BINDING
flipping DESIGN -> READY. updateAgentBinding (backend/src/lambda/
registry-agent-record-resolver.ts) resolves the target agent BY NAME in the
AgentCore Registry and requires the record's descriptor ``state`` to be
'active'. The seed therefore must ALSO create a Registry record for
``demo-echo-agent`` — mirroring the fabricator's store_agent_config_registry
payload shape (arbiter/fabricator/index.py) — while keeping the existing DDB
row for worker dispatch.

Contract under test:
  - When REGISTRY_ID + REGISTRY_ENABLED are present, the handler creates
    Registry records for both 'fabricator' and 'demo-echo-agent' via
    CreateRegistryRecord with the fabricator-shaped CUSTOM descriptor
    (categories/icon/state/manifest/config/createdBy/orgId), state 'active',
    config.filename pointing at the S3 module key, and a non-empty description.
  - Like the fabricator, records are left in their post-create DRAFT state —
    no UpdateRegistryRecordStatus / SubmitRegistryRecordForApproval calls.
  - IDEMPOTENT: when a record with the same name already exists (lookup first),
    CreateRegistryRecord is skipped.
  - Registry linkage fields (registryStatus, registryRecordId, createdAt)
    are stamped on the DDB items when registry resolves successfully.
  - When registry is unavailable/denied, linkage fields are ABSENT.
  - Skipped entirely (no registry API calls) when the registry env vars are
    absent, and when catalog.registry_client is unavailable (DDB-only envs).
  - DDB row seeding is unchanged in all cases.
"""

import sys
import os
import json
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("AGENT_CONFIG_TABLE", "fake-agent-table")
os.environ.setdefault("WORKER_QUEUE_URL", "https://sqs.fake/worker")
os.environ.setdefault("FABRICATOR_QUEUE_URL", "https://sqs.fake/fabricator")
os.environ.setdefault("AUTHORITY_UNITS_TABLE", "fake-authority-units-table")
os.environ.setdefault(
    "CONSTITUTIONAL_LAYERS_TABLE", "fake-constitutional-layers-table"
)

from index import handler  # noqa: E402

REGISTRY_ID = "fake-registry-id"
WORKER_QUEUE_URL = os.environ["WORKER_QUEUE_URL"]


def _cfn_event(request_type="Create"):
    return {
        "RequestType": request_type,
        "ResponseURL": "https://cfn-response.example.com/callback",
        "StackId": "arn:aws:cloudformation:us-east-1:123456789012:stack/s",
        "RequestId": "req-1",
        "LogicalResourceId": "SeedAgentConfigResource",
    }


def _ctx():
    return type("Ctx", (), {"log_stream_name": "stream"})()


def _make_registry_client(record_id="abc123def456", created_at="2026-09-29T00:00:00Z"):
    client = MagicMock(name="agent-registry-control-mock")
    client.create_registry_record.return_value = {
        "recordArn": (
            "arn:aws:agent-registry:us-west-2:123456789012:"
            f"registry/reg/record/{record_id}"
        ),
        "recordId": record_id,
        "status": "DRAFT",
        "createdAt": created_at,
    }
    return client


def _run_handler(registry_env, existing_records, registry_client,
                 post_approve_status="APPROVED"):
    """Invoke the Create handler with mocked boto3 + catalog lookup.

    The list_agent_records mock dynamically reflects creates and approvals
    that happen during the handler run: initially returns *existing_records*;
    once ``create_registry_record`` is called for an agent, subsequent list
    calls include that agent with DRAFT status; once
    ``submit_registry_record_for_approval`` is called, the record moves to
    *post_approve_status*.

    Returns (mock_table, mock_boto3, mock_send, list_mock).
    """
    mock_table = MagicMock()
    mock_dynamodb = MagicMock()
    mock_dynamodb.Table.return_value = mock_table

    # Track dynamically created/approved records
    created = {}  # name -> record dict
    approved = set()  # names that have been submitted

    orig_create = registry_client.create_registry_record
    orig_submit = registry_client.submit_registry_record_for_approval

    def _create_side_effect(**kwargs):
        result = orig_create.return_value
        if orig_create.side_effect and orig_create.side_effect is not _create_side_effect:
            result = orig_create.side_effect(**kwargs)
        name = kwargs.get("name", "")
        rid = (result or {}).get("recordId") or f"created-{name}"
        created[name] = {
            "recordId": rid,
            "name": name,
            "status": (result or {}).get("status", "DRAFT"),
            "createdAt": (result or {}).get("createdAt", "2026-09-29T00:00:00Z"),
        }
        return result

    def _submit_side_effect(**kwargs):
        result = orig_submit.return_value
        rid = kwargs.get("recordId", "")
        # Check dynamically created records
        for name, rec in created.items():
            if rec["recordId"] == rid:
                approved.add(name)
                rec["status"] = post_approve_status
        # Check pre-existing records too
        for rec in existing_records:
            if isinstance(rec, dict) and rec.get("recordId") == rid:
                approved.add(rec.get("name", ""))
                rec["status"] = post_approve_status
        return result

    registry_client.create_registry_record.side_effect = _create_side_effect
    registry_client.submit_registry_record_for_approval.side_effect = _submit_side_effect

    def _client_factory(service_name, *args, **kwargs):
        if service_name == "agent-registry-control":
            return registry_client
        return MagicMock(name=f"{service_name}-mock")

    env_patch = dict(os.environ)
    env_patch.pop("REGISTRY_ID", None)
    env_patch.pop("REGISTRY_ENABLED", None)
    if registry_env:
        env_patch["REGISTRY_ID"] = REGISTRY_ID
        env_patch["REGISTRY_ENABLED"] = "true"

    def _list_side_effect(rid):
        # Combine existing_records with dynamically created records
        result = list(existing_records)
        for name, rec in created.items():
            # Don't duplicate if already in existing
            if not any(r.get("name") == name for r in existing_records):
                result.append(dict(rec))
        return result

    list_mock = MagicMock(side_effect=_list_side_effect)

    with patch.dict(os.environ, env_patch, clear=True), \
         patch("index.boto3") as mock_boto3, \
         patch("index._SETTLE_SLEEP", 0), \
         patch("catalog.registry_client.list_agent_records", list_mock), \
         patch("cfnresponse.send") as mock_send:
        mock_boto3.resource.return_value = mock_dynamodb
        mock_boto3.client.side_effect = _client_factory
        handler(_cfn_event(), _ctx())

    return mock_table, mock_boto3, mock_send, list_mock


class TestRegistryRecordCreated:
    def test_creates_records_for_fabricator_and_echo(self):
        client = _make_registry_client()
        _, _, mock_send, list_mock = _run_handler(
            registry_env=True, existing_records=[],
            registry_client=client,
        )

        assert mock_send.call_args[0][2] == "SUCCESS"
        # create called for both fabricator and echo
        assert client.create_registry_record.call_count == 2
        created_names = [
            c.kwargs["name"]
            for c in client.create_registry_record.call_args_list
        ]
        assert "fabricator" in created_names
        assert "demo-echo-agent" in created_names

    def test_echo_record_has_fabricator_shaped_payload(self):
        client = _make_registry_client()
        _run_handler(
            registry_env=True, existing_records=[],
            registry_client=client,
        )
        # Find the echo-agent create call
        echo_call = [
            c for c in client.create_registry_record.call_args_list
            if c.kwargs["name"] == "demo-echo-agent"
        ]
        assert len(echo_call) == 1
        kwargs = echo_call[0].kwargs

        assert kwargs["registryId"] == REGISTRY_ID
        assert kwargs["displayName"] == "demo-echo-agent"
        assert isinstance(kwargs["description"], str) and kwargs["description"]
        assert kwargs["recordType"] == "CUSTOM"

        metadata = json.loads(kwargs["descriptors"]["custom"]["data"])
        for field in (
            "categories", "icon", "state", "manifest", "config",
            "createdBy", "orgId",
        ):
            assert field in metadata, f"missing descriptor field: {field}"
        assert metadata["state"] == "active"
        assert metadata["config"]["name"] == "demo-echo-agent"
        assert metadata["config"]["filename"] == "demo_echo_agent.py"
        assert metadata["config"]["action"] == {
            "type": "sqs",
            "target": WORKER_QUEUE_URL,
        }
        assert metadata["manifest"]["name"] == "demo-echo-agent"
        assert metadata["manifest"]["description"] == kwargs["description"]

    def test_system_agents_submitted_for_approval_after_create(self):
        """System agents (fabricator, demo-echo-agent) are submitted for
        approval so they're dispatchable immediately."""
        client = _make_registry_client()
        _run_handler(
            registry_env=True, existing_records=[], registry_client=client
        )
        assert client.submit_registry_record_for_approval.call_count == 2

    def test_ddb_seeding_unchanged_when_registry_configured(self):
        client = _make_registry_client()
        mock_table, _, _, _ = _run_handler(
            registry_env=True, existing_records=[],
            registry_client=client,
        )
        assert mock_table.put_item.call_count == 5
        items = [c.kwargs["Item"] for c in mock_table.put_item.call_args_list]
        echo = [i for i in items if i.get("agentId") == "demo-echo-agent"]
        assert len(echo) == 1
        assert echo[0]["state"] == "active"
        assert echo[0]["config"]["filename"] == "demo_echo_agent.py"


class TestRegistryLinkageStamped:
    """Verify that resolved registry records stamp linkage fields on DDB items."""

    def test_echo_agent_carries_linkage_fields(self):
        client = _make_registry_client(
            record_id="echo-rec-001", created_at="2026-09-29T12:00:00Z"
        )
        mock_table, _, _, _ = _run_handler(
            registry_env=True, existing_records=[],
            registry_client=client,
        )
        items = [c.kwargs["Item"] for c in mock_table.put_item.call_args_list]
        echo = [i for i in items if i.get("agentId") == "demo-echo-agent"][0]
        assert echo["registryStatus"] == "APPROVED"
        assert echo["registryRecordId"] == "echo-rec-001"
        assert echo["createdAt"] == "2026-09-29T12:00:00Z"

    def test_fabricator_carries_linkage_fields(self):
        client = _make_registry_client(
            record_id="fab-rec-001", created_at="2026-09-29T12:00:00Z"
        )
        mock_table, _, _, _ = _run_handler(
            registry_env=True, existing_records=[],
            registry_client=client,
        )
        items = [c.kwargs["Item"] for c in mock_table.put_item.call_args_list]
        fab = [i for i in items if i.get("agentId") == "fabricator"][0]
        assert fab["registryStatus"] == "APPROVED"
        assert fab["registryRecordId"] == "fab-rec-001"
        assert fab["createdAt"] == "2026-09-29T12:00:00Z"

    def test_linkage_from_existing_approved_record(self):
        """When a record already exists as APPROVED, stamp that status."""
        client = _make_registry_client()
        existing = [
            {"recordId": "approved-001", "name": "demo-echo-agent",
             "status": "APPROVED", "createdAt": "2026-01-01T00:00:00Z"},
            {"recordId": "approved-002", "name": "fabricator",
             "status": "APPROVED", "createdAt": "2026-01-01T00:00:00Z"},
        ]
        mock_table, _, _, _ = _run_handler(
            registry_env=True, existing_records=existing,
            registry_client=client,
        )
        items = [c.kwargs["Item"] for c in mock_table.put_item.call_args_list]
        echo = [i for i in items if i.get("agentId") == "demo-echo-agent"][0]
        assert echo["registryStatus"] == "APPROVED"
        assert echo["registryRecordId"] == "approved-001"
        assert echo["createdAt"] == "2026-01-01T00:00:00Z"

    def test_registry_denied_leaves_linkage_absent(self):
        """When registry is unavailable, the three linkage fields are absent."""
        client = _make_registry_client()
        mock_table, _, _, _ = _run_handler(
            registry_env=False, existing_records=[], registry_client=client
        )
        items = [c.kwargs["Item"] for c in mock_table.put_item.call_args_list]
        echo = [i for i in items if i.get("agentId") == "demo-echo-agent"][0]
        fab = [i for i in items if i.get("agentId") == "fabricator"][0]
        for item in (echo, fab):
            assert "registryStatus" not in item
            assert "registryRecordId" not in item
            assert "createdAt" not in item

    def test_rerun_idempotent_linkage(self):
        """Re-run with existing records still stamps linkage, no duplicates."""
        client = _make_registry_client()
        existing = [
            {"recordId": "abc123", "name": "demo-echo-agent",
             "status": "APPROVED", "createdAt": "2026-01-01T00:00:00Z"},
            {"recordId": "fab456", "name": "fabricator",
             "status": "DRAFT", "createdAt": "2026-02-01T00:00:00Z"},
        ]
        mock_table, _, mock_send, _ = _run_handler(
            registry_env=True, existing_records=existing,
            registry_client=client,
        )
        assert mock_send.call_args[0][2] == "SUCCESS"
        # No creates — both found by name
        client.create_registry_record.assert_not_called()
        # Fabricator was DRAFT → submitted for approval; echo already APPROVED
        assert client.submit_registry_record_for_approval.call_count == 1
        # Linkage still stamped from existing records
        items = [c.kwargs["Item"] for c in mock_table.put_item.call_args_list]
        echo = [i for i in items if i.get("agentId") == "demo-echo-agent"][0]
        assert echo["registryStatus"] == "APPROVED"
        assert echo["registryRecordId"] == "abc123"
        fab = [i for i in items if i.get("agentId") == "fabricator"][0]
        assert fab["registryStatus"] == "APPROVED"
        assert fab["registryRecordId"] == "fab456"


class TestRegistrySkippedWhenNotConfigured:
    def test_no_registry_calls_when_env_absent(self):
        client = _make_registry_client()
        mock_table, mock_boto3, mock_send, list_mock = _run_handler(
            registry_env=False, existing_records=[], registry_client=client
        )
        assert mock_send.call_args[0][2] == "SUCCESS"
        list_mock.assert_not_called()
        client.create_registry_record.assert_not_called()
        client.submit_registry_record_for_approval.assert_not_called()
        # DDB seeding still runs.
        assert mock_table.put_item.call_count == 5

    def test_skips_when_catalog_client_unavailable(self):
        """DDB-only envs (no catalog layer) must still seed successfully."""
        client = _make_registry_client()
        mock_table = MagicMock()
        mock_dynamodb = MagicMock()
        mock_dynamodb.Table.return_value = mock_table

        env_patch = dict(os.environ)
        env_patch["REGISTRY_ID"] = REGISTRY_ID
        env_patch["REGISTRY_ENABLED"] = "true"

        with patch.dict(os.environ, env_patch, clear=True), \
             patch.dict(
                 sys.modules,
                 {"catalog": None, "catalog.registry_client": None},
             ), \
             patch("index.boto3") as mock_boto3, \
             patch("index._SETTLE_SLEEP", 0), \
             patch("cfnresponse.send") as mock_send:
            mock_boto3.resource.return_value = mock_dynamodb
            mock_boto3.client.return_value = MagicMock()
            handler(_cfn_event(), _ctx())

        assert mock_send.call_args[0][2] == "SUCCESS"
        client.create_registry_record.assert_not_called()
        assert mock_table.put_item.call_count == 5


class TestIdempotency:
    def test_skips_create_when_record_already_exists(self):
        client = _make_registry_client()
        existing = [
            {"recordId": "zzz999zzz999", "name": "some-other-agent",
             "status": "DRAFT", "updatedAt": None},
            {"recordId": "abc123def456", "name": "demo-echo-agent",
             "status": "DRAFT", "updatedAt": None, "createdAt": None},
            {"recordId": "fab999fab999", "name": "fabricator",
             "status": "DRAFT", "updatedAt": None, "createdAt": None},
        ]
        mock_table, _, mock_send, list_mock = _run_handler(
            registry_env=True, existing_records=existing,
            registry_client=client,
        )
        assert mock_send.call_args[0][2] == "SUCCESS"
        # Idempotency lookup for each agent — at least 2 calls
        assert list_mock.call_count >= 2
        client.create_registry_record.assert_not_called()
        # Pre-existing DRAFT system agents still get submitted for approval
        assert client.submit_registry_record_for_approval.call_count == 2
        # DDB seeding unchanged.
        assert mock_table.put_item.call_count == 5

    def test_name_match_is_exact(self):
        """A prefix-similar record must not suppress the create."""
        client = _make_registry_client()
        existing = [
            {"recordId": "zzz999zzz999", "name": "demo-echo-agent-v2",
             "status": "DRAFT", "updatedAt": None},
        ]
        _run_handler(
            registry_env=True, existing_records=existing,
            registry_client=client,
        )
        # Both fabricator and echo should attempt create (no exact match)
        assert client.create_registry_record.call_count == 2


class TestSettleAndApprove:
    """Tests for the create -> settle -> submit-for-approval flow."""

    def test_creating_status_settles_to_draft_then_approved(self):
        """create_registry_record returns CREATING with no recordId;
        settle poll finds DRAFT; submit makes it APPROVED."""
        client = _make_registry_client()
        # create returns CREATING, no recordId
        client.create_registry_record.return_value = {
            "recordArn": "arn:...",
            "recordId": None,
            "status": "CREATING",
            "createdAt": None,
        }
        client.submit_registry_record_for_approval.return_value = {
            "status": "APPROVED",
        }
        # After settle poll, records appear as DRAFT (first settle call),
        # then APPROVED (re-fetch after submit)
        draft_records = [
            {"recordId": "settled-fab-001", "name": "fabricator",
             "status": "DRAFT", "createdAt": "2026-09-30T00:00:00Z"},
            {"recordId": "settled-echo-001", "name": "demo-echo-agent",
             "status": "DRAFT", "createdAt": "2026-09-30T00:00:00Z"},
        ]
        approved_records = [
            {"recordId": "settled-fab-001", "name": "fabricator",
             "status": "APPROVED", "createdAt": "2026-09-30T00:00:00Z"},
            {"recordId": "settled-echo-001", "name": "demo-echo-agent",
             "status": "APPROVED", "createdAt": "2026-09-30T00:00:00Z"},
        ]

        # Build a custom sequence: first call per agent returns [] (lookup),
        # second returns draft (settle), third+ returns approved (post-submit)
        call_seq = [
            [],               # fabricator idempotency lookup
            draft_records,    # fabricator settle poll
            approved_records, # fabricator post-submit re-fetch
            [],               # echo idempotency lookup
            draft_records,    # echo settle poll
            approved_records, # echo post-submit re-fetch
        ]
        list_mock = MagicMock(side_effect=call_seq)

        mock_table = MagicMock()
        mock_dynamodb = MagicMock()
        mock_dynamodb.Table.return_value = mock_table

        def _client_factory(service_name, *args, **kwargs):
            if service_name == "agent-registry-control":
                return client
            return MagicMock(name=f"{service_name}-mock")

        env_patch = dict(os.environ)
        env_patch["REGISTRY_ID"] = REGISTRY_ID
        env_patch["REGISTRY_ENABLED"] = "true"

        with patch.dict(os.environ, env_patch, clear=True), \
             patch("index.boto3") as mock_boto3, \
             patch("index._SETTLE_SLEEP", 0), \
             patch("catalog.registry_client.list_agent_records", list_mock), \
             patch("cfnresponse.send") as mock_send:
            mock_boto3.resource.return_value = mock_dynamodb
            mock_boto3.client.side_effect = _client_factory
            handler(_cfn_event(), _ctx())

        assert mock_send.call_args[0][2] == "SUCCESS"
        # Both agents created and submitted
        assert client.create_registry_record.call_count == 2
        assert client.submit_registry_record_for_approval.call_count == 2

        # Both DDB items carry APPROVED linkage
        items = [c.kwargs["Item"] for c in mock_table.put_item.call_args_list]
        fab = [i for i in items if i.get("agentId") == "fabricator"][0]
        echo = [i for i in items if i.get("agentId") == "demo-echo-agent"][0]
        assert fab["registryStatus"] == "APPROVED"
        assert fab["registryRecordId"] == "settled-fab-001"
        assert echo["registryStatus"] == "APPROVED"
        assert echo["registryRecordId"] == "settled-echo-001"

    def test_unsettled_after_max_polls_leaves_linkage_absent(self):
        """When the record never leaves CREATING within the poll window,
        linkage fields are absent and a WARNING is printed."""
        client = _make_registry_client()
        client.create_registry_record.return_value = {
            "recordArn": "arn:...",
            "recordId": None,
            "status": "CREATING",
            "createdAt": None,
        }
        # list_agent_records always returns CREATING (never settles)
        stuck_records = [
            {"recordId": None, "name": "fabricator",
             "status": "CREATING", "createdAt": None},
            {"recordId": None, "name": "demo-echo-agent",
             "status": "CREATING", "createdAt": None},
        ]

        # First call per agent: [] (idempotency lookup returns no match),
        # then all subsequent calls return stuck_records (never settles).
        call_counter = {"n": 0}

        def _list_side_effect(rid):
            call_counter["n"] += 1
            # First two calls are idempotency lookups
            if call_counter["n"] <= 2:
                return []
            return stuck_records

        list_mock = MagicMock(side_effect=_list_side_effect)

        mock_table = MagicMock()
        mock_dynamodb = MagicMock()
        mock_dynamodb.Table.return_value = mock_table

        def _client_factory(service_name, *args, **kwargs):
            if service_name == "agent-registry-control":
                return client
            return MagicMock(name=f"{service_name}-mock")

        env_patch = dict(os.environ)
        env_patch["REGISTRY_ID"] = REGISTRY_ID
        env_patch["REGISTRY_ENABLED"] = "true"

        with patch.dict(os.environ, env_patch, clear=True), \
             patch("index.boto3") as mock_boto3, \
             patch("index._SETTLE_SLEEP", 0), \
             patch("index._SETTLE_MAX_ATTEMPTS", 3), \
             patch("catalog.registry_client.list_agent_records", list_mock), \
             patch("cfnresponse.send") as mock_send:
            mock_boto3.resource.return_value = mock_dynamodb
            mock_boto3.client.side_effect = _client_factory
            handler(_cfn_event(), _ctx())

        assert mock_send.call_args[0][2] == "SUCCESS"
        # DDB items must NOT have linkage fields
        items = [c.kwargs["Item"] for c in mock_table.put_item.call_args_list]
        fab = [i for i in items if i.get("agentId") == "fabricator"][0]
        echo = [i for i in items if i.get("agentId") == "demo-echo-agent"][0]
        for item in (fab, echo):
            assert "registryStatus" not in item
            assert "registryRecordId" not in item
            assert "createdAt" not in item
        # No submit attempted — record never settled
        client.submit_registry_record_for_approval.assert_not_called()


class TestSmokeLinkage:
    """Smoke fixture stamped from existing DRAFT record (no submit)."""

    def test_existing_draft_system_agent_submitted_and_approved(self):
        """Pre-existing DRAFT fabricator record -> submit called once -> APPROVED stamped."""
        client = _make_registry_client()
        client.submit_registry_record_for_approval.return_value = {
            "status": "APPROVED",
        }
        existing = [
            {"recordId": "fab-draft-001", "name": "fabricator",
             "status": "DRAFT", "createdAt": "2026-09-29T00:00:00Z"},
            {"recordId": "echo-draft-001", "name": "demo-echo-agent",
             "status": "DRAFT", "createdAt": "2026-09-29T00:00:00Z"},
        ]
        mock_table, _, mock_send, _ = _run_handler(
            registry_env=True, existing_records=existing,
            registry_client=client,
        )
        assert mock_send.call_args[0][2] == "SUCCESS"
        client.create_registry_record.assert_not_called()
        # Both DRAFT system agents submitted
        assert client.submit_registry_record_for_approval.call_count == 2
        items = [c.kwargs["Item"] for c in mock_table.put_item.call_args_list]
        fab = [i for i in items if i.get("agentId") == "fabricator"][0]
        assert fab["registryStatus"] == "APPROVED"
        assert fab["registryRecordId"] == "fab-draft-001"
        echo = [i for i in items if i.get("agentId") == "demo-echo-agent"][0]
        assert echo["registryStatus"] == "APPROVED"
        assert echo["registryRecordId"] == "echo-draft-001"

    def test_existing_approved_system_agent_not_resubmitted(self):
        """Pre-existing APPROVED record -> no submit call."""
        client = _make_registry_client()
        existing = [
            {"recordId": "fab-appr-001", "name": "fabricator",
             "status": "APPROVED", "createdAt": "2026-09-29T00:00:00Z"},
            {"recordId": "echo-appr-001", "name": "demo-echo-agent",
             "status": "APPROVED", "createdAt": "2026-09-29T00:00:00Z"},
        ]
        mock_table, _, mock_send, _ = _run_handler(
            registry_env=True, existing_records=existing,
            registry_client=client,
        )
        assert mock_send.call_args[0][2] == "SUCCESS"
        client.create_registry_record.assert_not_called()
        client.submit_registry_record_for_approval.assert_not_called()
        items = [c.kwargs["Item"] for c in mock_table.put_item.call_args_list]
        fab = [i for i in items if i.get("agentId") == "fabricator"][0]
        assert fab["registryStatus"] == "APPROVED"
        echo = [i for i in items if i.get("agentId") == "demo-echo-agent"][0]
        assert echo["registryStatus"] == "APPROVED"

    def test_smoke_stamped_from_existing_draft_record(self):
        """When SMOKE_FIXTURES_ENABLED and the smoke record already exists
        as DRAFT, the DDB item carries registryStatus=DRAFT and recordId."""
        client = _make_registry_client()
        client.submit_registry_record_for_approval.return_value = {
            "status": "APPROVED",
        }
        existing = [
            {"recordId": "smoke-rec-001", "name": "smoke-idempotency-agent",
             "status": "DRAFT", "createdAt": "2026-09-30T01:00:00Z"},
            {"recordId": "fab-001", "name": "fabricator",
             "status": "APPROVED", "createdAt": "2026-01-01T00:00:00Z"},
            {"recordId": "echo-001", "name": "demo-echo-agent",
             "status": "APPROVED", "createdAt": "2026-01-01T00:00:00Z"},
        ]

        mock_table = MagicMock()
        mock_dynamodb = MagicMock()
        mock_dynamodb.Table.return_value = mock_table

        def _client_factory(service_name, *args, **kwargs):
            if service_name == "agent-registry-control":
                return client
            return MagicMock(name=f"{service_name}-mock")

        env_patch = dict(os.environ)
        env_patch["REGISTRY_ID"] = REGISTRY_ID
        env_patch["REGISTRY_ENABLED"] = "true"
        env_patch["SMOKE_FIXTURES_ENABLED"] = "true"

        list_mock = MagicMock(return_value=existing)

        with patch.dict(os.environ, env_patch, clear=True), \
             patch("index.boto3") as mock_boto3, \
             patch("index.SMOKE_FIXTURES_ENABLED", True), \
             patch("index._SETTLE_SLEEP", 0), \
             patch("catalog.registry_client.list_agent_records", list_mock), \
             patch("cfnresponse.send") as mock_send:
            mock_boto3.resource.return_value = mock_dynamodb
            mock_boto3.client.side_effect = _client_factory
            handler(_cfn_event(), _ctx())

        assert mock_send.call_args[0][2] == "SUCCESS"
        items = [c.kwargs["Item"] for c in mock_table.put_item.call_args_list]
        smoke = [i for i in items
                 if i.get("agentId") == "smoke-idempotency-agent"][0]
        # Smoke stays DRAFT — not a system agent, no submit
        assert smoke["registryStatus"] == "DRAFT"
        assert smoke["registryRecordId"] == "smoke-rec-001"
        assert smoke["createdAt"] == "2026-09-30T01:00:00Z"
        # No create or submit for smoke (existing record)
        # (fabricator+echo also exist so no create calls at all)
        client.create_registry_record.assert_not_called()
