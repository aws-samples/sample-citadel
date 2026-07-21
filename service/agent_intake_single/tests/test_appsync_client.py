"""Tests for tools/appsync_client.py — SigV4-signed GraphQL POST client.

Contract:
- execute(query, variables, session_id) returns the parsed `data` dict.
- Requests are SigV4-signed for service `appsync` (Authorization + X-Amz-Date).
- GraphQL errors surface as typed exceptions with a retryable classification.
- HTTP 5xx / 429 / network timeouts are retried (bounded, <=2 retries).
- Every log line carries the session id; credentials and full responses are
  never logged.

Run with:
    PYTHONPATH=. ../../.venv/bin/python -m pytest tests/test_appsync_client.py -q
from the service/agent_intake_single directory.
"""
import json
import logging
import os
import sys
import types
from unittest import mock

import pytest
from botocore.credentials import ReadOnlyCredentials

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("APPSYNC_GRAPHQL_URL", "https://test-api.appsync-api.ap-southeast-2.amazonaws.com/graphql")

import tools.appsync_client as client

QUERY = """mutation IntakeActivate($sessionId: ID!) {
  intakeActivateProjectAgents(sessionId: $sessionId) { activated failed alreadyActive matchedBy }
}"""

SECRET = "SECRETTESTVALUE9999"


def _resp(status=200, payload=None):
    r = mock.MagicMock()
    r.status_code = status
    r.json.return_value = payload if payload is not None else {}
    return r


@pytest.fixture(autouse=True)
def _no_sleep_and_fake_creds(monkeypatch):
    monkeypatch.setattr(client.time, "sleep", lambda *_: None)
    monkeypatch.setattr(
        client, "_get_credentials",
        lambda: ReadOnlyCredentials("AKIDTEST", SECRET, None),
    )
    monkeypatch.setattr(
        client, "APPSYNC_GRAPHQL_URL",
        "https://test-api.appsync-api.ap-southeast-2.amazonaws.com/graphql",
    )
    yield


@pytest.fixture
def post(monkeypatch):
    post_mock = mock.MagicMock()
    monkeypatch.setattr(client, "requests", types.SimpleNamespace(post=post_mock))
    return post_mock


def test_execute_returns_parsed_data(post):
    post.return_value = _resp(200, {"data": {"intakeActivateProjectAgents": {"activated": ["A"]}}})

    data = client.execute(QUERY, {"sessionId": "s1"}, session_id="s1")

    assert data == {"intakeActivateProjectAgents": {"activated": ["A"]}}
    assert post.call_count == 1


def test_request_is_sigv4_signed(post):
    post.return_value = _resp(200, {"data": {}})

    client.execute(QUERY, {"sessionId": "s1"}, session_id="s1")

    kwargs = post.call_args.kwargs
    headers = kwargs["headers"]
    auth = headers.get("Authorization") or headers.get("authorization")
    assert auth and "AWS4-HMAC-SHA256" in auth
    assert any(k.lower() == "x-amz-date" for k in headers)
    # The signed body is the GraphQL request.
    body = json.loads(kwargs["data"])
    assert body["variables"] == {"sessionId": "s1"}
    assert "intakeActivateProjectAgents" in body["query"]


def test_unset_url_raises_nonretryable_config_error(post, monkeypatch):
    monkeypatch.setattr(client, "APPSYNC_GRAPHQL_URL", "")

    with pytest.raises(client.AppSyncError) as exc:
        client.execute(QUERY, {"sessionId": "s1"}, session_id="s1")

    assert exc.value.retryable is False
    post.assert_not_called()


def test_graphql_validation_error_raises_nonretryable(post):
    post.return_value = _resp(200, {
        "errors": [{"errorType": "ValidationException", "message": "sessionId is required"}],
        "data": None,
    })

    with pytest.raises(client.AppSyncGraphQLError) as exc:
        client.execute(QUERY, {"sessionId": "s1"}, session_id="s1")

    assert exc.value.retryable is False
    assert post.call_count == 1  # non-retryable -> no retry


def test_graphql_throttle_error_retried_then_success(post):
    throttled = _resp(200, {"errors": [{"errorType": "ThrottlingException", "message": "slow down"}]})
    ok = _resp(200, {"data": {"intakeCreateApp": {"appId": "a1"}}})
    post.side_effect = [throttled, throttled, ok]

    data = client.execute(QUERY, {"sessionId": "s1"}, session_id="s1")

    assert data["intakeCreateApp"]["appId"] == "a1"
    assert post.call_count == 3


def test_http_5xx_retried_then_success(post):
    post.side_effect = [_resp(500), _resp(200, {"data": {"ok": True}})]

    data = client.execute(QUERY, {"sessionId": "s1"}, session_id="s1")

    assert data == {"ok": True}
    assert post.call_count == 2


def test_http_403_not_retried(post):
    post.return_value = _resp(403)

    with pytest.raises(client.AppSyncTransportError) as exc:
        client.execute(QUERY, {"sessionId": "s1"}, session_id="s1")

    assert exc.value.retryable is False
    assert post.call_count == 1


def test_retries_bounded_then_raises_retryable(post):
    post.return_value = _resp(500)

    with pytest.raises(client.AppSyncError) as exc:
        client.execute(QUERY, {"sessionId": "s1"}, session_id="s1")

    assert exc.value.retryable is True
    assert post.call_count == 3  # initial + 2 bounded retries


def test_network_timeout_retried(post):
    import requests as real_requests
    post.side_effect = [real_requests.exceptions.Timeout(), _resp(200, {"data": {"ok": 1}})]

    data = client.execute(QUERY, {"sessionId": "s1"}, session_id="s1")

    assert data == {"ok": 1}
    assert post.call_count == 2


# --- non-idempotent mutations: never auto-retried on timeout -------------------
#
# Live triplicate-create incident: intakeCreateApp timed out client-side at
# 30s while the Lambda kept running and persisted the app; the automatic
# retry then created ANOTHER app (one consent -> three apps). A timed-out
# request may have executed, so createApp/createBlueprint must surface the
# timeout to the tool layer (retryable=True -> "Try again" consent; the
# server-side idempotency guard makes a user-consented retry safe) instead
# of auto-retrying. Reads and idempotent mutations keep the auto-retry.

CREATE_APP_QUERY = """mutation IntakeCreateApp($sessionId: ID!, $name: String!) {
  intakeCreateApp(sessionId: $sessionId, name: $name) { appId name status }
}"""

CREATE_BLUEPRINT_QUERY = """mutation IntakeCreateBlueprint($sessionId: ID!, $name: String!, $definition: AWSJSON!) {
  intakeCreateBlueprint(sessionId: $sessionId, name: $name, definition: $definition) { ok blueprintId }
}"""


def test_create_app_network_timeout_not_auto_retried(post):
    import requests as real_requests
    post.side_effect = real_requests.exceptions.Timeout()

    with pytest.raises(client.AppSyncTransportError) as exc:
        client.execute(CREATE_APP_QUERY, {"sessionId": "s1", "name": "A"}, session_id="s1")

    assert post.call_count == 1  # no automatic retry
    # Still marked retryable: the tool layer turns this into the standard
    # failure envelope with an explicit "Try again" consent.
    assert exc.value.retryable is True


def test_create_blueprint_network_timeout_not_auto_retried(post):
    import requests as real_requests
    post.side_effect = real_requests.exceptions.Timeout()

    with pytest.raises(client.AppSyncTransportError) as exc:
        client.execute(
            CREATE_BLUEPRINT_QUERY,
            {"sessionId": "s1", "name": "B", "definition": "{}"},
            session_id="s1",
        )

    assert post.call_count == 1
    assert exc.value.retryable is True


def test_create_app_graphql_timeout_not_auto_retried(post):
    # A Lambda that exceeds its own timeout surfaces as a GraphQL error with
    # timeout wording — the side effects may already be persisted, so this is
    # the same do-not-auto-retry class as a transport timeout.
    post.return_value = _resp(200, {
        "errors": [{"errorType": "Lambda:ExecutionTimeoutException",
                    "message": "Execution timed out."}],
        "data": None,
    })

    with pytest.raises(client.AppSyncGraphQLError) as exc:
        client.execute(CREATE_APP_QUERY, {"sessionId": "s1", "name": "A"}, session_id="s1")

    assert post.call_count == 1
    assert exc.value.retryable is True


def test_create_app_throttle_still_auto_retried(post):
    # Throttled requests were never executed — auto-retry stays even for the
    # non-idempotent mutations.
    throttled = _resp(200, {"errors": [{"errorType": "ThrottlingException", "message": "slow down"}]})
    ok = _resp(200, {"data": {"intakeCreateApp": {"appId": "a1"}}})
    post.side_effect = [throttled, ok]

    data = client.execute(CREATE_APP_QUERY, {"sessionId": "s1", "name": "A"}, session_id="s1")

    assert data["intakeCreateApp"]["appId"] == "a1"
    assert post.call_count == 2


def test_import_mutation_timeout_still_auto_retried(post):
    # intakeImportBlueprintToApp is server-side idempotent (already-imported
    # detection) — the timeout auto-retry stays for it.
    import requests as real_requests
    import_query = """mutation IntakeImport($sessionId: ID!) {
      intakeImportBlueprintToApp(sessionId: $sessionId) { workflowId }
    }"""
    post.side_effect = [real_requests.exceptions.Timeout(), _resp(200, {"data": {"ok": 1}})]

    data = client.execute(import_query, {"sessionId": "s1"}, session_id="s1")

    assert data == {"ok": 1}
    assert post.call_count == 2


def test_logs_have_session_id_and_no_secrets(post, caplog):
    canary = "CANARY_RESPONSE_VALUE"
    post.return_value = _resp(200, {"data": {"intakeCreateApp": {"appId": canary}}})

    with caplog.at_level(logging.INFO, logger="tools.appsync_client"):
        client.execute(QUERY, {"sessionId": "sess-log-1"}, session_id="sess-log-1")

    assert caplog.records, "expected at least one log line"
    assert all("sess-log-1" in rec.getMessage() for rec in caplog.records)
    assert SECRET not in caplog.text
    assert canary not in caplog.text  # full responses never logged


def test_graphql_error_logs_never_contain_full_response(post, caplog):
    canary = "FULL_RESPONSE_CANARY"
    post.return_value = _resp(200, {
        "errors": [{"errorType": "ValidationException", "message": "bad input"}],
        "data": {"leak": canary},
    })

    with caplog.at_level(logging.INFO, logger="tools.appsync_client"):
        with pytest.raises(client.AppSyncGraphQLError):
            client.execute(QUERY, {"sessionId": "sess-log-2"}, session_id="sess-log-2")

    assert canary not in caplog.text
    assert all("sess-log-2" in rec.getMessage() for rec in caplog.records)
