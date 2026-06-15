"""Activator Lambda — agent-state lifecycle (US-ARB-009).

Consumes EventBridge events on source='agent.activate' with detail shape:
  {agentId, action: 'activate'|'suspend', actor, correlationId}

Actions:
  - 'activate' → set state='active', activatedAt=ISO now, activatedBy=actor
  - 'suspend' → set state='suspended', suspendedAt=ISO now, suspendedBy=actor

Preconditions:
  - ConditionExpression='attribute_exists(agentId)' (per AC 7.2 verbatim).
  - Missing agentId → return {statusCode: 404, error: 'Agent not found'}.
  - Duplicate events are idempotent — re-issuing the same state is a
    no-op (since the UpdateItem overwrites with the same value; property
    test covers this).

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

    logger.info(
        'activator event: agent_id=%s action=%s actor=%s correlation=%s',
        agent_id, action, actor, correlation_id,
    )

    if not agent_id or not action:
        return {'statusCode': 400, 'error': 'missing agentId or action'}

    if action == 'activate':
        return activate_agent(agent_id, actor)
    elif action == 'suspend':
        return suspend_agent(agent_id, actor)
    else:
        return {'statusCode': 400, 'error': f'unknown action: {action}'}
