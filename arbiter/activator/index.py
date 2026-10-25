"""Activator Lambda — agent-state lifecycle (US-ARB-009).

Consumes EventBridge events on source='agent.activate' with detail shape:
  {agentId, action: 'activate'|'suspend', actor, correlationId, orgId}

Actions:
  - 'activate' → set state='active', activatedAt=ISO now, activatedBy=actor
  - 'suspend' → set state='suspended', suspendedAt=ISO now, suspendedBy=actor

Preconditions:
  - ConditionExpression='attribute_exists(agentId)' (per AC 7.2 verbatim).
  - Missing agentId → return {statusCode: 404, error: 'Agent not found'}.
  - Duplicate events are idempotent — re-issuing the same state is a
    no-op (since the UpdateItem overwrites with the same value; property
    test covers this).
  - Missing orgId → return {statusCode: 403, error: 'TENANT_GUARD_MISSING_ORG'}
    with structured ERROR result (scanner H1 step 2).
  - Org mismatch between event orgId and target agent's orgId → return
    {statusCode: 403, error: 'TENANT_GUARD_ORG_MISMATCH'} and emit
    CloudWatch metric via common.tenant_guard.

Table: AGENT_CONFIG_TABLE env var. PK agentId.

Spec: arbiter-governance-engine/requirements.md Requirement 7.1–7.4.
Plan: US-ARB-009 Δ1 activator.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Any

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

_dynamodb = None

# Structured error codes (scanner H1 step 2)
_ERR_MISSING_ORG = "TENANT_GUARD_MISSING_ORG"
_ERR_ORG_MISMATCH = "TENANT_GUARD_ORG_MISMATCH"


def _get_table():
    global _dynamodb
    if _dynamodb is None:
        _dynamodb = boto3.resource('dynamodb')
    table_name = os.environ.get('AGENT_CONFIG_TABLE')
    if not table_name:
        raise RuntimeError('AGENT_CONFIG_TABLE env var not set')
    return _dynamodb.Table(table_name)


def __reset_clients_for_test():
    """Reset cached boto3 clients. Test-only helper."""
    global _dynamodb
    _dynamodb = None


def _get_agent_item(agent_id: str) -> dict | None:
    """Load the agent row from DynamoDB.  Returns the item dict or None."""
    resp = _get_table().get_item(Key={"agentId": agent_id})
    return resp.get("Item")


def activate_agent(agent_id: str, activated_by: str) -> dict:
    """Flip an agent's state to 'active'. Returns dict with statusCode 200 or 404."""
    now = datetime.now(timezone.utc).isoformat()
    try:
        _get_table().update_item(
            Key={'agentId': agent_id},
            UpdateExpression='SET #s = :s, activatedAt = :t, activatedBy = :u',
            ExpressionAttributeNames={'#s': 'state'},
            ExpressionAttributeValues={':s': 'active', ':t': now, ':u': activated_by},
            ConditionExpression='attribute_exists(agentId)',
        )
    except ClientError as exc:
        code = exc.response.get('Error', {}).get('Code')
        if code == 'ConditionalCheckFailedException':
            logger.warning('activate_agent: agent not found: %s', agent_id)
            return {'statusCode': 404, 'error': f'Agent not found: {agent_id}'}
        raise
    logger.info('activated agent_id=%s by=%s at=%s', agent_id, activated_by, now)
    return {'statusCode': 200, 'agentId': agent_id, 'state': 'active', 'activatedAt': now}


def suspend_agent(agent_id: str, suspended_by: str) -> dict:
    """Flip an agent's state to 'suspended'. Returns dict with statusCode 200 or 404."""
    now = datetime.now(timezone.utc).isoformat()
    try:
        _get_table().update_item(
            Key={'agentId': agent_id},
            UpdateExpression='SET #s = :s, suspendedAt = :t, suspendedBy = :u',
            ExpressionAttributeNames={'#s': 'state'},
            ExpressionAttributeValues={':s': 'suspended', ':t': now, ':u': suspended_by},
            ConditionExpression='attribute_exists(agentId)',
        )
    except ClientError as exc:
        code = exc.response.get('Error', {}).get('Code')
        if code == 'ConditionalCheckFailedException':
            logger.warning('suspend_agent: agent not found: %s', agent_id)
            return {'statusCode': 404, 'error': f'Agent not found: {agent_id}'}
        raise
    logger.info('suspended agent_id=%s by=%s at=%s', agent_id, suspended_by, now)
    return {'statusCode': 200, 'agentId': agent_id, 'state': 'suspended', 'suspendedAt': now}


def handler(event: dict, context: Any = None) -> dict:
    """EventBridge Lambda handler. Parses event.detail and dispatches."""
    detail = event.get('detail', {})
    agent_id = detail.get('agentId')
    action = detail.get('action')
    actor = detail.get('actor', 'unknown')
    correlation_id = detail.get('correlationId', 'none')
    org_id = detail.get('orgId', '')

    logger.info(
        'activator event: agent_id=%s action=%s actor=%s correlation=%s org=%s',
        agent_id, action, actor, correlation_id, org_id,
    )

    if not agent_id or not action:
        return {'statusCode': 400, 'error': 'missing agentId or action'}

    # ── Scanner H1 step 2: refuse events without orgId ──
    if not org_id:
        logger.error(
            'activator: missing orgId on activation event agent_id=%s action=%s',
            agent_id, action,
        )
        _emit_tenant_guard_metric('activator', agent_id)
        return {
            'statusCode': 403,
            'error': _ERR_MISSING_ORG,
            'message': f'activation event for agent {agent_id} has no orgId',
        }

    # ── Scanner H1 step 2: load target agent and require_same_org ──
    item = _get_agent_item(agent_id)
    if item is None:
        return {'statusCode': 404, 'error': f'Agent not found: {agent_id}'}

    try:
        from common.tenant_guard import require_same_org
        require_same_org(
            item,
            org_id,
            record_id_field='agentId',
            component='activator',
            allow_system=False,
        )
    except Exception as exc:
        logger.error(
            'activator: org mismatch agent_id=%s event_org=%s record_org=%s',
            agent_id, org_id, item.get('orgId', ''),
        )
        return {
            'statusCode': 403,
            'error': _ERR_ORG_MISMATCH,
            'message': str(exc),
        }

    if action == 'activate':
        return activate_agent(agent_id, actor)
    elif action == 'suspend':
        return suspend_agent(agent_id, actor)
    else:
        return {'statusCode': 400, 'error': f'unknown action: {action}'}


def _emit_tenant_guard_metric(component: str, record_id: str) -> None:
    """Best-effort CloudWatch metric for tenant guard violations.  Never raises."""
    try:
        cw = boto3.client('cloudwatch')
        cw.put_metric_data(
            Namespace='Citadel/Arbiter',
            MetricData=[
                {
                    'MetricName': 'TenantOrgMismatch',
                    'Dimensions': [
                        {'Name': 'Component', 'Value': component},
                    ],
                    'Value': 1,
                    'Unit': 'Count',
                },
            ],
        )
    except Exception:  # noqa: BLE001 — metrics are best-effort
        pass
