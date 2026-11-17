"""Consent gate for privileged intake actions.

Privileged tools (post-fabrication steps AND fabrication-lifecycle tools)
must verify that the real user clicked the confirm button in the UI before
proceeding.

ACTION_CATALOGUE is the server-defined source of truth: it maps each
privileged action id to a fixed human label and description. Tools pass
their own catalogue-id constant to ``require_consent``; unknown ids are
rejected. Button labels shown to the user come from the catalogue — the
model cannot alter them.

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

_dynamodb = boto3.resource(
    "dynamodb",
    region_name=os.environ.get("AWS_REGION", "ap-southeast-2"),
)

ACTION_CATALOGUE: dict[str, dict[str, str]] = {
    "activate_agents": {
        "label": "Activate the agents",
        "description": "Activate fabricated agents so they are ready to use",
    },
    "create_agent_app": {
        "label": "Create the app",
        "description": "Create a new Agent App to bring the agents together",
    },
    "generate_process_blueprint": {
        "label": "Generate blueprint",
        "description": "Generate and publish the process blueprint",
    },
    "import_blueprint_to_app": {
        "label": "Add blueprint to app",
        "description": "Import the published blueprint into the app as a workflow",
    },
    "plan_fabrication": {
        "label": "Plan fabrication",
        "description": "Analyse the design and produce a fabrication plan",
    },
    "confirm_fabrication_plan": {
        "label": "Confirm fabrication plan",
        "description": "Save the confirmed plan and queue agents for build",
    },
    "retry_failed_fabrication": {
        "label": "Retry failed builds",
        "description": "Re-queue fabrication for agents whose build failed or stalled",
    },
}
"""Server-defined catalogue of privileged action ids.

Every privileged tool passes its own constant id from this catalogue to
``require_consent``. Unknown ids are rejected. Button labels shown to the
user come from the ``label`` field — the model cannot alter them.
"""

PRIVILEGED_ACTIONS = frozenset(ACTION_CATALOGUE.keys())


class ConsentRequired(Exception):
    """Raised when a privileged action is attempted without a valid consent."""
    def __init__(self, action: str, reason: str = "missing"):
        self.action = action
        self.reason = reason
        super().__init__(f"Consent required for {action} ({reason})")


def _get_table_name() -> str:
    """Resolve the table name at call time so tests can set the env var
    via monkeypatch/fixture after the module is imported."""
    return os.environ.get("SESSION_MEMORY_TABLE", "")


def _table():
    return _dynamodb.Table(_get_table_name())


def require_consent(session_id: str, action: str) -> None:
    """Check and consume a consent record.

    Raises ConsentRequired if the action is not in the server-defined
    ACTION_CATALOGUE, or if the DDB record is absent, expired, or for a
    different session/action.  Deletes (consumes) the record on success
    so it is single-use.
    """
    if action not in ACTION_CATALOGUE:
        raise ConsentRequired(action, reason="unknown_action")

    if action not in PRIVILEGED_ACTIONS:
        return

    table_name = _get_table_name()
    if not table_name:
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
