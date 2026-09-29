from decimal import Decimal
import os
from typing import Any
import boto3

CONFIG_TABLE = os.environ.get('AGENT_CONFIG_TABLE')
APPS_TABLE = os.environ.get('APPS_TABLE')
dynamodb = boto3.resource('dynamodb')

# Needed because DDB likes to throw decimals in
def parse_decimals(data: Any) -> Any:
    """Recursively converts Decimal instances to int (if whole) or float."""
    if isinstance(data, Decimal):
        return int(data) if data % 1 == 0 else float(data)
    elif isinstance(data, dict):
        return {k: parse_decimals(v) for k, v in data.items()}
    elif isinstance(data, list):
        return [parse_decimals(item) for item in data]
    else:
        return data



def _with_approval_fields(config: dict, item: dict) -> dict:
    """Stamp the record-approval gate's two DynamoDB fields
    ('registryStatus', 'createdAt') from the raw agent-config item onto the
    config dict passed through to the dispatch path (step 5c, CIT-041 PR2).

    ``resolve_record_approval`` (arbiter/governance/record_approval.py)
    reads these two fields by name (REGISTRY_STATUS_FIELD/CREATED_AT_FIELD)
    off whatever cache item it is given; the config dict IS that cache item
    at the supervisor choke point, so both fields must survive the
    scan/get_item -> config-dict projection this module already performs.
    Additive only — never overwrites an existing key of the same name on
    ``config`` itself (there is none today), and absent on the raw item
    simply means absent on the config (resolve_record_approval already
    treats a missing 'registryStatus' key as MISSING_STATUS, not a crash).
    """
    if 'registryStatus' in item:
        config['registryStatus'] = item['registryStatus']
    if 'createdAt' in item:
        config['createdAt'] = item['createdAt']
    return config


def load_config_from_dynamodb():
    print(CONFIG_TABLE)
    table = dynamodb.Table(CONFIG_TABLE)
    response = table.scan()
    items = response['Items']
    configs = []
    for item in items:
        # Only load agents with state 'active'
        if item.get('state') == 'active':
            configs.append(_with_approval_fields(item['config'], item))
    print(f"Loaded {len(configs)} active agents")
    return {'agents': configs}


def load_app_scoped_agents(app_id: str) -> dict:
    """Load only agents bound to the app with READY status.

    Queries the apps table GroupIndex for agent bindings, filters to READY,
    loads full agent configs, and applies binding overrides.
    """
    apps_table = dynamodb.Table(APPS_TABLE)
    response = apps_table.query(
        IndexName='GroupIndex',
        KeyConditionExpression='groupId = :gid AND begins_with(sortId, :prefix)',
        ExpressionAttributeValues={
            ':gid': f'APP#{app_id}',
            ':prefix': 'AGENT#',
        },
    )

    ready_bindings = [
        item for item in response.get('Items', [])
        if item.get('status') == 'READY'
    ]

    if not ready_bindings:
        return {'agents': []}

    # Load full agent configs for ready bindings
    agents_table = dynamodb.Table(CONFIG_TABLE)
    agents = []
    for binding in ready_bindings:
        agent_id = binding['agentId']
        resp = agents_table.get_item(Key={'agentId': agent_id})
        item = resp.get('Item')
        if not item or item.get('state') != 'active':
            print(f"Skipping agent {agent_id}: not found or not active")
            continue

        config = _with_approval_fields(item['config'], item)

        # Apply binding overrides
        if binding.get('systemPromptAddition'):
            config['description'] = config.get('description', '') + '\n' + binding['systemPromptAddition']
        if binding.get('modelOverride'):
            config['modelOverride'] = binding['modelOverride']

        agents.append(config)

    print(f"Loaded {len(agents)} app-scoped agents for app {app_id}")
    return {'agents': agents}


def create_agent_specs(agents_config):
    return [{
        "toolSpec": {
            "name": agent["name"],
            "description": agent["description"],
            "inputSchema": {"json": parse_decimals(agent["schema"])}
        }
    } for agent in agents_config["agents"]]