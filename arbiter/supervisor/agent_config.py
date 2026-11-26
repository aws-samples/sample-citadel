from decimal import Decimal
import json
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
    # Carry orgId + orgUnknown so tenant filtering (filter_by_org downstream)
    # can scope the catalogue. Without this, config dicts lack orgId and
    # filter_by_org treats them as unknown → excluded.
    if 'orgId' in item:
        config['orgId'] = item['orgId']
    if item.get('orgUnknown'):
        config['orgUnknown'] = True
    return config


# Keys on the raw agent-config item consulted, in order, when the projected
# ``config`` carries no usable ``name``. Registry-projected rows can have an
# empty or differently keyed config, but always keep the item identifiers.
_NAME_FALLBACK_KEYS = ('agentId', 'registryRecordId', '_canonicalRecordId')


def _warn(action: str, **fields: Any) -> None:
    print(json.dumps({
        'level': 'WARN',
        'component': 'SupervisorAgentConfig',
        'action': action,
        **fields,
    }))


def _ensure_agent_name(config: dict, item: dict) -> bool:
    """Guarantee ``config['name']`` is set; this is the one normalisation point.

    Fallback chain: ``config['name']`` -> ``item['agentId']`` ->
    ``item['registryRecordId']`` -> ``item['_canonicalRecordId']``. A WARN
    (``name_fallback``) is logged whenever a fallback supplies the name.
    Returns False (after logging ``skip_unnamed_config``) only when no
    identifier exists at all, so the caller can skip the agent.

    Every downstream consumer (tool specs, dispatch lookup by name) reads the
    normalised ``name`` and so needs no fallback logic of its own.
    """
    name = config.get('name')
    if isinstance(name, str) and name.strip():
        return True
    for key in _NAME_FALLBACK_KEYS:
        candidate = item.get(key)
        if isinstance(candidate, str) and candidate.strip():
            config['name'] = candidate
            _warn(
                'name_fallback',
                agentId=item.get('agentId', 'unknown'),
                source=key,
                name=candidate,
            )
            return True
    _warn(
        'skip_unnamed_config',
        agentId=item.get('agentId', 'unknown'),
        orgId=item.get('orgId', 'unknown'),
        _canonicalRecordId=item.get('_canonicalRecordId', 'unknown'),
    )
    return False


def _prepare_agent_config(item: dict):
    """Turn a raw agent-config item into a normalised config dict.

    Returns ``(config, None)`` on success or ``(None, action)`` when the item
    is skipped, where ``action`` is the WARN action already logged
    (``skip_missing_config``, ``skip_malformed_config`` or
    ``skip_unnamed_config``).
    """
    cfg = item.get('config')
    if cfg is None:
        # Name-keyed projection/stub rows can be 'active' without a config
        # attribute; they cannot be dispatched, so skip them rather than
        # failing every supervisor task with a KeyError.
        _warn(
            'skip_missing_config',
            agentId=item.get('agentId', 'unknown'),
            orgId=item.get('orgId', 'unknown'),
            _canonicalRecordId=item.get('_canonicalRecordId', 'unknown'),
        )
        return None, 'skip_missing_config'
    # Live DynamoDB rows may store config as a JSON string; parse it.
    if isinstance(cfg, str):
        try:
            cfg = json.loads(cfg)
        except (json.JSONDecodeError, TypeError):
            cfg = None
    if not isinstance(cfg, dict):
        _warn('skip_malformed_config', agentId=item.get('agentId', 'unknown'))
        return None, 'skip_malformed_config'
    cfg = _with_approval_fields(cfg, item)
    if not _ensure_agent_name(cfg, item):
        return None, 'skip_unnamed_config'
    return cfg, None


def load_config_from_dynamodb(org_id: str | None = None):
    print(CONFIG_TABLE)
    table = dynamodb.Table(CONFIG_TABLE)
    response = table.scan()
    items = response['Items']
    configs = []
    skipped_missing_config = 0
    for item in items:
        # Only load agents with state 'active'
        if item.get('state') == 'active':
            cfg, skipped = _prepare_agent_config(item)
            if cfg is None:
                if skipped == 'skip_missing_config':
                    skipped_missing_config += 1
                continue
            configs.append(cfg)

    if skipped_missing_config:
        print(json.dumps({
            'level': 'INFO',
            'component': 'SupervisorAgentConfig',
            'action': 'skipped_unusable_configs',
            'skippedMissingConfig': skipped_missing_config,
        }))

    # Tenant isolation: filter catalogue to bound org + system records
    if org_id:
        from common.tenant_guard import filter_by_org

        configs = filter_by_org(
            configs,
            org_id,
            org_field="orgId",
            allow_system=True,
            component="supervisor",
        )

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

        config, _ = _prepare_agent_config(item)
        if config is None:
            continue

        # Apply binding overrides
        if binding.get('systemPromptAddition'):
            config['description'] = config.get('description', '') + '\n' + binding['systemPromptAddition']
        if binding.get('modelOverride'):
            config['modelOverride'] = binding['modelOverride']

        agents.append(config)

    print(f"Loaded {len(agents)} app-scoped agents for app {app_id}")
    return {'agents': agents}


_TOOL_SPEC_FIELDS = ('name', 'description', 'schema')


def create_agent_specs(agents_config):
    specs = []
    for agent in agents_config["agents"]:
        # An agent that cannot form a valid tool spec (e.g. an empty projected
        # config with only a fallback name) must not fail every task.
        missing = [f for f in _TOOL_SPEC_FIELDS if agent.get(f) is None]
        if missing:
            _warn(
                'skip_unusable_agent_spec',
                name=agent.get('name', 'unknown'),
                missing=missing,
            )
            continue
        specs.append({
            "toolSpec": {
                "name": agent["name"],
                "description": agent["description"],
                "inputSchema": {"json": parse_decimals(agent["schema"])}
            }
        })
    return specs
