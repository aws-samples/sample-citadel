"""Read-only AgentCore Registry lookup for arbiter Python Lambdas.

PR 1 of the AgentCore Registry governance retrofit. Ships the client; PR 4
wires the fabricator design-assessment gate, supervisor load_config, and
activator to use it in place of direct AppsTable reads.

Contract
--------
* All read operations return ``None`` / ``[]`` on failure and log a warning.
  Never raise — callers rely on graceful degrade (matches the forward-
  compatible pattern already in ``arbiter/fabricator/design_assessment_gate.py``).
* boto3 client is constructed lazily (QB-013-1) so tests and partial-deploy
  environments can run without AWS credentials.
* ``registry_id`` is the AgentCore Registry ID. Per Decision #9, this is the
  key the governance authority units are scoped to.
* ``record_id`` is the per-record identifier. In the migration window, this
  may be the legacy ``appId`` value; post-migration it is the registry's
  native record ID.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

_client = None


def _get_client() -> Any:
    """Lazy boto3 client construction (QB-013-1).

    Returns the cached client after first call. Safe to call from any thread;
    first-call racers produce duplicate clients that the second-wave GC will
    reclaim — acceptable given Lambda single-thread execution model.
    """
    global _client
    if _client is None:
        _client = boto3.client("bedrock-agentcore-control")
    return _client


def __reset_client_for_test() -> None:
    """Test-only hook — forces next call to rebuild the cached client."""
    global _client
    _client = None


def get_agent_record(registry_id: str, record_id: str) -> dict | None:
    """Return the RegistryRecord as a dict, or None on any failure.

    Args:
        registry_id: AgentCore Registry ID.
        record_id: Registry record ID (may be legacy appId during migration).

    Returns:
        dict with keys ``recordId``, ``name``, ``description``, ``status``,
        ``customDescriptorContent`` (JSON string, may be None), ``createdAt``,
        ``updatedAt``. Returns None on any error.
    """
    client = _get_client()
    try:
        response = client.get_registry_record(
            registryId=registry_id,
            recordId=record_id,
        )
    except ClientError as exc:
        logger.warning(
            "Registry get_registry_record failed (registry=%s, record=%s): %s",
            registry_id, record_id, exc,
        )
        return None
    return {
        "recordId": response.get("recordId"),
        "name": response.get("name"),
        "description": response.get("description"),
        "status": response.get("status"),
        "customDescriptorContent": response.get("customDescriptorContent"),
        "createdAt": response.get("createdAt"),
        "updatedAt": response.get("updatedAt"),
    }


def get_source_project_id(registry_id: str, record_id: str) -> str | None:
    """Return the governance sourceProjectId for a registry record, or None.

    The sourceProjectId lives inside customDescriptorContent JSON (written by
    backend/src/lambda/agent-record-factory.ts registryRecordFromAgentApp).
    Returns None if the record does not exist, has no customDescriptorContent,
    or the JSON lacks a sourceProjectId field.
    """
    record = get_agent_record(registry_id, record_id)
    if record is None:
        return None
    content = record.get("customDescriptorContent")
    if not content:
        return None
    try:
        parsed = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        logger.warning(
            "Malformed customDescriptorContent for record %s/%s",
            registry_id, record_id,
        )
        return None
    if not isinstance(parsed, dict):
        return None
    value = parsed.get("sourceProjectId")
    return value if isinstance(value, str) else None


def list_agent_records(registry_id: str, filter_status: str | None = None) -> list[dict]:
    """Return a list of registry record dicts, filtered by status when given.

    Paginates through the registry. Returns an empty list on any error.
    """
    client = _get_client()
    try:
        kwargs: dict[str, Any] = {"registryId": registry_id}
        items: list[dict] = []
        while True:
            response = client.list_registry_records(**kwargs)
            for summary in response.get("records", []):
                if filter_status is not None and summary.get("status") != filter_status:
                    continue
                items.append({
                    "recordId": summary.get("recordId"),
                    "name": summary.get("name"),
                    "status": summary.get("status"),
                    "updatedAt": summary.get("updatedAt"),
                })
            next_token = response.get("nextToken")
            if not next_token:
                break
            kwargs["nextToken"] = next_token
    except ClientError as exc:
        logger.warning(
            "Registry list_registry_records failed (registry=%s): %s",
            registry_id, exc,
        )
        return []
    return items
