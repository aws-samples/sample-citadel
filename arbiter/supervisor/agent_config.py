from decimal import Decimal
import json
import os
import re
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
    # Carry the row's agentId (never overriding one the config declares) so
    # tool-spec validation warnings can name the offending record.
    if 'agentId' in item:
        config.setdefault('agentId', item['agentId'])
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

# Bedrock Converse toolSpec.name constraint.
_INVALID_TOOL_NAME_CHARS = re.compile(r'[^a-zA-Z0-9_-]')


def _name_for_log(agent: dict) -> str:
    name = agent.get('name')
    return name if isinstance(name, str) else str(name)


def _agent_id_for_log(agent: dict) -> str:
    return str(agent.get('agentId') or agent.get('_canonicalRecordId') or 'unknown')


_HTTP_METHODS = ('get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace')


def _is_object_schema(schema: Any) -> bool:
    return isinstance(schema, dict) and schema.get('type') == 'object'


def _first_openapi_operation(doc: dict):
    paths = doc.get('paths')
    if not isinstance(paths, dict):
        return None
    for path_item in paths.values():
        if not isinstance(path_item, dict):
            continue
        for method in _HTTP_METHODS:
            operation = path_item.get(method)
            if isinstance(operation, dict):
                return operation
    return None


def _openapi_request_body_schema(operation: dict):
    try:
        schema = operation['requestBody']['content']['application/json']['schema']
    except (KeyError, TypeError):
        return None
    # A $ref points into the original document, which is not sent to the
    # model, so a body that contains one cannot be used.
    if _is_object_schema(schema) and '"$ref"' not in json.dumps(schema, default=str):
        return schema
    return None


def _openapi_parameters_schema(operation: dict):
    parameters = operation.get('parameters')
    if not isinstance(parameters, list):
        return None
    properties = {}
    required = []
    for parameter in parameters:
        if not isinstance(parameter, dict) or not isinstance(parameter.get('name'), str):
            continue
        param_schema = parameter.get('schema')
        param_type = param_schema.get('type') if isinstance(param_schema, dict) else None
        if param_type not in ('string', 'number', 'integer', 'boolean', 'array', 'object'):
            param_type = 'string'
        prop = {'type': param_type}
        if isinstance(parameter.get('description'), str):
            prop['description'] = parameter['description']
        properties[parameter['name']] = prop
        if parameter.get('required') is True:
            required.append(parameter['name'])
    if not properties:
        return None
    schema = {'type': 'object', 'properties': properties}
    if required:
        schema['required'] = required
    return schema


def _schema_from_openapi(doc: dict, agent_name: str):
    """Return ``(schema, strategy)`` for the first operation of an OpenAPI doc."""
    operation = _first_openapi_operation(doc)
    if operation is not None:
        body = _openapi_request_body_schema(operation)
        if body is not None:
            return body, 'request_body'
        params = _openapi_parameters_schema(operation)
        if params is not None:
            return params, 'parameters'
    return {
        'type': 'object',
        'properties': {
            'input': {
                'type': 'string',
                'description': f'Free-text request for {agent_name}',
            }
        },
        'required': ['input'],
    }, 'fallback_input'


# Wrapper keys that hold the real input schema (an MCP/Anthropic-style tool
# definition or an agent manifest) next to name/description/outputSchema.
_INPUT_SCHEMA_KEYS = ('inputSchema', 'input_schema')
# Bounds nested wrappers (including stringified ones) so a malformed record
# cannot recurse without limit.
_MAX_SCHEMA_DEPTH = 4


def to_tool_input_schema(schema: Any, agent_name: Any, agent_id: Any = None, _depth: int = 0):
    """Return ``(schema, None)`` or ``(None, reason)`` for a Converse input schema.

    Converse requires ``inputSchema.json`` to be a JSON Schema with
    ``type: 'object'``. Stored agent schemas come in other shapes:

    - a string holding a JSON object: parsed, then handled as below
      (WARN ``parsed_stringified_schema``);
    - ``{'function': {'parameters': {...}}}`` with any outer ``type`` (the
      OpenAI wrapper has ``type: 'function'``): the parameters, validated
      like any other schema (WARN ``unwrapped_function_schema``);
    - ``{'inputSchema': {...}}`` or ``{'input_schema': {...}}`` with no
      ``type: 'object'`` of its own: the inner schema (WARN
      ``unwrapped_input_schema`` with the ``key``);
    - ``type: 'object'``: returned unchanged;
    - ``properties`` but no ``type``: ``type: 'object'`` added to a copy
      (WARN ``normalised_schema_type``);
    - OpenAPI 3 / Swagger 2 document (``openapi``/``swagger``/``paths``): the
      first operation's JSON request body if it is an object schema without
      ``$ref``, else an object built from its parameters, else a single
      free-text ``input`` property (WARN ``schema_derived_from_openapi`` with
      the ``strategy`` used);
    - ``{'parameters': {...}}`` with no ``type``: the inner schema (WARN
      ``unwrapped_parameters_schema``);
    - anything else (non-dict, other ``type``, no ``type`` and nothing above):
      ``(None, reason)``; the caller skips the agent.

    Every unwrapped inner schema goes back through this function, so the
    object-type rules apply to it too. ``agent_id``, when given, is added to
    the WARN lines. Never raises and never mutates ``schema``.
    """
    log = {'name': _name_for_log({'name': agent_name})}
    if agent_id is not None:
        log['agentId'] = str(agent_id)
    if _depth > _MAX_SCHEMA_DEPTH:
        return None, 'schema_too_deeply_nested'
    if isinstance(schema, str):
        try:
            parsed = json.loads(schema)
        except (ValueError, TypeError):
            return None, 'schema_not_dict'
        if not isinstance(parsed, dict):
            return None, 'schema_not_dict'
        _warn('parsed_stringified_schema', **log)
        return to_tool_input_schema(parsed, agent_name, agent_id, _depth + 1)
    if not isinstance(schema, dict):
        return None, 'schema_not_dict'

    def unwrap(inner: Any, action: str, **extra: Any):
        derived, reason = to_tool_input_schema(inner, agent_name, agent_id, _depth + 1)
        if derived is None:
            return None, reason
        _warn(action, **extra, **log)
        return derived, None

    schema_type = schema.get('type')
    # The function wrapper is checked before the type gate: the OpenAI form
    # carries ``type: 'function'`` on the outside.
    function = schema.get('function')
    if isinstance(function, dict) and ('parameters' in function or schema_type is None):
        parameters = function.get('parameters')
        if not isinstance(parameters, (dict, str)):
            return None, 'function_parameters_invalid'
        return unwrap(parameters, 'unwrapped_function_schema')
    if schema_type != 'object':
        for key in _INPUT_SCHEMA_KEYS:
            if isinstance(schema.get(key), (dict, str)):
                return unwrap(schema[key], 'unwrapped_input_schema', key=key)
    if schema_type is not None:
        if schema_type != 'object':
            return None, 'schema_type_not_object'
        return schema, None
    if isinstance(schema.get('properties'), dict):
        _warn('normalised_schema_type', **log)
        return {**schema, 'type': 'object'}, None
    if 'openapi' in schema or 'swagger' in schema or 'paths' in schema:
        derived, strategy = _schema_from_openapi(schema, str(agent_name))
        _warn('schema_derived_from_openapi', strategy=strategy, **log)
        return derived, None
    if isinstance(schema.get('parameters'), (dict, str)):
        return unwrap(schema['parameters'], 'unwrapped_parameters_schema')
    return None, 'schema_type_missing'


def sanitise_tool_name(name: Any):
    """Return ``name`` rewritten to Converse's ``[a-zA-Z0-9_-]{1,64}``.

    Invalid characters become ``_`` and the result is cut to 64 characters.
    Returns ``None`` for a non-string or empty name, which cannot be repaired.
    """
    if not isinstance(name, str) or not name:
        return None
    return _INVALID_TOOL_NAME_CHARS.sub('_', name)[:64]


def resolve_agent_name(agents_config: dict, tool_name: str) -> str:
    """Map a tool name returned by the model back to the agent's own name.

    Dispatch and governance key on ``agent['name']``; the tool name sent to
    Bedrock may be a sanitised form of it. Falls back to ``tool_name`` itself.
    """
    for agent in agents_config.get('agents', []):
        if sanitise_tool_name(agent.get('name')) == tool_name:
            return agent['name']
    return tool_name


def validate_tool_spec(agent: dict):
    """Validate one agent config and build its Converse tool spec.

    The single validation point for tool specs sent to Bedrock. Returns
    ``(spec, None)`` or ``(None, reason)``; a skip is logged as WARN
    ``skip_invalid_tool_schema`` (agentId, name, reason). Never raises and
    never mutates ``agent``.

    The schema goes through ``to_tool_input_schema``. The tool name is
    sanitised to Converse's pattern (WARN ``tool_name_sanitised`` when it
    changes); ``resolve_agent_name`` maps the model's tool name back to the
    agent's own name at dispatch, so governance still keys on the original.
    """
    name = agent.get('name')
    tool_name = sanitise_tool_name(name)
    if tool_name is None:
        schema, reason = None, 'invalid_tool_name'
    else:
        schema, reason = to_tool_input_schema(
            parse_decimals(agent['schema']), name, _agent_id_for_log(agent)
        )
    if reason is not None:
        _warn(
            'skip_invalid_tool_schema',
            agentId=_agent_id_for_log(agent),
            name=_name_for_log(agent),
            reason=reason,
        )
        return None, reason

    if tool_name != name:
        _warn(
            'tool_name_sanitised',
            agentId=_agent_id_for_log(agent),
            name=name,
            toolName=tool_name,
        )
    description = agent['description']
    if not isinstance(description, str) or not description.strip():
        _warn(
            'description_fallback',
            agentId=_agent_id_for_log(agent),
            name=name,
        )
        description = tool_name
    return {
        "toolSpec": {
            "name": tool_name,
            "description": description,
            "inputSchema": {"json": schema},
        }
    }, None


def create_agent_specs(agents_config, skipped=None):
    """Build Converse tool specs, skipping (never failing on) invalid agents.

    ``skipped``, when given a list, receives one reason string per skipped
    agent so the caller can report counts.
    """
    specs = []
    # tool name -> whether it came from a sanitised agent name
    seen_tool_names = {}
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
            if skipped is not None:
                skipped.append('missing_fields')
            continue
        spec, reason = validate_tool_spec(agent)
        if spec is None:
            if skipped is not None:
                skipped.append(reason)
            continue
        tool_name = spec["toolSpec"]["name"]
        was_sanitised = tool_name != agent["name"]
        if tool_name in seen_tool_names and (was_sanitised or seen_tool_names[tool_name]):
            # Converse rejects duplicate tool names; sanitising can create
            # them. Duplicates among already-valid names are left as before.
            _warn(
                'skip_invalid_tool_schema',
                agentId=_agent_id_for_log(agent),
                name=_name_for_log(agent),
                reason='duplicate_tool_name',
            )
            if skipped is not None:
                skipped.append('duplicate_tool_name')
            continue
        seen_tool_names.setdefault(tool_name, was_sanitised)
        specs.append(spec)
    return specs
