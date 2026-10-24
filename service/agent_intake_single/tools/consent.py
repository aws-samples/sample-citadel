"""Consent gate for privileged intake post-fabrication actions.

The four post-fabrication tools (activate_agents, create_agent_app,
generate_process_blueprint, import_blueprint_to_app) must verify that the
real user clicked the confirm button in the UI before proceeding.

The frontend writes a short-lived consent record to DynamoDB via the
recordIntakeConsent AppSync mutation. This module checks and consumes
(deletes) that record.

Record shape in SESSION_MEMORY_TABLE:
    PK (p_key): <session_id>
    SK (s_key): "consent#<action>"
    ttl:        <epoch seconds, +10 minutes from grant>
"""
import logging
import os
import time

import boto3

logger = logging.getLogger(__name__)

AWS_REGION = os.environ.get("AWS_REGION", "ap-southeast-2")
TABLE_NAME = os.environ.get("SESSION_MEMORY_TABLE", "")

_dynamodb = boto3.resource("dynamodb", region_name=AWS_REGION)

PRIVILEGED_ACTIONS = frozenset({
    "activate_agents",
    "create_agent_app",
    "generate_process_blueprint",
    "import_blueprint_to_app",
})


class ConsentRequired(Exception):
    """Raised when a privileged action is attempted without a valid consent."""
    def __init__(self, action: str, reason: str = "missing"):
        self.action = action
        self.reason = reason
        super().__init__(f"Consent required for {action} ({reason})")


def _table():
    return _dynamodb.Table(TABLE_NAME)


def require_consent(session_id: str, action: str) -> None:
    """Check and consume a consent record.

    Raises ConsentRequired if the record is absent, expired, or for a
    different session/action.  Deletes (consumes) the record on success
    so it is single-use.
    """
    if action not in PRIVILEGED_ACTIONS:
        return

    if not TABLE_NAME:
        logger.warning("SESSION_MEMORY_TABLE not configured; consent check skipped")
        return

    key = {"p_key": session_id, "s_key": f"consent#{action}"}

    try:
        resp = _table().get_item(Key=key)
    except Exception:
        logger.exception("consent check DDB get_item failed session=%s action=%s", session_id, action)
        raise ConsentRequired(action, reason="lookup_failed")

    item = resp.get("Item")
    if not item:
        raise ConsentRequired(action, reason="missing")

    # TTL is enforced by DynamoDB eventually (up to 48h lag); verify explicitly.
    if item.get("ttl", 0) < int(time.time()):
        # Clean up the expired record.
        try:
            _table().delete_item(Key=key)
        except Exception:
            logger.warning("consent cleanup of expired record failed session=%s", session_id)
        raise ConsentRequired(action, reason="expired")

    # Consume: delete BEFORE proceeding (fail-safe — if the tool mutation
    # fails afterward, the user must re-consent, which is correct).
    try:
        _table().delete_item(Key=key)
    except Exception:
        logger.exception("consent consume delete_item failed session=%s action=%s", session_id, action)
        raise ConsentRequired(action, reason="consume_failed")
