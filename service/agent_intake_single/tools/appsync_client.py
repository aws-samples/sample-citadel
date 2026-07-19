"""SigV4-signed GraphQL client for the intake orchestration mutations.

POSTs to APPSYNC_GRAPHQL_URL signed with the runtime role's credentials
(botocore SigV4Auth, service ``appsync``) using the existing ``requests``
dependency — no new packages.

Guarantees:
- ``execute`` returns the parsed GraphQL ``data`` dict.
- GraphQL errors surface as typed exceptions with a retryable classification
  (throttle / internal / timeout-style errors are retryable; validation is
  not).
- HTTP 5xx / 429 and network timeouts get a bounded retry (<= MAX_RETRIES).
- Every log line carries the caller's session id (the intake correlation id).
- Credentials and full response bodies are NEVER logged — only operation
  labels, error types, and HTTP status codes.
"""
import json
import logging
import os
import re
import time

import boto3
import requests
from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from requests import exceptions as requests_exceptions

logger = logging.getLogger(__name__)

APPSYNC_GRAPHQL_URL = os.environ.get("APPSYNC_GRAPHQL_URL", "")
AWS_REGION = os.environ.get("AWS_REGION", "ap-southeast-2")

# Bounded retry per the design's failure-mode table (#13): initial attempt
# plus at most MAX_RETRIES retries, linear backoff.
MAX_RETRIES = 2
RETRY_BACKOFF_SECONDS = 1.5
REQUEST_TIMEOUT_SECONDS = 30

# Substrings (lowercased) in a GraphQL errorType/message that mark the error
# as transient. Everything else (validation, auth, not-found) is permanent.
_RETRYABLE_MARKERS = (
    "throttl", "toomanyrequests", "servicequota", "internal",
    "unavailable", "timeout", "timed out",
)


class AppSyncError(Exception):
    """Base error for AppSync calls. ``retryable`` drives the caller's UX."""

    def __init__(self, message: str, retryable: bool = False, error_type: str | None = None):
        super().__init__(message)
        self.retryable = retryable
        self.error_type = error_type


class AppSyncTransportError(AppSyncError):
    """Network / HTTP-level failure (never carries response bodies)."""


class AppSyncGraphQLError(AppSyncError):
    """The service answered with a GraphQL ``errors`` array."""


def _get_credentials():
    """Frozen credentials from the default chain (runtime role in AgentCore)."""
    creds = boto3.Session().get_credentials()
    if creds is None:
        raise AppSyncError(
            "No AWS credentials available to sign the AppSync request",
            retryable=False, error_type="NoCredentials",
        )
    return creds.get_frozen_credentials()


def _operation_label(query: str) -> str:
    """Loggable operation label — the intake* field name, never the payload."""
    match = re.search(r"(intake\w+)", query)
    return match.group(1) if match else "unknown"


def _is_retryable_graphql_error(error: dict) -> bool:
    text = f"{error.get('errorType', '')} {error.get('message', '')}".lower()
    return any(marker in text for marker in _RETRYABLE_MARKERS)


def _post_signed(body: str, session_id: str, operation: str):
    """One signed POST. Raises AppSyncTransportError on network/HTTP failure."""
    credentials = _get_credentials()
    aws_request = AWSRequest(
        method="POST",
        url=APPSYNC_GRAPHQL_URL,
        data=body,
        headers={"Content-Type": "application/json"},
    )
    SigV4Auth(credentials, "appsync", AWS_REGION).add_auth(aws_request)
    try:
        response = requests.post(
            APPSYNC_GRAPHQL_URL,
            data=body,
            headers=dict(aws_request.headers),
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
    except (requests_exceptions.ConnectionError, requests_exceptions.Timeout) as err:
        raise AppSyncTransportError(
            f"Network error calling AppSync for {operation}: {type(err).__name__}",
            retryable=True, error_type=type(err).__name__,
        )
    if response.status_code >= 500 or response.status_code == 429:
        raise AppSyncTransportError(
            f"AppSync returned HTTP {response.status_code} for {operation}",
            retryable=True, error_type=f"HTTP{response.status_code}",
        )
    if response.status_code != 200:
        raise AppSyncTransportError(
            f"AppSync returned HTTP {response.status_code} for {operation}",
            retryable=False, error_type=f"HTTP{response.status_code}",
        )
    try:
        return response.json()
    except ValueError:
        raise AppSyncTransportError(
            f"AppSync returned a non-JSON response for {operation}",
            retryable=True, error_type="BadResponse",
        )


def execute(query: str, variables: dict, session_id: str) -> dict:
    """Run one GraphQL operation and return the parsed ``data`` dict.

    Args:
        query: GraphQL document (one of the intake* mutations).
        variables: GraphQL variables.
        session_id: Intake session id — the correlation id stamped on every
            log line. Never used for auth.

    Returns:
        The ``data`` object from the GraphQL response.

    Raises:
        AppSyncError / subclasses with ``retryable`` classification.
    """
    operation = _operation_label(query)
    if not APPSYNC_GRAPHQL_URL:
        logger.error(
            "appsync not configured (APPSYNC_GRAPHQL_URL unset) op=%s session=%s",
            operation, session_id,
        )
        raise AppSyncError(
            "AppSync endpoint is not configured",
            retryable=False, error_type="NotConfigured",
        )

    body = json.dumps({"query": query, "variables": variables})
    last_error: AppSyncError | None = None

    for attempt in range(MAX_RETRIES + 1):
        if attempt:
            time.sleep(RETRY_BACKOFF_SECONDS * attempt)
        try:
            payload = _post_signed(body, session_id, operation)
        except AppSyncError as err:
            logger.warning(
                "appsync transport error op=%s session=%s attempt=%d type=%s retryable=%s",
                operation, session_id, attempt, err.error_type, err.retryable,
            )
            if not err.retryable:
                raise
            last_error = err
            continue

        errors = payload.get("errors") or []
        if errors:
            first = errors[0] if isinstance(errors[0], dict) else {}
            error_type = str(first.get("errorType") or "GraphQLError")
            retryable = _is_retryable_graphql_error(first)
            # Log the classification only — never the response body.
            logger.warning(
                "appsync graphql error op=%s session=%s attempt=%d errorType=%s retryable=%s",
                operation, session_id, attempt, error_type, retryable,
            )
            gql_error = AppSyncGraphQLError(
                f"GraphQL error on {operation} ({error_type})",
                retryable=retryable, error_type=error_type,
            )
            if not retryable:
                raise gql_error
            last_error = gql_error
            continue

        logger.info(
            "appsync ok op=%s session=%s attempt=%d",
            operation, session_id, attempt,
        )
        return payload.get("data") or {}

    assert last_error is not None  # loop only exhausts after a retryable error
    logger.error(
        "appsync retries exhausted op=%s session=%s type=%s",
        operation, session_id, last_error.error_type,
    )
    raise last_error
