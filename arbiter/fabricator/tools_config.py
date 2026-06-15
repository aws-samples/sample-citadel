from decimal import Decimal
import os
from typing import Any
import boto3

CONFIG_TABLE = os.environ.get('TOOL_CONFIG_TABLE')

# QB-013-1: lazy boto3 resource construction. The previous module-level
# `dynamodb = boto3.resource('dynamodb')` triggered credential resolution at
# import time, which caused pytest collection to fail on dev machines with
# expired AWS credentials (see arbiter/governance/ledger.py for the same
# pattern).
_dynamodb = None

def _get_dynamodb():
    """Lazily construct the boto3 DynamoDB resource. Cached per process."""
    global _dynamodb
    if _dynamodb is None:
        _dynamodb = boto3.resource('dynamodb')
    return _dynamodb

def __reset_boto3_clients_for_test() -> None:
    """Test-only: clear the cached boto3 resource so mocks can bind fresh."""
    global _dynamodb
    _dynamodb = None

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
    table = _get_dynamodb().Table(CONFIG_TABLE)
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

# ---------------------------------------------------------------------------
# QT2A-4 — Capability rule: code-generating tools must bind to an
# approved ExecutionSpecification before fabrication or dispatch.
#
# This section is a pure-Python rule module. No boto3 at import time; the
# DynamoDB lookup in `assert_spec_approved` uses an injected resource or lazy-
# imports the module-level client. The same `is_code_generating` helper is
# re-used by the dispatch-time check in arbiter/workerWrapper/index.py so the
# fabrication-time and runtime checks cannot drift (QT3-6 defence-in-depth).
# ---------------------------------------------------------------------------

class FabricationError(Exception):
    """Raised by the Fabricator when a tool manifest violates the capability
    rule (QT2A-4)."""

def is_code_generating(tool_manifest: dict) -> bool:
    """Return True iff the tool manifest declares code-generating outputs.

    Rule (QT2A-4 + R4 conservative default):
      - `outputs` missing entirely → True (conservative default)
      - `outputs` is a list containing the literal string 'code' → True
      - `outputs` is an empty list or a list without 'code' → False
      - `outputs` present but not a list → ValueError (malformed manifest)

    This function is pure — no I/O, safe in hot paths.
    """
    if "outputs" not in tool_manifest:
        # R4: absence of the field is treated as code-generating so that a
        # malformed or legacy manifest cannot silently bypass the binding rule.
        return True

    outputs = tool_manifest["outputs"]
    if not isinstance(outputs, list):
        raise ValueError(
            "tool manifest 'outputs' must be a list; got "
            f"{type(outputs).__name__}"
        )

    # Case-sensitive membership check — the governance rule fixes the token.
    return "code" in outputs

def validate_code_tool_binding(
    tool_manifest: dict, spec_id: str | None
) -> None:
    """Enforce the capability rule at fabrication time.

    If `is_code_generating(tool_manifest)` is True, `spec_id` MUST be a
    non-empty string. A non-code-generating manifest is allowed either with
    or without a spec_id.

    Raises:
        FabricationError: on violation.
        ValueError: if the manifest's `outputs` field is malformed (bubbles
            up from `is_code_generating`).
    """
    if not is_code_generating(tool_manifest):
        return

    if spec_id is None or spec_id == "":
        # Use the manifest name (already non-sensitive) in the message.
        # Do NOT echo user-controlled spec_id here.
        name = tool_manifest.get("name", "<unnamed>")
        raise FabricationError(
            f"tool '{name}' is code-generating and must be bound to an "
            "approved ExecutionSpecification (spec_id is required)"
        )

def assert_spec_approved(
    spec_id: str,
    *,
    table_name: str | None = None,
    ddb_resource=None,
) -> None:
    """Verify that `spec_id` resolves to an APPROVED row in the
    ExecutionSpecifications DynamoDB table.

    Args:
        spec_id: The specification identifier.
        table_name: Override for the EXECUTION_SPECS_TABLE env var.
        ddb_resource: Injected boto3 resource for test stubbing; defaults to
            the lazily-constructed module-level resource only if None.

    Raises:
        FabricationError: row missing, or `status!= 'APPROVED'`, or the
            table name cannot be resolved.
    """
    resolved_table = table_name or os.environ.get("EXECUTION_SPECS_TABLE")
    if not resolved_table:
        raise FabricationError(
            "EXECUTION_SPECS_TABLE is not configured; cannot verify spec"
        )

    resource = ddb_resource if ddb_resource is not None else _get_dynamodb()
    table = resource.Table(resolved_table)

    response = table.get_item(Key={"specId": spec_id})
    item = response.get("Item") if response else None
    if not item:
        raise FabricationError("spec not found")

    status = item.get("status")
    if status!= "APPROVED":
        raise FabricationError(
            f"spec {spec_id} is not APPROVED (status={status})"
        )

def audit_tool_manifests(manifests: list[dict], *, output_path: str) -> str:
    """Emit a CSV audit of tool manifests' `outputs` declarations.

    Columns: name, has_outputs_field, outputs_value, is_code_generating,
    requires_spec_id. Rows are sorted by `name` for deterministic output.

    The parent directory of `output_path` is created if it does not exist.

    Returns the absolute path written.
    """
    import csv # stdlib; local import keeps module import cost minimal

    abs_path = os.path.abspath(output_path)
    parent = os.path.dirname(abs_path)
    if parent:
        os.makedirs(parent, exist_ok=True)

    rows: list[dict[str, str]] = []
    for manifest in manifests:
        name = str(manifest.get("name", ""))
        has_outputs = "outputs" in manifest
        outputs_value = manifest.get("outputs") if has_outputs else None
        code_gen = is_code_generating(manifest)
        rows.append(
            {
                "name": name,
                "has_outputs_field": str(has_outputs),
                "outputs_value": "" if outputs_value is None else repr(
                    outputs_value
                ),
                "is_code_generating": str(code_gen),
                "requires_spec_id": str(code_gen),
            }
        )

    rows.sort(key=lambda r: r["name"])

    fieldnames = [
        "name",
        "has_outputs_field",
        "outputs_value",
        "is_code_generating",
        "requires_spec_id",
    ]
    with open(abs_path, "w", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    return abs_path

# ============ Archetype templates ============
#
# L2 archetype template loader. The set of archetypes is
# frozen-at-three (QT2A-8): any value outside `_VALID_ARCHETYPES` raises
# `ArchetypeNotFoundError`. Templates live on disk under
# `arbiter/fabricator/templates/{archetype_dir}/` and are read lazily so
# importing this module has no filesystem cost.
# ---------------------------------------------------------------------------

class ArchetypeNotFoundError(Exception):
    """Raised when load_archetype_template is called with an archetype value
    outside the frozen-at-three enum (QT2A-8).
    """

# Frozen list per QT2A-8 — anything outside this triggers ArchetypeNotFoundError.
_VALID_ARCHETYPES = frozenset({
    'MONOLITHIC_DB',
    'ENTERPRISE_APP_SPRAWL',
    'HYBRID_IT_OT',
})

_ARCHETYPE_DIR_MAP = {
    'MONOLITHIC_DB': 'monolithic_db',
    'ENTERPRISE_APP_SPRAWL': 'enterprise_app_sprawl',
    'HYBRID_IT_OT': 'hybrid_it_ot',
}

def load_archetype_template(archetype: str, *, templates_root: str | None = None) -> dict:
    """Load the L2 archetype template for a governance archetype.

    Reads from `arbiter/fabricator/templates/{archetype_dir}/` where
    archetype_dir is the lowercase snake_case equivalent of the enum value.

    Args:
        archetype: One of MONOLITHIC_DB / ENTERPRISE_APP_SPRAWL / HYBRID_IT_OT.
            Anything else raises ArchetypeNotFoundError (QT2A-8 frozen-at-three).
        templates_root: Override for the templates directory root (test-only).
            Defaults to `<package_dir>/templates`.

    Returns:
        dict with keys:
          - 'archetype': the input archetype value (for traceability)
          - 'system_prompt': raw contents of system_prompt.md as str
          - 'agent_suite': parsed list from investigation_agent_suite.yaml's
            'agents' key (empty list acceptable per placeholder)
          - 'metadata': parsed dict from the YAML's 'metadata' key (empty dict
            acceptable)
          - 'readme_path': absolute path to README.md (callers that want to
            show the source citation can read this file lazily)

    Raises:
        ArchetypeNotFoundError: archetype not in the frozen enum.
        FileNotFoundError: directory exists in the enum but files are missing
          on disk (should only happen in a broken checkout).
    """
    if archetype not in _VALID_ARCHETYPES:
        raise ArchetypeNotFoundError(
            f"Unknown archetype: {archetype!r}. "
            f"Valid values: {sorted(_VALID_ARCHETYPES)}"
        )

    if templates_root is None:
        # Resolve relative to this module's file location so the function
        # works from both Lambda (flattened asset bundle) and dev checkout.
        templates_root = os.path.join(os.path.dirname(__file__), 'templates')

    archetype_dir = os.path.join(templates_root, _ARCHETYPE_DIR_MAP[archetype])

    system_prompt_path = os.path.join(archetype_dir, 'system_prompt.md')
    suite_path = os.path.join(archetype_dir, 'investigation_agent_suite.yaml')
    readme_path = os.path.join(archetype_dir, 'README.md')

    with open(system_prompt_path, 'r', encoding='utf-8') as f:
        system_prompt = f.read()

    with open(suite_path, 'r', encoding='utf-8') as f:
        # Lazy-import yaml so the module stays importable in environments
        # without PyYAML (the loader is a cold-path function).
        import yaml # noqa: PLC0415 — lazy import is intentional
        suite_doc = yaml.safe_load(f) or {}

    agent_suite = suite_doc.get('agents') or []
    metadata = suite_doc.get('metadata') or {}

    return {
        'archetype': archetype,
        'system_prompt': system_prompt,
        'agent_suite': agent_suite,
        'metadata': metadata,
        'readme_path': readme_path,
    }
