
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
import boto3
from botocore.exceptions import ClientError

# Tracing foundation (architect task 5459301e-1e7b-4bfd-bccb-b106aba2748c):
# import BEFORE any boto3 client is constructed below so patch_all()
# instruments botocore ahead of client creation. Same deferred-bundling
# situation as workflow_contract/common.usage below — the worker Lambda
# bundle currently ships only arbiter/workerWrapper/. A missing import
# must NOT break dispatch: tracing is best-effort, never required.
try:
    from common.tracing import annotate_from_carried, extract_carried  # noqa: E402 — import activates tracing as a side effect
except ImportError: # pragma: no cover — Lambda bundle path before follow-up
    def annotate_from_carried(carried): # type: ignore[no-redef]
        pass

    def extract_carried(detail): # type: ignore[no-redef]
        return None

from worker_governance import (
    apply_step_constraints,
    apply_tool_restrictions,
    apply_system_prompt_addition,
    build_subprocess_env,
    get_blocked_tools,
)

# Shared workflow node dispatch/result contract (source of truth co-owned with
# the step runner). Imported defensively: a workflow-node message only appears
# once the step runner's dispatch path is live, and the shared module is
# bundled into this Lambda by the same deployment change. Until that bundling
# lands, a missing import must NOT break the supervisor task path — so we fall
# back to None and treat every message as a supervisor task (see process_event).
try:
    from common import workflow_contract # noqa: E402
except ImportError: # pragma: no cover — Lambda bundle path before follow-up
    workflow_contract = None # type: ignore[assignment]

# Shared usage-record boundary sanitizer (same deferred-bundling situation as
# workflow_contract above — the worker Lambda bundle currently ships only
# arbiter/workerWrapper/). A missing import must NOT break dispatch: fall
# back to an inline mirror with the same never-raises contract.
try:
    from common.usage import parse_usage_array # noqa: E402
except ImportError: # pragma: no cover — Lambda bundle path before follow-up
    def parse_usage_array(raw): # type: ignore[no-redef]
        try:
            if not isinstance(raw, list):
                return []
            return [entry for entry in raw if isinstance(entry, dict)]
        except Exception: # noqa: BLE001 — boundary sanitizer must never raise
            return []

# aggregate_usage: same deferred-bundling fallback contract. Used by the
# write-then-signal node-completion persist to record per-node usageTotals in
# the SAME shape the stepRunner writes, so the persisted node is identical
# regardless of which writer wins first-write-wins.
try:
    from common.usage import aggregate_usage # noqa: E402
except ImportError: # pragma: no cover — Lambda bundle path before follow-up
    def aggregate_usage(records): # type: ignore[no-redef]
        totals = {'inputTokens': 0, 'outputTokens': 0, 'totalTokens': 0, 'callCount': 0}
        try:
            for entry in records or []:
                if not isinstance(entry, dict):
                    continue
                i = int(entry.get('inputTokens', 0) or 0)
                o = int(entry.get('outputTokens', 0) or 0)
                totals['inputTokens'] += i
                totals['outputTokens'] += o
                totals['totalTokens'] += i + o
                totals['callCount'] += 1
        except Exception: # noqa: BLE001 — boundary sanitizer must never raise
            return {'inputTokens': 0, 'outputTokens': 0, 'totalTokens': 0, 'callCount': 0}
        return totals

# Shared CloudWatch metric constants (same deferred-bundling situation as
# workflow_contract/common.usage above). A missing import must NOT break
# dispatch: fall back to inline literals matching the shared contract module
# exactly — kept in lockstep by common/__tests__/test_metrics_constants.py.
try:
    from common.metrics_constants import ( # noqa: E402
        METRIC_NAMESPACE,
        METRIC_NODE_COLD_START,
        UNIT_COUNT,
        DIMENSION_AGENT_ID,
    )
except ImportError: # pragma: no cover — Lambda bundle path before follow-up
    METRIC_NAMESPACE = 'Citadel/Workflows' # type: ignore[assignment]
    METRIC_NODE_COLD_START = 'NodeColdStart' # type: ignore[assignment]
    UNIT_COUNT = 'Count' # type: ignore[assignment]
    DIMENSION_AGENT_ID = 'AgentId' # type: ignore[assignment]

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

# Structural agent-body failure marker (finding 56d763d4). Imported from
# agent_runner (the PRODUCER of the envelope) so producer and consumer stay in
# lockstep. Defensive fallback to the literal keeps the consumer working even
# if the co-bundled module can't be imported (mirrors this file's
# deferred-bundling pattern); a parity test pins the fallback to agent_runner's
# constant.
try:
    from agent_runner import AGENT_EXECUTION_FAILURE_MARKER  # noqa: E402
except ImportError:  # pragma: no cover — co-bundled with index.py; fallback only
    AGENT_EXECUTION_FAILURE_MARKER = 'agentExecutionFailed'


class AgentExecutionError(RuntimeError):
    """An agent execution failed and must surface as a FAILED node result
    (finding 56d763d4).

    Carries the exception CLASS name (``error_class``) so the step runner's
    retry.py failure-class logic (``should_retry``: ``error_type in
    retryableErrors``) can classify it, alongside the human-readable
    ``message`` diagnostic. Raised by ``run_agent_in_subprocess`` /
    ``_interpret_agent_result`` whenever the subprocess stdout carries the
    agent-body failure marker (REGARDLESS of exit code) or, with
    ``raise_on_error=True``, on any non-zero exit without a marker.
    """

    def __init__(self, error_class, message):
        self.error_class = error_class or 'AgentExecutionError'
        self.message = message or self.error_class
        super().__init__(self.message)


# Canned supervisor-path fallback for a subprocess-level crash WITHOUT a
# failure marker (OOM/timeout kill/runner import crash) when raise_on_error is
# False. Unchanged pre-fix string — the supervisor path intentionally degrades
# for infra-level subprocess failures (an agent-body exception, by contrast,
# always raises via the marker; see _interpret_agent_result).
_SUBPROCESS_FALLBACK_RESPONSE = (
    "The task could not be completed, this agent has issues, please ignore for now."
)

# QB-013-1: lazy boto3 client construction. Keeps the module importable
# without AWS credentials in the local dev env. Matches the pattern used
# by arbiter/governance/ledger.py and arbiter/fabricator/tools_config.py.
# Previously `dynamodb = boto3.resource('dynamodb')` and
# `lambda_client = boto3.client('lambda')` ran at import time and triggered
# credential resolution, which made pytest collection fail on dev machines
# with expired credentials.
_dynamodb = None
_lambda_client = None
_cloudwatch_client = None

# Cold-start detection (module-scope flag): a Lambda execution environment
# reuses this module across invocations, so a plain module-level boolean —
# flipped to False the first time a workflow node is processed in this
# container — is the cheapest possible signal. True (the import-time
# default) on the FIRST invocation in a fresh container only; every
# subsequent invocation in the same (warm) container observes False. This is
# a Lambda-tier-only signal: the AgentCore Runtime intake container has no
# equivalent module-scope entry point (see service/agent_intake_single/tools/
# emf.py — EMF there is a per-turn emitter, not a per-container-lifecycle
# one), so cold-start is intentionally NOT emitted for that runtime.
_is_cold_start = True

def _get_cloudwatch_client():
    """Lazily construct the boto3 CloudWatch client. Cached per process."""
    global _cloudwatch_client
    if _cloudwatch_client is None:
        _cloudwatch_client = boto3.client('cloudwatch')
    return _cloudwatch_client

def _now_iso() -> str:
    """Return current UTC time as ISO 8601 string. Mirrors the step
    runner's identical helper (arbiter/stepRunner/executor.py)."""
    return datetime.now(timezone.utc).isoformat()

def _emit_cold_start_metric_if_applicable(agent_id: str) -> None:
    """Emit NodeColdStart exactly once per container lifetime, best-effort.

    Reads-then-flips the module-scope ``_is_cold_start`` flag: the check and
    the flip happen together so a re-entrant/duplicate call within the same
    container never double-emits. Wrapped so a CloudWatch failure (throttling,
    missing PutMetricData permission, network) can never break node
    execution — mirrors the step runner's ``_emit_metric`` best-effort
    contract (arbiter/stepRunner/executor.py).
    """
    global _is_cold_start
    if not _is_cold_start:
        return
    _is_cold_start = False
    try:
        datum = {'MetricName': METRIC_NODE_COLD_START, 'Value': 1, 'Unit': UNIT_COUNT}
        if agent_id:
            datum['Dimensions'] = [{'Name': DIMENSION_AGENT_ID, 'Value': agent_id}]
        _get_cloudwatch_client().put_metric_data(
            Namespace=METRIC_NAMESPACE,
            MetricData=[datum],
        )
    except Exception as exc: # noqa: BLE001 — telemetry must never raise
        print(json.dumps({
            'level': 'WARN',
            'component': 'WorkerWrapper',
            'action': 'cold_start_metric_emit_failed',
            'error': str(exc),
        }))

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
    global _dynamodb, _lambda_client, _cloudwatch_client
    _dynamodb = None
    _lambda_client = None
    _cloudwatch_client = None

def __reset_cold_start_for_test() -> None:
    """Test-only: reset the cold-start flag to its fresh-container default."""
    global _is_cold_start
    _is_cold_start = True

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

def run_agent_in_subprocess(request: dict, scoped_credentials: dict | None, extra_env: dict | None = None, *, raise_on_error: bool = False, usage_sink: list | None = None) -> str:
    """
    Execute the agent code in an isolated subprocess.

    Scoped credentials are passed only to the child process's environment,
    never set on the parent's os.environ. This prevents:
    - The agent code from reading the parent Lambda's ambient credentials
    - Credential leakage between sequential agent executions
    - Credentials persisting in /proc/self/environ of the parent

    ``raise_on_error`` controls the non-zero-exit behaviour. The default
    (False) preserves the supervisor task path: a failed subprocess returns a
    human-readable fallback string. The workflow-node path passes True so a
    subprocess failure raises and is surfaced as workflow.node.failed rather
    than a canned success.

    ``usage_sink`` is an optional list the caller supplies to collect worker
    usage records. The return type stays a bare ``str`` (backward
    compatible): the child's stdout envelope is
    ``{"response": str, "usage": [...]}`` (was response-only), and on a
    successful JSON parse this function extends ``usage_sink`` in place with
    the sanitized ``usage`` array via ``parse_usage_array``. Old
    ``{"response": ...}``-only stdout and legacy non-JSON stdout still parse
    exactly as before, leaving ``usage_sink`` unchanged (empty). Malformed
    usage data never raises here — ``parse_usage_array`` degrades to ``[]``.
    """
    # Build the child's environment: inherit parent env for Python path etc.,
    # but override AWS credentials with scoped ones if available
    child_env = os.environ.copy()

    if scoped_credentials:
        # Scoped STS credentials declared via requiredPermissions: OVERWRITE
        # the three credential env vars so the child sees ONLY the narrowed
        # role. boto3's provider chain reads AWS_ACCESS_KEY_ID first, so these
        # take precedence over any ambient container/role source that remains
        # in the inherited env — the child never sees the parent's broader
        # permissions (docs/AGENT_PERMISSIONS.md §"Why Subprocess Isolation").
        child_env['AWS_ACCESS_KEY_ID'] = scoped_credentials['accessKeyId']
        child_env['AWS_SECRET_ACCESS_KEY'] = scoped_credentials['secretAccessKey']
        child_env['AWS_SESSION_TOKEN'] = scoped_credentials['sessionToken']
        print("Subprocess will use scoped credentials")
    else:
        # No scoped vending for this agent (no requiredPermissions) — the
        # DOCUMENTED backward-compat path (docs/AGENT_PERMISSIONS.md §5) is for
        # the agent to run under the wrapper Lambda's ambient IAM role.
        #
        # FIX (finding 9ef192d1): the ambient role must be PROPAGATED into the
        # child, not stripped. In AWS Lambda the execution role is delivered
        # ONLY through the AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY /
        # AWS_SESSION_TOKEN environment variables the runtime sets — there is
        # NO IMDS/metadata service to "fall back" to (that only exists on EC2/
        # ECS). The previous code popped exactly those three keys, so the child
        # had no credential source at all and boto3 raised
        # NoCredentialsError ("Unable to locate credentials"), which the
        # governance ledger surfaced as a fenced-reserve transport error and
        # refused the tool fail-closed (dev run 732013d3: 0 ledger rows, 0
        # smoke rows). ``child_env = os.environ.copy()`` already carries the
        # parent's credential env, so we simply leave it in place — no pop.
        #
        # LEAST-PRIVILEGE TRADEOFF: on this path the child inherits the
        # wrapper's full role (broader than a scoped vend). This is exactly the
        # behaviour the design intends for agents without requiredPermissions
        # ("runs using the Lambda's ambient IAM role"); narrowing still applies
        # whenever an agent declares requiredPermissions (the branch above).
        # We are fixing the broken mechanism, not widening privilege beyond the
        # documented design. AWS_CONTAINER_CREDENTIALS_* (if the deployment
        # substrate ever sets them) are likewise inherited untouched.
        pass

    # Apply governance and config overrides (stepConstraints, appConfig, modelOverride)
    if extra_env:
        child_env.update(extra_env)

    # Propagate THIS (parent) Lambda process's import roots to the child so the
    # agent_runner subprocess can import the shared arbiter packages the
    # ``ArbiterCatalogLayer`` delivers at ``/opt/python`` (``governance`` /
    # ``common`` / ``catalog``) and the bundle-root sibling modules at the task
    # root (``tool_idempotency_hook`` / ``tool_idempotency`` /
    # ``governed_tool_handler``). The Lambda runtime adds these to the PARENT's
    # ``sys.path`` via its bootstrap but does NOT export them on ``PYTHONPATH``,
    # so a fresh ``sys.executable`` child does NOT inherit them — which is why
    # the idempotency/governance hooks failed to install ("No module named
    # arbiter/common") in the first real smoke run. Prepend the parent roots
    # (deduped, order-preserving) ahead of any inherited PYTHONPATH.
    _parent_roots = [p for p in sys.path if p]
    _inherited_pp = child_env.get('PYTHONPATH', '')
    if _inherited_pp:
        _parent_roots.append(_inherited_pp)
    if _parent_roots:
        child_env['PYTHONPATH'] = os.pathsep.join(dict.fromkeys(_parent_roots))

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

    return _interpret_agent_result(
        result.returncode, result.stdout,
        raise_on_error=raise_on_error, usage_sink=usage_sink,
    )


def _extend_usage_sink(usage_sink, parsed) -> None:
    """Extend ``usage_sink`` from a parsed stdout envelope's ``usage`` array.

    Best-effort and never raises into dispatch — a malformed usage value
    degrades to no extension (``parse_usage_array`` returns ``[]``).
    """
    if usage_sink is None or not isinstance(parsed, dict):
        return
    try:
        usage_sink.extend(parse_usage_array(parsed.get('usage', [])))
    except Exception as exc:  # noqa: BLE001 — usage parsing must never break dispatch
        print(json.dumps({
            'level': 'WARN',
            'component': 'WorkerWrapper',
            'action': 'usage_sink_extend_failed',
            'error': str(exc),
        }))


def _interpret_agent_result(returncode, stdout, *, raise_on_error=False, usage_sink=None):
    """Pure result-builder mapping a subprocess ``(returncode, stdout)`` to a
    success response string OR an ``AgentExecutionError`` (finding 56d763d4).

    STRUCTURAL INVARIANT: a stdout envelope carrying the agent-body failure
    marker (``AGENT_EXECUTION_FAILURE_MARKER``) ALWAYS raises
    ``AgentExecutionError`` — for ANY ``returncode`` and ANY
    ``raise_on_error`` — carrying the exception CLASS and diagnostic. No caller
    can turn a marked (crashed) payload into a completed / success result; this
    is the single choke point both the workflow-node and supervisor paths flow
    through, so the "crash recorded as success" defect cannot recur on any
    path.

    This guard now covers TWO producers of the marker in ``agent_runner``, both
    of which must fail the node and can never complete it (finding be80ccd7
    extends finding 56d763d4 from the exception path to the tool-result path):
      1. An agent-body EXCEPTION (``build_failure_envelope``) — errorClass is
         the raised exception type.
      2. A governance / infrastructure REFUSAL during a turn that otherwise
         COMPLETED normally (``build_refusal_envelope``) — a ``LedgerError``
         from the idempotency/ledger gate that strands swallowed into an
         error-status ToolResult; errorClass is the LedgerError subclass. A
         DOMAIN-level tool error (the tool ran and returned status=error, or
         the agent handled it) records NO refusal and produces a normal success
         envelope, so it is NOT blanket-failed here.

    Non-marker outcomes preserve the pre-fix contract exactly:
      * non-zero exit + raise_on_error=True  -> raise (node path -> node.failed)
      * non-zero exit + raise_on_error=False -> canned fallback (supervisor path)
      * zero exit                            -> parsed 'response' (or raw stdout)
    """
    text = (stdout or '').strip()
    parsed = None
    if text:
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            parsed = None

    # Usage is captured even on failure (harmless — dropped for failed nodes).
    _extend_usage_sink(usage_sink, parsed)

    # Structural guard: a failure-marked envelope can NEVER be a success. This
    # precedes the returncode/raise_on_error branches deliberately.
    if isinstance(parsed, dict) and parsed.get(AGENT_EXECUTION_FAILURE_MARKER) is True:
        raise AgentExecutionError(
            parsed.get('errorClass'),
            parsed.get('error'),
        )

    if returncode != 0:
        print(f"Agent subprocess exited with code {returncode}")
        if raise_on_error:
            raise AgentExecutionError(
                'AgentSubprocessError',
                f"Agent subprocess exited with code {returncode}",
            )
        return _SUBPROCESS_FALLBACK_RESPONSE

    # Parse the response from stdout (success path).
    if isinstance(parsed, dict):
        return parsed.get('response', text)
    return text or "Agent produced no output"

def post_task_complete(response, agent_use_id, agent_name, orchestration_id, *, usage=None):
    """Publish the supervisor-task completion event.

    ``usage`` is additive and optional: a list of worker usage records
    (or ``None``). The Detail always carries a ``'usage'`` key — ``usage or
    []`` so a missing/None value degrades to an empty list rather than
    omitting the key or passing ``None`` through to consumers.
    """
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
            'node': agent_name,
            'usage': usage or [],
        })
    }
    print(f"posting event, {json.dumps(event)}")
    response = client.put_events(Entries=[event])
    print(f"event posted: {response}")
    return f"event posted: {event}"

def _persist_node_completion(msg, *, output, usage):
    """Durably persist a completed node's result to EXECUTIONS_TABLE BEFORE the
    worker emits ``workflow.node.completed`` (write-then-signal, decision O2).

    Conditional first-write-wins (``ConditionExpression: status <> completed``)
    so a duplicate or re-dispatched worker cannot overwrite an existing
    completion — whoever writes first wins; a later write is a benign no-op.
    Writes the same five nodeResults attributes the stepRunner does
    (status/completedAt/output/usage/usageTotals) so the persisted node shape
    is identical regardless of which writer wins.

    IAM (decision O2, HARD GATE): the worker's grant on EXECUTIONS_TABLE is
    ``dynamodb:UpdateItem`` ONLY, further restricted by FGAC
    (``dynamodb:Attributes`` = nodeResults, executionId) — NEVER a bare
    ``grantWriteData`` (which would grant Put/Delete and every attribute). See
    backend/lib/arbiter-stack.ts. The ConditionExpression here is a CORRECTNESS
    guard (first-write-wins), NOT a security boundary — a compromised worker
    can omit it; the IAM attribute-scope is what structurally prevents it from
    writing execution-level status/orgId/output.

    EXACTLY-ONCE LIMIT (decision O7): this guarantees the RECORDED-STATE
    invariant only — exactly one ``completed`` result is recorded per node
    (first-write-wins drops any second write). It does NOT provide agent-side
    exactly-once: if the watchdog re-dispatches a node whose original worker
    was merely slow (not dead), the agent BODY runs twice and only the first
    recorded completion survives. Downstream agent bodies must therefore be
    designed idempotent. A dispatch-generation/lease token would be required
    for true agent-side once and is deferred (see docs/EVENTBRIDGE_CATALOG.md
    and docs/TRACING_RUNBOOK.md).

    Defensive: when ``EXECUTIONS_TABLE`` is unset (a pre-feature deploy or a
    unit path) the durable write is skipped — the stepRunner's own conditional
    completion write remains the backstop; emission is never blocked on a
    missing table binding. A non-conditional DynamoDB error is logged and
    RE-RAISED so the signal is NOT emitted for an unpersisted completion (SQS
    redelivery + first-write-wins recover it), preserving the
    signal-only-after-durable-write invariant.
    """
    table_name = os.environ.get('EXECUTIONS_TABLE')
    if not table_name:
        print(json.dumps({
            'level': 'WARN',
            'component': 'WorkerWrapper',
            'action': 'node_completion_persist_skipped_no_table',
            'executionId': msg.execution_id,
            'nodeId': msg.node_id,
        }))
        return

    sanitized_usage = parse_usage_array(usage or [])
    usage_totals = aggregate_usage(sanitized_usage)
    now = _now_iso()
    try:
        _get_dynamodb().Table(table_name).update_item(
            Key={'executionId': msg.execution_id},
            UpdateExpression=(
                'SET nodeResults.#nid.#status = :status, '
                'nodeResults.#nid.#completedAt = :completedAt, '
                'nodeResults.#nid.#output = :output, '
                'nodeResults.#nid.#usage = :usage, '
                'nodeResults.#nid.#usageTotals = :usageTotals'
            ),
            ConditionExpression='nodeResults.#nid.#status <> :completed',
            ExpressionAttributeNames={
                '#nid': msg.node_id,
                '#status': 'status',
                '#completedAt': 'completedAt',
                '#output': 'output',
                '#usage': 'usage',
                '#usageTotals': 'usageTotals',
            },
            ExpressionAttributeValues={
                ':status': 'completed',
                ':completedAt': now,
                ':output': output,
                ':usage': sanitized_usage,
                ':usageTotals': usage_totals,
                ':completed': 'completed',
            },
        )
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
            # Node already completed (duplicate / re-dispatch) — benign
            # first-write-wins loss. Proceed to signal (advancement is
            # idempotent).
            print(json.dumps({
                'level': 'INFO',
                'component': 'WorkerWrapper',
                'action': 'node_completion_already_persisted',
                'executionId': msg.execution_id,
                'nodeId': msg.node_id,
            }))
            return
        # A real write error — never swallow, and never emit an unpersisted
        # completion. Re-raise so the Lambda invocation fails and SQS
        # redelivers the dispatch (first-write-wins makes the retry safe).
        print(json.dumps({
            'level': 'ERROR',
            'component': 'WorkerWrapper',
            'action': 'node_completion_persist_failed',
            'executionId': msg.execution_id,
            'nodeId': msg.node_id,
            'error': str(exc),
        }))
        raise

def _emit_node_result(
    msg, *, status, output=None, error=None, usage=None, trace_context=None,
    worker_started_at=None,
):
    """Emit a workflow node-result event (completed/failed) to the agent event
    bus the step runner consumes.

    Reuses the worker's existing EventBridge PutEvents client and bus-name env
    (COMPLETION_BUS_NAME, which resolves to the same citadel-agents bus the
    step runner's node.completed/failed rules listen on). This is SEPARATE from
    the supervisor task.completion path in post_task_complete — a distinct
    Source/DetailType, not a different client or bus.

    ``usage`` is additive and optional: forwarded to
    ``workflow_contract.build_node_result_detail`` so a completed result also
    carries a top-level ``usage`` key (in addition to the existing
    ``output['usage']``) for the step runner's usage rollup. Ignored for a
    failed result (the contract already drops it there).

    ``trace_context`` is additive and optional (architect task
    f4f4bab3-7a07-4acf-ba43-ba43bb488444, R17): forwarded to
    ``workflow_contract.build_node_result_detail`` so the emitted Detail
    carries a top-level ``traceContext`` key when available, regardless of
    ``status``. Omitted entirely when None, keeping the Detail
    byte-identical to pre-feature callers.

    ``worker_started_at`` is additive and optional (queue-wait metric): this
    invocation's start timestamp, forwarded alongside ``msg.dispatched_at``
    (the step runner's dispatch timestamp, carried on the parsed dispatch
    message) so the step runner can compute a queue-wait duration without a
    second round trip. Regardless of ``status`` — a failed node still had a
    queue wait worth measuring.

    ``run_id`` (Pass 1, decision f1cbd5ef) is read off ``msg.run_id`` — the
    server-minted correlation id already carried on the parsed dispatch
    message — and forwarded to ``build_node_result_detail`` regardless of
    ``status``. Never fabricated: ``msg.run_id`` is ``None`` for any
    pre-runId dispatch message, and the Detail is byte-identical in that
    case.
    """
    detail = workflow_contract.build_node_result_detail(
        execution_id=msg.execution_id,
        node_id=msg.node_id,
        workflow_id=msg.workflow_id,
        agent_id=msg.agent_id,
        status=status,
        output=output,
        error=error,
        usage=usage,
        trace_context=trace_context,
        dispatched_at=getattr(msg, 'dispatched_at', None),
        worker_started_at=worker_started_at,
        run_id=getattr(msg, 'run_id', None),
    )
    detail_type = (
        workflow_contract.NODE_COMPLETED_DETAIL_TYPE
        if status == workflow_contract.STATUS_COMPLETED
        else workflow_contract.NODE_FAILED_DETAIL_TYPE
    )
    client = boto3.client('events')
    entry = {
        'Source': workflow_contract.WORKFLOW_EVENT_SOURCE,
        'DetailType': detail_type,
        'EventBusName': os.environ.get('COMPLETION_BUS_NAME'),
        'Detail': json.dumps(detail),
    }
    print(f"posting node-result event: {json.dumps(entry)}")
    result = client.put_events(Entries=[entry])
    print(f"node-result event posted: {result}")

def extract_node_overrides(configuration) -> tuple[str | None, str | None]:
    """Extract ``(model_override, system_prompt_addition)`` from a
    node-dispatch ``configuration`` (decision 59376546).

    Exactly TWO keys are consumed — ``modelOverride`` and
    ``systemPromptAddition``. All other keys (including the explicitly
    deferred ``toolRestrictions``) are IGNORED for forward compatibility.

    Validation parity with the supervisor task path: only a present,
    non-empty STRING value applies (``apply_system_prompt_addition`` no-ops
    on falsy values; ``build_subprocess_env`` omits MODEL_OVERRIDE when
    ``None``). Size caps are enforced downstream in worker_governance: a
    ``systemPromptAddition`` over the cap (WORKER_MAX_PROMPT_ADDITION_CHARS,
    default 4000) is skipped, never truncated, and a ``modelOverride`` over
    256 chars is not installed. Defensive by contract: tolerates a dict, a
    JSON-string object, or ``None``. NEVER raises on malformed input — a
    WARN is logged and no overrides are returned, so the node still
    executes.
    """
    raw = configuration
    if raw is None:
        return None, None
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raw = None
    if not isinstance(raw, dict):
        print(json.dumps({
            'level': 'WARN',
            'component': 'WorkerWrapper',
            'action': 'node_configuration_ignored',
            'error': 'node configuration is not an object: '
                     f'{type(configuration).__name__}',
        }))
        return None, None

    def _string_override(key: str) -> str | None:
        value = raw.get(key)
        if isinstance(value, str) and value:
            return value
        if value is not None and not isinstance(value, str):
            print(json.dumps({
                'level': 'WARN',
                'component': 'WorkerWrapper',
                'action': 'node_configuration_ignored',
                'key': key,
                'error': f'expected a non-empty string, got {type(value).__name__}',
            }))
        return None

    return _string_override('modelOverride'), _string_override('systemPromptAddition')

def _extract_worker_trace_context(event, message_attributes):
    """Resolve the effective carried traceContext for a workflow-node
    dispatch (H3 SQS hop, architect task f4f4bab3-7a07-4acf-ba43-
    ba43bb488444, R16): the standard ``AWSTraceHeader`` SQS MessageAttribute
    takes priority (the attribute X-Ray/Lambda natively recognize for SQS
    linking); falls back to the message body's own ``traceContext`` (the
    belt-and-suspenders annotation floor) when the attribute is absent.
    Returns None when neither is present — never raises.
    """
    try:
        if isinstance(message_attributes, dict):
            attr = message_attributes.get('AWSTraceHeader')
            if isinstance(attr, dict):
                header = attr.get('stringValue') or attr.get('StringValue')
                if header:
                    return {'xrayTraceHeader': header}
    except Exception:  # noqa: BLE001 — extraction must never raise
        pass
    return extract_carried(event)

def _resolve_execution_org_id(execution_id: str) -> str:
    """Resolve an execution's ``orgId`` SERVER-SIDE from the execution row.

    Tool-call idempotency (PR1) org-scoping: ``orgId`` is the ledger PK prefix
    and provides structural cross-org isolation, so it MUST come from a
    trusted server-side source — the ``EXECUTIONS_TABLE`` row keyed by
    ``executionId`` — and NEVER from a subprocess-supplied payload that could
    be spoofed to cross orgs.

    Best-effort and non-fatal: returns ``''`` when the table binding is
    absent, the row/attribute is missing, or the read fails. An empty orgId is
    safe — ``executionId`` is globally unique, so the ledger key stays unique;
    the org prefix is defense-in-depth, not the uniqueness guarantee. Falls
    back to ``RELEASE_DEFAULT_ORG_ID`` (the same trusted env the release path
    uses) before ``''``. Never raises — org resolution must not fail a node.
    """
    table_name = os.environ.get('EXECUTIONS_TABLE')
    if table_name and execution_id:
        try:
            resp = _get_dynamodb().Table(table_name).get_item(
                Key={'executionId': execution_id}
            )
            org_id = (resp.get('Item') or {}).get('orgId')
            if isinstance(org_id, str) and org_id:
                return org_id
        except Exception as exc:  # noqa: BLE001 — org resolution is best-effort
            print(json.dumps({
                'level': 'WARN',
                'component': 'WorkerWrapper',
                'action': 'idempotency_org_resolve_failed',
                'executionId': execution_id,
                'error': str(exc),
            }))
    fallback = os.environ.get('RELEASE_DEFAULT_ORG_ID')
    return fallback if isinstance(fallback, str) and fallback else ''


def _process_workflow_node(event, message_attributes=None):
    """Run the agent for a dispatched workflow node and emit its result.

    Reuses the worker's existing agent-execution path — config load →
    credential vend → S3 module load → agent_runner subprocess — then emits
    workflow.node.completed on success. On any failure (bad config, missing
    module, or a non-zero subprocess exit) emits workflow.node.failed rather
    than a canned success, so the step runner's failure path is exercised.

    H3 trace-context propagation (architect task f4f4bab3-7a07-4acf-ba43-
    ba43bb488444): ``message_attributes`` (the SQS record's
    messageAttributes, threaded through from ``lambda_handler`) is checked
    first for the standard ``AWSTraceHeader`` attribute — the format
    X-Ray/Lambda natively recognize for SQS linking. Falls back to the
    message body's own ``traceContext`` (belt-and-suspenders annotation
    floor) when the attribute is absent. Neither present → no-op (R16).
    """
    msg = workflow_contract.parse_node_dispatch_message(event)
    # Queue-wait metric: this invocation's start timestamp, captured as early
    # as possible (right after parsing) so it best approximates worker-start.
    # Cold-start metric: module-scope flag check/emit, also as early as
    # possible in this container's first workflow-node invocation.
    worker_started_at = _now_iso()
    _emit_cold_start_metric_if_applicable(msg.agent_id)
    carried_ctx = _extract_worker_trace_context(event, message_attributes)
    annotate_from_carried(carried_ctx)
    print(json.dumps({
        'level': 'INFO',
        'component': 'WorkerWrapper',
        'action': 'workflow_node_started',
        'executionId': msg.execution_id,
        'nodeId': msg.node_id,
        'workflowId': msg.workflow_id,
        'agentId': msg.agent_id,
    }))
    try:
        # Per-node configuration overrides (decision 59376546): consume exactly
        # modelOverride + systemPromptAddition from the merged configuration
        # dict the step runner dispatched. Unknown keys are ignored; malformed
        # values warn and the node executes without overrides.
        model_override, system_prompt_addition = extract_node_overrides(msg.configuration)

        agent = load_config_from_dynamodb(msg.agent_id)
        config = agent['config']
        if isinstance(config, str):
            config = json.loads(config)

        # Same mechanism as the supervisor task path (Req 3.6): append the
        # addition to the agent's description via worker_governance.
        if system_prompt_addition:
            config['description'] = apply_system_prompt_addition(
                config.get('description', ''), system_prompt_addition
            )

        required_permissions = config.get('requiredPermissions')
        scoped_credentials = get_scoped_credentials(msg.agent_id, required_permissions)

        fileName = config['filename']
        load_file_from_s3_into_tmp(os.environ["AGENT_BUCKET_NAME"], fileName)

        # Layer-2 governance parity with the supervisor task path: build the
        # same governance-carrying subprocess env so the subprocess layer-2
        # governance hook is installed for workflow-dispatched agents instead
        # of being silently bypassed. CITADEL_AGENT_ID is the trigger
        # (agent_runner._install_tool_call_hooks builds the GovernanceEvaluator
        # only when it is set, composed with idempotency on one
        # BeforeToolCallEvent seam — finding 027c4a89); without it the
        # governance hook is never installed and layer-2 tool governance is
        # skipped.
        # The workflow-node per-run correlation id is execution_id — mirroring
        # the supervisor path, which feeds its per-run orchestration_id into the
        # same slot — so ledger findings stay correlatable to a single
        # execution rather than the reusable workflow template id.
        # modelOverride rides the exact supervisor-path mechanism: the
        # MODEL_OVERRIDE env var consumed by agent_runner._install_model_override.
        extra_env = build_subprocess_env(
            {},
            model_override=model_override,
            agent_id=msg.agent_id,
            workflow_id=msg.execution_id,
            # Tool-call idempotency (PR1) context. orgId is resolved
            # SERVER-SIDE from the execution row (never trusted from the
            # dispatch payload); executionId/nodeId come from the validated
            # node-dispatch message. When these are threaded, agent_runner
            # installs the idempotency hook in the subprocess.
            execution_id=msg.execution_id,
            node_id=msg.node_id,
            org_id=_resolve_execution_org_id(msg.execution_id),
            # PR2 dispatch-generation fence: carried on the validated
            # node-dispatch message (server-minted by the step runner's
            # dispatch guard). When present, agent_runner fences the tool-call
            # reserve against it; when None (pre-fence dispatch) the reserve is
            # unfenced, preserving back-compat.
            dispatch_generation=msg.dispatch_generation,
        )

        usage_sink: list = []
        response = run_agent_in_subprocess(
            msg.input, scoped_credentials, extra_env, raise_on_error=True,
            usage_sink=usage_sink,
        )
    except Exception as exc:  # noqa: BLE001 — any failure becomes node.failed
        # finding 56d763d4: carry the exception CLASS as the node-result error
        # so the step runner's retry.py failure-class logic (should_retry:
        # ``error_type in retryableErrors``) can act on it. An
        # AgentExecutionError from run_agent_in_subprocess carries the
        # agent-body class (e.g. 'TypeError' for the ground-truth
        # "'dict' object can't be awaited"); any other exception (config /
        # module / credential error) uses its own type name. The full
        # human-readable diagnostic is preserved in the ERROR log below — a
        # failed node has no ``output`` to carry the message, and the
        # node-result ``error`` field is the retry classification KEY, so it
        # must be the class, not the free-form message (which would never match
        # a retryableErrors entry).
        error_class = getattr(exc, 'error_class', None) or type(exc).__name__
        diagnostic = getattr(exc, 'message', None) or str(exc)
        print(json.dumps({
            'level': 'ERROR',
            'component': 'WorkerWrapper',
            'action': 'workflow_node_failed',
            'executionId': msg.execution_id,
            'nodeId': msg.node_id,
            'workflowId': msg.workflow_id,
            'agentId': msg.agent_id,
            'errorClass': error_class,
            'error': diagnostic,
        }))
        _emit_node_result(
            msg,
            status=workflow_contract.STATUS_FAILED,
            error=error_class,
            trace_context=carried_ctx,
            worker_started_at=worker_started_at,
        )
        return

    print(json.dumps({
        'level': 'INFO',
        'component': 'WorkerWrapper',
        'action': 'workflow_node_completed',
        'executionId': msg.execution_id,
        'nodeId': msg.node_id,
        'workflowId': msg.workflow_id,
        'agentId': msg.agent_id,
    }))
    # Write-then-signal (decision O2): persist this node's completed result to
    # EXECUTIONS_TABLE.nodeResults[nodeId] BEFORE emitting the signal, so a lost
    # event leaves a durable, reconcilable checkpoint (never a
    # signaled-but-unpersisted black hole). The signal below is emitted only
    # after this durable write commits.
    _persist_node_completion(
        msg,
        output={'response': response, 'usage': usage_sink},
        usage=usage_sink,
    )
    _emit_node_result(
        msg,
        status=workflow_contract.STATUS_COMPLETED,
        output={'response': response, 'usage': usage_sink},
        usage=usage_sink,
        trace_context=carried_ctx,
        worker_started_at=worker_started_at,
    )

def process_event(event, context, message_attributes=None):
    print("processing...")

    # Discriminated shared queue: the step runner dispatches workflow-node
    # execution over the same SQS queue the supervisor uses for task messages.
    # A workflow-node message carries the contract's message_type discriminator;
    # a supervisor task message does not, so it falls through unchanged below.
    if workflow_contract is not None and workflow_contract.is_workflow_node_message(event):
        _process_workflow_node(event, message_attributes=message_attributes)
        return

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

    # CIT-102 Pass B: frozen contract keys (Pass A dispatch payload —
    # supervisor.process_agent_call). Absent-tolerant reads: a non-eval
    # dispatch (the overwhelming majority) has none of these keys and
    # every downstream computation below degrades to its pre-CIT-102
    # value (empty forbidden set, eval_run_id=None).
    eval_run_id = event.get('evalRunId')
    forbidden_tools = event.get('forbiddenTools') or []

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
    #
    # CIT-102 Pass B: forbidden_tools (the eval-run's per-run deny set,
    # frozen contract detail.forbiddenTools) is ADDED to this union — it
    # never replaces the static/binding-derived denials. An empty
    # forbidden_tools (every non-eval dispatch) leaves denied_tools_set
    # byte-identical to the pre-CIT-102 computation.
    denied_tools_set = set(blocked_tools)
    if tool_restrictions:
        denied_tools_set.update(tool_restrictions)
    if forbidden_tools:
        denied_tools_set.update(forbidden_tools)

    extra_env = build_subprocess_env(
        {},
        app_config,
        model_override,
        max_iterations,
        agent_id=agent_name,
        workflow_id=orchestration_id,
        denied_tools=sorted(denied_tools_set) if denied_tools_set else None,
        eval_run_id=eval_run_id,
    )

    print("running agent in isolated subprocess...")
    usage_sink: list = []
    response = run_agent_in_subprocess(request, scoped_credentials, extra_env if extra_env else None, usage_sink=usage_sink)
    print(f"agent response: {response}")

    post_task_complete(response, agent_use_id, agent_name, orchestration_id, usage=usage_sink)

def lambda_handler(event, context):
    print(f"processing event {event}")
    batch_item_failures = []

    for record in event['Records']:
        try:
            message_body = json.loads(record['body'])
            print(f"Processing message: {record['messageId']}")
            # H3 trace-context propagation (architect task f4f4bab3-7a07-4acf-
            # ba43-ba43bb488444): thread the record's SQS messageAttributes
            # through so process_event can extract the AWSTraceHeader
            # attribute (SQS's native X-Ray-linked attribute). Additive —
            # absent on any record that predates this change (defaults to {}).
            process_event(message_body, context, message_attributes=record.get('messageAttributes'))
            print(f"Successfully processed message: {record['messageId']}")
        except Exception as e:
            print(f"Error processing message {record['messageId']}: {e}")
            batch_item_failures.append({"itemIdentifier": record['messageId']})

    return {"batchItemFailures": batch_item_failures}

if __name__ == "__main__":
    lambda_handler({'Records': []}, {})
