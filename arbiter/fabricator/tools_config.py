from decimal import Decimal
import os
from typing import Any
import boto3

CONFIG_TABLE = os.environ.get('TOOL_CONFIG_TABLE')
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



def load_config_from_dynamodb():
    if CONFIG_TABLE is None:
        print("Warning: TOOL_CONFIG_TABLE environment variable not set, returning empty tools list")
        return {'tools': []}
    
    print(f"Loading tools from table: {CONFIG_TABLE}")
    table = dynamodb.Table(CONFIG_TABLE)
    response = table.scan()
    items = response['Items']
    configs = []
    for item in items:
        # Only load agents with state 'active'
        if item.get('state') == 'active':
            configs.append(item['config'])
    print(f"Loaded {len(configs)} active tools")
    print(configs)
    return {'tools': configs}


def create_tool_specs(tools_config):
    return [{
        "toolSpec": {
            "name": tool["name"],
            "description": tool["description"],
            "inputSchema": {"json": parse_decimals(tool["schema"])}
        }
    } for tool in tools_config.get("tools", [])]


def create_tool_desc(tools_config):
    return [
        f"{tool['name']} | {tool['description']}"
        for tool in tools_config.get("tools", [])
    ]


# Directional code generation instructions for the Fabricator system prompt.
# When generating tool code, the Fabricator uses these instructions to produce
# code that respects the declared binding direction.
DIRECTION_INSTRUCTIONS = {
    "input": (
        "This binding has direction 'input'. Generate read-only code for this resource. "
        "The tool should ONLY read data from this resource and MUST NOT write, update, or delete data."
    ),
    "output": (
        "This binding has direction 'output'. Generate write-only code for this resource. "
        "The tool should ONLY write data to this resource and MUST NOT read or query data."
    ),
    "bidirectional": (
        "This binding has direction 'bidirectional'. Generate code that both reads from "
        "and writes to this resource as needed."
    ),
}


def get_direction_instruction(direction: str) -> str:
    """Return the Fabricator code generation instruction for a binding direction."""
    return DIRECTION_INSTRUCTIONS.get(
        direction, DIRECTION_INSTRUCTIONS["bidirectional"]
    )


def build_binding_prompt_section(bindings: list, binding_type: str) -> str:
    """Build a prompt section describing bindings with their directional instructions.

    Args:
        bindings: List of binding dicts (integration or data store).
        binding_type: Either 'integration' or 'dataStore'.

    Returns:
        A string section for the Fabricator system prompt, or empty string if
        no bindings are provided.
    """
    if not bindings:
        return ""

    lines = []
    for binding in bindings:
        direction = binding.get("direction", "bidirectional")
        if binding_type == "integration":
            resource_id = binding.get("integrationId", "unknown")
            resource_type = binding.get("integrationType", "unknown")
        else:
            resource_id = binding.get("dataStoreId", "unknown")
            resource_type = binding.get("dataStoreType", "unknown")

        operations = binding.get("operations") or []
        ops_str = ", ".join(operations) if operations else "all available"
        instruction = get_direction_instruction(direction)
        lines.append(
            f"- {binding_type} '{resource_id}' (type: {resource_type}, "
            f"operations: {ops_str}): {instruction}"
        )

    return "\n".join(lines)