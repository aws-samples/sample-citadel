"""Activator admin CLI (US-ARB-018).

Subcommands:
  activate-agent <id>          Publish agent.activate event (action=activate)
  suspend-agent <id>           Publish agent.activate event (action=suspend)
  list-pending-activation      Scan AgentConfigTable, print state='inactive' rows
  activation-history <id>      Print activation/suspension timestamps for an agent

Env vars:
  AGENT_CONFIG_TABLE   required for list/history subcommands
  EVENT_BUS_NAME       required for activate/suspend subcommands
  CLI_ACTOR            optional, defaults to 'cli'

Spec: arbiter-governance-engine/requirements.md Requirement 7.7–7.9.
"""

import argparse
import json
import os
import sys
import uuid
from datetime import datetime, timezone

import boto3


_dynamodb = None
_events_client = None


def _get_dynamodb():
    global _dynamodb
    if _dynamodb is None:
        _dynamodb = boto3.resource('dynamodb')
    return _dynamodb


def _get_events():
    global _events_client
    if _events_client is None:
        _events_client = boto3.client('events')
    return _events_client


def __reset_clients_for_test():
    """Reset cached boto3 clients. Test-only helper."""
    global _dynamodb, _events_client
    _dynamodb = None
    _events_client = None


def _emit_activation_event(agent_id: str, action: str, actor: str) -> str:
    """Publish agent.activate EventBridge event. Returns correlationId."""
    bus = os.environ.get('EVENT_BUS_NAME', 'default')
    correlation_id = str(uuid.uuid4())
    detail = {
        'agentId': agent_id,
        'action': action,
        'actor': actor,
        'correlationId': correlation_id,
    }
    _get_events().put_events(Entries=[{
        'Source': 'agent.activate',
        'DetailType': 'agent.activation.requested',
        'Detail': json.dumps(detail),
        'EventBusName': bus,
    }])
    return correlation_id


def cmd_activate(args) -> int:
    cid = _emit_activation_event(args.agent_id, 'activate', args.actor)
    print(json.dumps({
        'status': 'queued',
        'agentId': args.agent_id,
        'action': 'activate',
        'correlationId': cid,
    }))
    return 0


def cmd_suspend(args) -> int:
    cid = _emit_activation_event(args.agent_id, 'suspend', args.actor)
    print(json.dumps({
        'status': 'queued',
        'agentId': args.agent_id,
        'action': 'suspend',
        'correlationId': cid,
    }))
    return 0


def cmd_list_pending(args) -> int:
    table = _get_dynamodb().Table(os.environ['AGENT_CONFIG_TABLE'])
    rows = []
    response = table.scan()
    rows.extend(response.get('Items', []))
    while 'LastEvaluatedKey' in response:
        response = table.scan(ExclusiveStartKey=response['LastEvaluatedKey'])
        rows.extend(response.get('Items', []))
    pending = [r for r in rows if r.get('state') == 'inactive']
    pending.sort(key=lambda r: r.get('createdAt', ''))
    for r in pending:
        print(json.dumps({
            'agentId': r.get('agentId'),
            'appId': r.get('appId'),
            'createdAt': r.get('createdAt'),
            'ownerAlias': r.get('ownerAlias'),
        }))
    return 0


def cmd_history(args) -> int:
    table = _get_dynamodb().Table(os.environ['AGENT_CONFIG_TABLE'])
    response = table.get_item(Key={'agentId': args.agent_id})
    item = response.get('Item')
    if not item:
        print(f'Agent not found: {args.agent_id}', file=sys.stderr)
        return 1
    history = {
        'agentId': item.get('agentId'),
        'state': item.get('state'),
        'createdAt': item.get('createdAt'),
        'activatedAt': item.get('activatedAt'),
        'activatedBy': item.get('activatedBy'),
        'suspendedAt': item.get('suspendedAt'),
        'suspendedBy': item.get('suspendedBy'),
    }
    print(json.dumps(history, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog='activator-admin')
    p.add_argument('--actor', default=os.environ.get('CLI_ACTOR', 'cli'))
    sub = p.add_subparsers(dest='command', required=True)

    s_act = sub.add_parser('activate-agent')
    s_act.add_argument('agent_id')
    s_act.set_defaults(func=cmd_activate)

    s_sus = sub.add_parser('suspend-agent')
    s_sus.add_argument('agent_id')
    s_sus.set_defaults(func=cmd_suspend)

    s_list = sub.add_parser('list-pending-activation')
    s_list.set_defaults(func=cmd_list_pending)

    s_hist = sub.add_parser('activation-history')
    s_hist.add_argument('agent_id')
    s_hist.set_defaults(func=cmd_history)

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == '__main__':
    sys.exit(main())
