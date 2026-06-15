
import json
import os
import subprocess
import sys
import boto3

from worker_governance import (
    apply_step_constraints,
    apply_tool_restrictions,
    apply_system_prompt_addition,
    build_subprocess_env,
    get_blocked_tools,
)

# QT3-6: dispatch-time defence-in-depth for the code-generating
# tool / ExecutionSpecification binding rule. We depend on the rule predicate
# ``is_code_generating`` and the status checker ``assert_spec_approved`` from
# the fabricator's ``tools_config`` module so that worker dispatch and
# fabricator manifest validation stay in lockstep — do NOT duplicate the rule.
#
# Import strategy: try at module load (fast-fail in tests where
# ``arbiter/conftest.py`` adds ``fabricator/`` to ``sys.path``), but fall back
# to a lazy import inside the dispatch path. In Lambda the bundling currently
# ships only ``arbiter/workerWrapper/``; a follow-up deployment task (tracked
#) must either:
# (a) copy ``tools_config.py`` into the worker bundle at build time, or
# (b) extract the governance predicates into a shared ``arbiter/shared/``
# layer consumed by both Lambdas.
# Until then this import succeeds in unit tests (sys.path wired by conftest)
# and the lazy fallback below is used in Lambda. When the bundle wiring lands
# the top-level import will cover both paths with no code change.
try:
    from tools_config import is_code_generating # noqa: E402
except ImportError: # pragma: no cover — Lambda bundle path before follow-up
    is_code_generating = None # type: ignore[assignment]

CONFIG_TABLE = os.environ.get('AGENT_CONFIG_TABLE')
TOOLS_CONFIG_TABLE = os.environ.get('TOOLS_CONFIG_TABLE')
EXECUTION_SPECS_TABLE = os.environ.get('EXECUTION_SPECS_TABLE')
CREDENTIAL_VENDER_FUNCTION = os.environ.get('CREDENTIAL_VENDER_FUNCTION')
AGENT_RUNNER_PATH = os.path.join(os.path.dirname(__file__), 'agent_runner.py')

# QB-013-1: lazy boto3 client construction. Keeps the module importable
# without AWS credentials in the local dev env. Matches the pattern used
# by arbiter/governance/ledger.py and arbiter/fabricator/tools_config.py.
# Previously `dynamodb = boto3.resource('dynamodb')` and
# `lambda_client = boto3.client('lambda')` ran at import time and triggered
# credential resolution, which made pytest collection fail on dev machines
# with expired credentials.
_dynamodb = None
_lambda_client = None

def _get_dynamodb():
    """Lazily construct the boto3 DynamoDB resource. Cached per process."""
    global _dynamodb
    if _dynamodb is None:
        _dynamodb = boto3.resource('dynamodb')
    return _dynamodb

def _get_lambda_client():
    """Lazily construct the boto3 Lambda client. Cached per process."""
    global _lambda_client
    if _lambda_client is None:
        _lambda_client = boto3.client('lambda')
    return _lambda_client

def __reset_boto3_clients_for_test() -> None:
    """Test-only: clear cached boto3 clients so mocks can bind fresh."""
    global _dynamodb, _lambda_client
    _dynamodb = None
    _lambda_client = None

class SpecificationNotBoundError(Exception):
    """Raised at worker dispatch when a code-generating tool is invoked without
    a bound spec_id referencing an APPROVED ExecutionSpecification.

    QT3-6 — dispatch-time defence-in-depth. The fabricator raises
    a FabricationError at manifest validation time; this worker-side exception
    is the equivalent dispatch-time failure mode (Requirement 5.8).
    """

def assert_tool_spec_binding(tool_config: dict, spec_id: str | None) -> None:
    """Dispatch-time enforcement mirroring fabricator's validate_code_tool_binding.

    Delegates the rule decision to ``tools_config.is_code_generating`` so both
    sides stay in lockstep (QT3-6). Raises ``SpecificationNotBoundError`` on
    violation. A non-code-generating tool is always allowed. A malformed
    ``outputs`` value falls through as a ``ValueError`` from ``is_code_generating``
    — intentional: malformed manifests should fail loudly at dispatch.

    If ``tools_config`` is unavailable (module-load import miss — see deployment
    note at the top of this file), we attempt a lazy re-import here. If it is
    still unavailable, we fail closed: a missing governance predicate must
    never silently allow a code-generating tool through dispatch. The error
    surface is ``SpecificationNotBoundError`` to keep the caller contract
    uniform.
    """
    predicate = is_code_generating
    if predicate is None:
        try:
            from tools_config import is_code_generating as predicate # noqa: WPS433
        except ImportError as exc: # pragma: no cover — deployment misconfig
            raise SpecificationNotBoundError(
                "Governance predicate 'is_code_generating' is unavailable; "
                "refusing to dispatch tool "
                f"'{tool_config.get('name', '<unknown>')}'. "
                "Deployment bundling of arbiter/fabricator/tools_config.py "
                "into the worker Lambda is required (follow-up)."
            ) from exc

    if predicate(tool_config) and not spec_id:
        raise SpecificationNotBoundError(
            f"Tool '{tool_config.get('name', '<unknown>')}' is code-generating "
            "and requires a bound spec_id referencing an APPROVED ExecutionSpecification."
        )

def load_file_from_s3_into_tmp(bucket_name, file_name):
    s3 = boto3.client('s3')
    s3.download_file(bucket_name, f"agents/{file_name}", "/tmp/loaded_module.py")

def load_config_from_dynamodb(agent_name: str):
    print(CONFIG_TABLE)
    table = _get_dynamodb().Table(CONFIG_TABLE)
    response = table.get_item(Key={'agentId': agent_name})
    print(response)
    return response['Item']

def load_tool_configs(tool_ids: list[str], table_name: str) -> list[dict]:
    """Load tool configs via BatchGetItem for minimal latency (Req 10.6).

    Uses a single DynamoDB round-trip instead of individual GetItem calls.
    Missing tool configs are logged and skipped (Req 10.5).
    BatchGetItem supports max 100 keys per call; we chunk accordingly.
    """
    if not tool_ids:
        return []

    results: list[dict] = []
    # BatchGetItem supports max 100 keys per request
    chunk_size = 100
    for i in range(0, len(tool_ids), chunk_size):
        chunk = tool_ids[i:i + chunk_size]
        keys = [{'toolId': {'S': tid}} for tid in chunk]
        try:
            response = boto3.client('dynamodb').batch_get_item(
                RequestItems={
                    table_name: {
                        'Keys': keys,
                    }
                }
            )
            raw_items = response.get('Responses', {}).get(table_name, [])
            # Deserialize DynamoDB items to plain dicts
            deserializer = boto3.dynamodb.types.TypeDeserializer()
            for raw in raw_items:
                item = {k: deserializer.deserialize(v) for k, v in raw.items()}
                results.append(item)

            # Handle unprocessed keys (DynamoDB throttling)
            unprocessed = response.get('UnprocessedKeys', {}).get(table_name)
            if unprocessed:
                print(json.dumps({
                    'level': 'WARN',
                    'component': 'WorkerWrapper',
                    'error': f"BatchGetItem had {len(unprocessed.get('Keys', []))} unprocessed keys",
                    'action': 'degraded',
                }))
        except Exception as e:
            print(json.dumps({
                'level': 'ERROR',
                'component': 'WorkerWrapper',
                'error': f"Failed to load tool configs: {e}",
                'action': 'failed',
            }))
    return results

def aggregate_tool_bindings(tool_configs: list[dict]) -> dict:
    """Aggregate integration and data store IDs from tool bindings.

    Collects unique integrationIds and dataStoreIds from all tool configs'
    bindings. Malformed bindings are caught, logged, and skipped (Req 10.5).

    Returns dict with 'integrations' and 'dataStores' lists of unique IDs.
    """
    integration_ids: set[str] = set()
    datastore_ids: set[str] = set()

    for tool in tool_configs:
        tool_id = tool.get('toolId', 'unknown')

        # Process integration bindings
        try:
            for binding in tool.get('integrationBindings', []):
                if isinstance(binding, dict) and 'integrationId' in binding:
                    integration_ids.add(binding['integrationId'])
                else:
                    print(json.dumps({
                        'level': 'WARN',
                        'component': 'WorkerWrapper',
                        'toolId': tool_id,
                        'error': 'Malformed integration binding: missing integrationId',
                        'action': 'skipped',
                    }))
        except (TypeError, AttributeError) as e:
            print(json.dumps({
                'level': 'WARN',
                'component': 'WorkerWrapper',
                'toolId': tool_id,
                'error': f'Invalid integrationBindings format: {e}',
                'action': 'skipped',
            }))

        # Process data store bindings
        try:
            for binding in tool.get('dataStoreBindings', []):
                if isinstance(binding, dict) and 'dataStoreId' in binding:
                    datastore_ids.add(binding['dataStoreId'])
                else:
                    print(json.dumps({
                        'level': 'WARN',
                        'component': 'WorkerWrapper',
                        'toolId': tool_id,
                        'error': 'Malformed data store binding: missing dataStoreId',
                        'action': 'skipped',
                    }))
        except (TypeError, AttributeError) as e:
            print(json.dumps({
                'level': 'WARN',
                'component': 'WorkerWrapper',
                'toolId': tool_id,
                'error': f'Invalid dataStoreBindings format: {e}',
                'action': 'skipped',
            }))

    return {
        'integrations': list(integration_ids),
        'dataStores': list(datastore_ids),
    }

def _merge_required_permissions(agent_permissions: dict | None, tool_bindings: dict) -> dict:
    """Merge agent-level requiredPermissions with tool-level binding IDs.

    Agent-level permissions may already contain 'integrations' and 'dataStores'
    arrays. Tool-level bindings add additional IDs from tool configs.
    The result is a union of both sets for each category.
    """
    merged = {}
    if agent_permissions:
        merged = dict(agent_permissions)

    # Merge integration IDs
    existing_integrations = set(merged.get('integrations', []))
    existing_integrations.update(tool_bindings.get('integrations', []))
    if existing_integrations:
        merged['integrations'] = list(existing_integrations)

    # Merge data store IDs
    existing_datastores = set(merged.get('dataStores', []))
    existing_datastores.update(tool_bindings.get('dataStores', []))
    if existing_datastores:
        merged['dataStores'] = list(existing_datastores)

    return merged if merged else None

def get_scoped_credentials(agent_name: str, required_permissions: dict, app_id: str | None = None) -> dict | None:
    """
    Invoke the credential vender Lambda to get scoped IAM credentials
    for this agent based on its declared permissions.
    When app_id is provided, the credential vender uses the app-scoped IAM role
    (citadel-agent-{appId}) instead of the agent-level role (Req 4 AC 5).
    """
    if not CREDENTIAL_VENDER_FUNCTION:
        print("CREDENTIAL_VENDER_FUNCTION not set, skipping credential vending")
        return None

    if not required_permissions:
        return None

    try:
        payload_data = {
            'agentId': agent_name,
            'requiredPermissions': required_permissions,
        }
        if app_id:
            payload_data['appId'] = app_id
            payload_data['scope'] = 'agent'

        response = _get_lambda_client().invoke(
            FunctionName=CREDENTIAL_VENDER_FUNCTION,
            InvocationType='RequestResponse',
            Payload=json.dumps(payload_data),
        )
        payload = json.loads(response['Payload'].read())
        print(f"Credential vender response: {json.dumps({k: v for k, v in payload.items() if k!= 'credentials'})}")

        if payload.get('error'):
            print(f"Credential vender error: {payload['error']}")
            return None

        return payload.get('credentials')
    except Exception as e:
        print(f"Failed to invoke credential vender: {e}")
        return None

def run_agent_in_subprocess(request: dict, scoped_credentials: dict | None, extra_env: dict | None = None) -> str:
    """
    Execute the agent code in an isolated subprocess.

    Scoped credentials are passed only to the child process's environment,
    never set on the parent's os.environ. This prevents:
    - The agent code from reading the parent Lambda's ambient credentials
    - Credential leakage between sequential agent executions
    - Credentials persisting in /proc/self/environ of the parent
    """
    # Build the child's environment: inherit parent env for Python path etc.,
    # but override AWS credentials with scoped ones if available
    child_env = os.environ.copy()

    if scoped_credentials:
        child_env['AWS_ACCESS_KEY_ID'] = scoped_credentials['accessKeyId']
        child_env['AWS_SECRET_ACCESS_KEY'] = scoped_credentials['secretAccessKey']
        child_env['AWS_SESSION_TOKEN'] = scoped_credentials['sessionToken']
        print("Subprocess will use scoped credentials")
    else:
        # Remove any stale credential env vars so the child uses the
        # Lambda's default IAM role via the metadata service
        for key in ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']:
            child_env.pop(key, None)

    # Apply governance and config overrides (stepConstraints, appConfig, modelOverride)
    if extra_env:
        child_env.update(extra_env)

    # Prepare the payload for the runner script
    runner_input = json.dumps({
        'modulePath': '/tmp/loaded_module.py',
        'request': request,
    })

    result = subprocess.run(
        [sys.executable, AGENT_RUNNER_PATH],
        input=runner_input,
        capture_output=True,
        text=True,
        timeout=840, # 14 minutes (Lambda timeout is 15)
        env=child_env,
    )

    # Log stderr from the child (agent print statements, errors)
    if result.stderr:
        print(f"[agent stderr] {result.stderr}")

    if result.returncode!= 0:
        print(f"Agent subprocess exited with code {result.returncode}")
        return "The task could not be completed, this agent has issues, please ignore for now."

    # Parse the response from stdout
    try:
        output = json.loads(result.stdout.strip())
        return output.get('response', result.stdout.strip())
    except json.JSONDecodeError:
        return result.stdout.strip() or "Agent produced no output"

def post_task_complete(response, agent_use_id, agent_name, orchestration_id):
    client = boto3.client('events')

    COMPLETION_BUS_NAME = os.environ.get('COMPLETION_BUS_NAME')
    event = {
        'Source': 'task.completion',
        'DetailType': 'task.completion',
        'EventBusName': COMPLETION_BUS_NAME,
        'Detail': json.dumps({
            'orchestration_id': orchestration_id,
            'data': f"Task completed, details: {response}",
            'agent_use_id': agent_use_id,
            'node': agent_name
        })
    }
    print(f"posting event, {json.dumps(event)}")
    response = client.put_events(Entries=[event])
    print(f"event posted: {response}")
    return f"event posted: {event}"

def process_event(event, context):
    print("processing...")
    orchestration_id = event["orchestration_id"]
    agent_use_id = event["agent_use_id"]
    request = event["agent_input"]
    agent_name = event['node']

    # Extract governance and override fields from event payload
    step_constraints = event.get('stepConstraints')
    app_config = event.get('appConfig')
    tool_restrictions = event.get('toolRestrictions', [])
    model_override = event.get('modelOverride')
    system_prompt_addition = event.get('systemPromptAddition')
    app_id = event.get('appId') # App-scoped credential vending (Req 4 AC 5)

    agent = load_config_from_dynamodb(agent_name)
    config = agent['config']

    if isinstance(config, str):
        config = json.loads(config)

    # Apply step constraints tool filtering (Req 13.2)
    tool_ids = config.get('tools', [])
    blocked_tools = get_blocked_tools(tool_ids, step_constraints)
    tool_ids = apply_step_constraints(tool_ids, step_constraints)

    # Log governance enforcement: blocked tools (Req 13 AC 7)
    if blocked_tools:
        print(json.dumps({
            'level': 'WARN',
            'component': 'Governance',
            'action': 'tools_blocked',
            'agentId': agent_name,
            'blockedTools': blocked_tools,
            'allowedTools': list(step_constraints.get('allowedTools', [])) if step_constraints else [],
            'executionId': orchestration_id,
        }))

    # Apply agent binding tool restrictions (Req 3.6)
    tool_ids = apply_tool_restrictions(tool_ids, tool_restrictions)
    config['tools'] = tool_ids

    # Apply system prompt addition from binding (Req 3.6)
    if system_prompt_addition:
        config['description'] = apply_system_prompt_addition(
            config.get('description', ''), system_prompt_addition
        )

    # Log governance enforcement: max iterations (Req 13 AC 7)
    max_iterations_val = step_constraints.get('maxIterations') if step_constraints else None
    if max_iterations_val:
        print(json.dumps({
            'level': 'WARN',
            'component': 'Governance',
            'action': 'max_iterations_enforced',
            'agentId': agent_name,
            'maxIterations': max_iterations_val,
            'executionId': orchestration_id,
        }))

    # Get agent-level required permissions
    required_permissions = config.get('requiredPermissions')

    # Aggregate tool-level bindings into requiredPermissions (Req 2.1, 2.5)
    # Short-circuit: skip tool config loading when agent has no tools (Req 10.7)
    tool_ids = config.get('tools', [])
    if tool_ids and TOOLS_CONFIG_TABLE:
        print(f"Loading tool configs for {len(tool_ids)} tools...")
        tool_configs = load_tool_configs(tool_ids, TOOLS_CONFIG_TABLE)

        # Log missing tool configs (Req 10.5)
        loaded_tool_ids = {tc.get('toolId') for tc in tool_configs}
        for tid in tool_ids:
            if tid not in loaded_tool_ids:
                print(json.dumps({
                    'level': 'WARN',
                    'component': 'WorkerWrapper',
                    'agentId': agent_name,
                    'toolId': tid,
                    'error': 'Tool config not found in DynamoDB',
                    'action': 'skipped',
                }))

        # QT3-6: dispatch-time defence-in-depth check.
        # Before aggregating bindings or vending credentials, reject any
        # code-generating tool that lacks a spec_id binding. Accept either
        # snake_case ``spec_id`` (direct worker callers) or camelCase
        # ``specId`` (AppSync-originated events).
        #
        # Two-tier enforcement:
        # 1) Pure binding check (always on): raises SpecificationNotBoundError
        # if a code-generating tool has no spec_id. This mirrors the
        # fabricator's validate_code_tool_binding using the SAME predicate
        # (is_code_generating) to guarantee consistency.
        # 2) DDB-backed status check (opt-in, EXECUTION_SPECS_TABLE set):
        # when a spec_id is present, call assert_spec_approved to verify
        # the spec exists and is in the APPROVED terminal state. This is
        # best-effort and degrades gracefully in environments where the
        # env var is not plumbed (e.g. unit tests). AC 2 of.
        bound_spec_id = event.get('spec_id') or event.get('specId') \
            or request.get('spec_id') or request.get('specId')
        for tool_cfg in tool_configs:
            assert_tool_spec_binding(tool_cfg, bound_spec_id)

        if bound_spec_id and EXECUTION_SPECS_TABLE:
            # Lazy import: avoid coupling every worker caller to the
            # fabricator's DDB-dependent assert_spec_approved unless we
            # actually need it at this dispatch.
            try:
                from tools_config import assert_spec_approved # noqa: WPS433
                assert_spec_approved(
                    bound_spec_id, table_name=EXECUTION_SPECS_TABLE
                )
            except SpecificationNotBoundError:
                # Already the correct surface — re-raise.
                raise
            except Exception as spec_err:
                # Normalize any FabricationError / boto3 / validation error
                # into the worker's dispatch-side exception so callers see a
                # consistent failure mode (Req 5.8).
                raise SpecificationNotBoundError(
                    f"ExecutionSpecification '{bound_spec_id}' is not APPROVED "
                    f"or cannot be resolved: {spec_err}"
                ) from spec_err

        tool_bindings = aggregate_tool_bindings(tool_configs)

        # Merge tool-level bindings with agent-level permissions
        if tool_bindings.get('integrations') or tool_bindings.get('dataStores'):
            required_permissions = _merge_required_permissions(
                required_permissions, tool_bindings
            )
            print(f"Merged requiredPermissions with tool bindings: "
                  f"{len(tool_bindings.get('integrations', []))} integrations, "
                  f"{len(tool_bindings.get('dataStores', []))} dataStores")

    # Vend scoped credentials based on merged permissions
    # When appId is present, use app-scoped IAM role (Req 4 AC 5)
    # Eventual consistency: binding updates are picked up on next invocation (Req 10.8)
    scoped_credentials = get_scoped_credentials(agent_name, required_permissions, app_id=app_id)

    fileName = config['filename']
    print("loading file from s3...")
    load_file_from_s3_into_tmp(os.environ["AGENT_BUCKET_NAME"], fileName)

    # Build extra env vars for governance and config overrides
    max_iterations = step_constraints.get('maxIterations') if step_constraints else None

    # US-ARB-012a QD-5 layer-2 wiring: compute the denied-tool set that the
    # subprocess ``GovernedToolHandler`` will enforce at tool-call time.
    # Union of tools blocked by stepConstraints.allowedTools (layer-1
    # filtered) and binding toolRestrictions (layer-1 filtered). Layer-1
    # already stripped these from ``tools[]`` before dispatch, so layer-2
    # acts as defence-in-depth: even if a tool slips past layer 1 (e.g.
    # dynamic tool construction inside the agent) layer 2 denies at
    # preprocess time and writes a distinct 'worker-tool-handler' finding.
    # QD-5 mandates the two layers stay independent — findings MUST NOT
    # be deduplicated across scopes.
    denied_tools_set = set(blocked_tools)
    if tool_restrictions:
        denied_tools_set.update(tool_restrictions)

    extra_env = build_subprocess_env(
        {},
        app_config,
        model_override,
        max_iterations,
        agent_id=agent_name,
        workflow_id=orchestration_id,
        denied_tools=sorted(denied_tools_set) if denied_tools_set else None,
    )

    print("running agent in isolated subprocess...")
    response = run_agent_in_subprocess(request, scoped_credentials, extra_env if extra_env else None)
    print(f"agent response: {response}")

    post_task_complete(response, agent_use_id, agent_name, orchestration_id)

def lambda_handler(event, context):
    print(f"processing event {event}")
    batch_item_failures = []

    for record in event['Records']:
        try:
            message_body = json.loads(record['body'])
            print(f"Processing message: {record['messageId']}")
            process_event(message_body, context)
            print(f"Successfully processed message: {record['messageId']}")
        except Exception as e:
            print(f"Error processing message {record['messageId']}: {e}")
            batch_item_failures.append({"itemIdentifier": record['messageId']})

    return {"batchItemFailures": batch_item_failures}

if __name__ == "__main__":
    lambda_handler({'Records': []}, {})
