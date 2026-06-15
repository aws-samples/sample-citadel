"""Jagged-Frontier `escalate` tool.

Explicit human-escalation tool invoked by agents when a task is outside
AI-analytical scope (C12 Jagged-Frontier principle). Emits exactly one
`governance.offfrontier.escalated` EventBridge event and exactly one
`CitadelGovernance/OffFrontierEscalations` CloudWatch metric increment
per invocation.

Corrections over design.md §4b reference:
1. JSON construction via ``json.dumps`` (injection-safe).
2. Timezone-aware ``datetime.now(timezone.utc)`` (Python 3.14 deprecates utcnow).
3. Optional ``correlation_id`` keyword-only arg; generated via ``uuid.uuid4()``
   when omitted. Required by the shared governance envelope.
4. ``reason`` is silently truncated to ``MAX_REASON_LEN`` chars — escalation
   must never fail on input-validation technicalities.
"""
import json
import os
import uuid
from datetime import datetime, timezone
from typing import Any

import boto3
from strands import tool

MAX_REASON_LEN = 500
EVENT_DETAIL_TYPE = 'governance.offfrontier.escalated'
EVENT_SOURCE = 'citadel.backend'
METRIC_NAMESPACE = 'CitadelGovernance'
METRIC_NAME = 'OffFrontierEscalations'

# Module-level boto3 clients (cached on first call). Lazy construction keeps
# test import fast and lets tests patch boto3.client before first access.
_cw_client = None
_eb_client = None

def _cloudwatch():
    global _cw_client
    if _cw_client is None:
        _cw_client = boto3.client('cloudwatch')
    return _cw_client

def _eventbridge():
    global _eb_client
    if _eb_client is None:
        _eb_client = boto3.client('events')
    return _eb_client

def __reset_escalate_clients_for_test() -> None:
    """Test-only: clear cached boto3 clients so a fresh mock can be bound."""
    global _cw_client, _eb_client
    _cw_client = None
    _eb_client = None

@tool
def escalate(
    reason: str,
    project_id: str,
    agent_id: str,
    *,
    correlation_id: str | None = None,
) -> dict[str, str]:
    """Escalate a task to a human reviewer (Jagged-Frontier principle C12).

    Call this when a task is outside AI-analytical scope — judgment calls,
    political awareness, constraint reasoning. Emits exactly one
    `governance.offfrontier.escalated` EventBridge event and exactly one
    `CitadelGovernance/OffFrontierEscalations` CloudWatch metric increment
    per invocation (AC-1, AC-3).

    Args:
        reason: Brief description of why this escalates. Truncated to
          500 characters if longer (escalation must never fail on length).
        project_id: The project this escalation belongs to.
        agent_id: The agent initiating the escalation.
        correlation_id: Optional UUID for cross-service traceability. A
          fresh UUID4 is generated if omitted.

    Returns:
        dict with status and message keys.
    """
    cid = correlation_id or str(uuid.uuid4())
    safe_reason = (reason or '')[:MAX_REASON_LEN]
    now_iso = datetime.now(timezone.utc).isoformat()

    detail: dict[str, Any] = {
        'correlationId': cid,
        'timestamp': now_iso,
        'projectId': project_id,
        'agentId': agent_id,
        'reason': safe_reason,
    }

    _eventbridge().put_events(Entries=[{
        'Source': EVENT_SOURCE,
        'DetailType': EVENT_DETAIL_TYPE,
        'Detail': json.dumps(detail),
        'EventBusName': os.environ.get('EVENT_BUS_NAME', 'default'),
    }])

    _cloudwatch().put_metric_data(
        Namespace=METRIC_NAMESPACE,
        MetricData=[{
            'MetricName': METRIC_NAME,
            'Value': 1,
            'Unit': 'Count',
            'Dimensions': [{'Name': 'ProjectId', 'Value': project_id}],
        }]
    )

    return {
        'status': 'escalated',
        'message': 'Escalation routed to human reviewer',
    }
