"""Executor module — orchestration logic for workflow step execution.

Coordinates workflow execution by loading state from DynamoDB, advancing
through the DAG, evaluating conditional edges, handling convergence barriers,
retrying failed nodes, and publishing lifecycle events via EventBridge.

All operations are idempotent — re-processing the same event checks
DynamoDB state first to avoid duplicate work.
"""

import boto3
import json
import logging
import os
import sys
from datetime import datetime, timezone
from numbers import Number

from botocore.exceptions import ClientError

# Tracing foundation (architect task 5459301e-1e7b-4bfd-bccb-b106aba2748c):
# import BEFORE any boto3 client this module (or its `events` sibling)
# constructs, so patch_all() instruments botocore ahead of client creation.
# Hard import — arbiter/common/ is already a required dependency of this
# module (see the `from common import workflow_contract` hard import below),
# so no deferred-bundling fallback is needed here.
import common.tracing as tracing  # import activates tracing as a side effect

import events
from dag import (
    find_root_nodes,
    find_ready_nodes,
    find_convergence_nodes,
    merge_node_configuration,
    topological_sort,
)
from condition import evaluate_condition
from retry import calculate_backoff, should_retry
from common import workflow_contract
from common import failure_taxonomy
from common.usage import aggregate_usage, parse_usage_array
from common.metrics_constants import (
    METRIC_NAMESPACE,
    METRIC_NODE_DURATION_MS,
    METRIC_NODE_FAILURE,
    METRIC_NODE_QUEUE_WAIT_MS,
    METRIC_RETRY_GOVERNANCE_SMELL,
    METRIC_UNSTAMPED_DISPATCH,
    METRIC_RELEASE_DISPATCH_EVALUATED,
    METRIC_RELEASE_DISPATCH_WOULD_BLOCK,
    METRIC_RELEASE_DISPATCH_REFUSED,
    UNIT_MILLISECONDS,
    UNIT_COUNT,
    DIMENSION_WORKFLOW_ID,
    DIMENSION_RELEASE_MODE,
    DIMENSION_RELEASE_OUTCOME,
    METRIC_CANARY_ASSIGNMENT,
    DIMENSION_RELEASE_ARM,
)

# ---------------------------------------------------------------------------
# Release-aware dispatch (this story) — governance package import.
#
# Mirrors supervisor/index.py's ``_load_governance_package`` exactly (same
# private-namespace loading technique, same fail-closed contract), but
# loads only the three submodules this choke point needs: ``hierarchy``
# (mode + effective_at resolution), ``release_resolution`` (pointer/release
# lookup), and ``grandfathering`` (the ported pure rule). The full
# authority-graph engine (``engine``, ``ledger``, ``models``) is
# deliberately NOT loaded here — this choke point gains ONLY the release
# gate, not the DENY/ESCALATE authority machinery supervisor/index.py's
# ``governed_process_agent_call`` already has (out of scope for this
# story; see task scope).
#
# Deployment note: the Step Runner Lambda's asset is
# `code.fromAsset(ARBITER_ROOT/stepRunner)` only (backend/lib/
# arbiter-stack.ts's StepRunnerFunction) — unlike the Supervisor, which
# widens its own `entry` to the arbiter/ root. governance/ is instead
# staged into the shared `catalogLayer` (see arbiter-stack.ts's
# ArbiterCatalogLayer bundling command) at /opt/python/governance/, so it
# is loaded from the layer path rather than a sibling directory.
_stepRunner_dir = os.path.dirname(os.path.abspath(__file__))
_arbiter_dir = os.path.dirname(_stepRunner_dir)


def _load_release_governance_modules():
    """Load hierarchy/release_resolution/grandfathering from either the
    sibling arbiter/governance/ directory (pytest / local dev, where
    conftest.py puts arbiter/ on sys.path the same way it does for
    supervisor) or the Lambda layer path /opt/python/governance/
    (deployed Step Runner Lambda). Returns None if neither is available.
    """
    import importlib.util as _ilu

    candidates = [
        os.path.join(_arbiter_dir, 'governance'),
        '/opt/python/governance',
    ]
    pkg_dir = next((c for c in candidates if os.path.isfile(os.path.join(c, '__init__.py'))), None)
    if pkg_dir is None:
        return None

    pkg_name = '_citadel_governance_stepRunner'
    if pkg_name in sys.modules:
        return sys.modules[pkg_name]

    spec = _ilu.spec_from_file_location(
        pkg_name, os.path.join(pkg_dir, '__init__.py'),
        submodule_search_locations=[pkg_dir],
    )
    pkg = _ilu.module_from_spec(spec)
    sys.modules[pkg_name] = pkg
    spec.loader.exec_module(pkg)

    for submod in ('hierarchy', 'release_resolution', 'grandfathering'):
        sub_file = os.path.join(pkg_dir, f'{submod}.py')
        if not os.path.isfile(sub_file):
            continue
        sub_spec = _ilu.spec_from_file_location(f'{pkg_name}.{submod}', sub_file)
        sub_mod = _ilu.module_from_spec(sub_spec)
        sys.modules[f'{pkg_name}.{submod}'] = sub_mod
        sub_spec.loader.exec_module(sub_mod)
        setattr(pkg, submod, sub_mod)

    return pkg


try:
    _gov_pkg = _load_release_governance_modules()
    if _gov_pkg is None:
        raise ImportError("governance package files not found for stepRunner")
    load_governance_state = _gov_pkg.hierarchy.load_governance_state
    resolve_release = _gov_pkg.release_resolution.resolve_release
    ReleaseResolutionStatus = _gov_pkg.release_resolution.ReleaseResolutionStatus
    is_grandfathered_pure = _gov_pkg.grandfathering.is_grandfathered_pure
    _RELEASE_GOVERNANCE_AVAILABLE = True
    _RELEASE_GOVERNANCE_IMPORT_ERROR: str | None = None
except ImportError as e:
    # Fail-closed (same doctrine as supervisor/index.py's
    # _GOVERNANCE_AVAILABLE gate): if the release-governance modules are
    # not present in the deployed asset/layer, the release gate refuses
    # every dispatch WHEN ACTIVE (RELEASE_DISPATCH_ENVIRONMENT set) rather
    # than silently skipping the check — see invoke_node below. When
    # RELEASE_DISPATCH_ENVIRONMENT is unset, this deployment hasn't opted
    # into the gate at all, so the missing-package state is irrelevant and
    # invoke_node's own feature-switch check short-circuits before ever
    # consulting this flag.
    _RELEASE_GOVERNANCE_AVAILABLE = False
    _RELEASE_GOVERNANCE_IMPORT_ERROR = str(e)
    _logger_bootstrap = logging.getLogger(__name__)
    _logger_bootstrap.warning(
        "release-governance package unavailable (%s); release-aware "
        "dispatch will refuse if RELEASE_DISPATCH_ENVIRONMENT is set. "
        "This is not a bypass.", e,
    )

# DynamoDB table names from environment
WORKFLOWS_TABLE = os.environ.get('WORKFLOWS_TABLE', 'citadel-workflows-dev')
EXECUTIONS_TABLE = os.environ.get('EXECUTIONS_TABLE', 'citadel-executions-dev')

# DynamoDB resource
_dynamodb = boto3.resource('dynamodb')
_workflows_table = _dynamodb.Table(WORKFLOWS_TABLE)
_executions_table = _dynamodb.Table(EXECUTIONS_TABLE)

_logger = logging.getLogger(__name__)

# METRIC_NAMESPACE is imported from common.metrics_constants (the shared
# contract module) rather than defined locally — see that module's docstring
# for the namespace-reuse rationale.

# Lazy SQS client for dispatching workflow nodes to the worker. Constructed on
# first use (not at import) so module import never resolves credentials — the
# same pattern the worker uses for its boto3 clients.
_sqs_client = None

# Lazy CloudWatch client for best-effort node telemetry. Same lazy pattern as
# the SQS client: never resolve credentials at import time.
_cloudwatch_client = None


def _get_sqs_client():
    """Lazily construct the boto3 SQS client. Cached per process."""
    global _sqs_client
    if _sqs_client is None:
        _sqs_client = boto3.client('sqs')
    return _sqs_client


def _get_cloudwatch_client():
    """Lazily construct the boto3 CloudWatch client. Cached per process."""
    global _cloudwatch_client
    if _cloudwatch_client is None:
        _cloudwatch_client = boto3.client('cloudwatch')
    return _cloudwatch_client


def _now_iso() -> str:
    """Return current UTC time as ISO 8601 string."""
    return datetime.now(timezone.utc).isoformat()


def _extract_dispatch_generation(update_response, node_id: str):
    """Read the post-increment ``dispatchGeneration`` from an UPDATED_NEW
    update_item response, or None when unavailable/unparseable.

    Defensive by contract: a MagicMock (unit tests that don't model the
    response), a pre-fence row, or a non-numeric value all degrade to None, in
    which case the dispatch message carries no generation and the worker's
    reserve stays unfenced (back-compat). DynamoDB returns numbers as Decimal;
    both Decimal and int are coerced to int."""
    try:
        node = ((update_response.get('Attributes') or {}).get('nodeResults') or {}).get(node_id) or {}
        gen = node.get('dispatchGeneration')
    except Exception:  # noqa: BLE001 — a mock/None response must never break dispatch
        return None
    if isinstance(gen, bool) or not isinstance(gen, Number):
        return None
    return int(gen)


def _log_event(action: str, **fields) -> None:
    """Emit a structured JSON log line for cross-system correlation.

    Every line carries an ``executionId`` (and, where relevant, ``nodeId`` /
    ``workflowId``) so a log search can stitch one execution together across
    the step runner and the worker. Emitted via stdout (Lambda ships stdout to
    CloudWatch Logs), matching the worker's structured-logging convention.
    None-valued fields are dropped to keep lines terse.

    Additive, no-op-safe ``trace_id`` injection (design §"Structured-log
    trace-id inclusion at the cited logger seams both languages"): read via
    ``common.tracing.active_trace_context()``, omitted entirely with no
    active X-Ray segment (the default under pytest / local dev) so the line
    is byte-identical to the pre-feature shape.
    """
    payload = {'component': 'StepRunner', 'action': action}
    payload.update({k: v for k, v in fields.items() if v is not None})
    trace_context = tracing.active_trace_context()
    if trace_context and trace_context.get('traceId'):
        payload['trace_id'] = trace_context['traceId']
    print(json.dumps(payload))


def _duration_ms(started_at, completed_at) -> float | None:
    """Return elapsed milliseconds between two ISO 8601 timestamps.

    Returns None when either bound is missing or unparseable — the duration
    metric is best-effort and must never be fabricated.
    """
    if not started_at or not completed_at:
        return None
    try:
        start = datetime.fromisoformat(started_at)
        end = datetime.fromisoformat(completed_at)
    except (TypeError, ValueError):
        return None
    return max(0.0, (end - start).total_seconds() * 1000.0)


def _emit_metric(metric_name: str, value: float, unit: str, *, workflow_id: str = '') -> None:
    """Emit a single CloudWatch custom metric, best-effort.

    Wrapped so a telemetry backend failure (throttling, missing
    cloudwatch:PutMetricData permission, network) can NEVER break workflow
    execution. A WorkflowId dimension is attached when available to keep
    cardinality bounded while still allowing per-workflow drill-down.
    """
    try:
        datum = {'MetricName': metric_name, 'Value': float(value), 'Unit': unit}
        if workflow_id:
            datum['Dimensions'] = [{'Name': DIMENSION_WORKFLOW_ID, 'Value': workflow_id}]
        _get_cloudwatch_client().put_metric_data(
            Namespace=METRIC_NAMESPACE,
            MetricData=[datum],
        )
    except Exception as exc:  # noqa: BLE001 — telemetry must never raise
        _logger.warning('cloudwatch metric emit failed metric=%s: %s', metric_name, exc)


# ---------------------------------------------------------------------------
# Release-aware dispatch (this story)
# ---------------------------------------------------------------------------


def _resolve_agent_created_at(agent_id: str) -> str | None:
    """Best-effort per-agent creation timestamp for the grandfathering
    check. Mirrors supervisor/index.py's identical helper: returns None
    when no signal is available, which is the honest default in this
    codebase today (see release_resolution.py's module docstring) — the
    Step Runner's workflow node dict carries no createdAt either, and the
    AgentCore Registry lookup that DOES expose one requires
    REGISTRY_ENABLED + a resolvable recordId, neither of which is
    guaranteed. A None return routes through grandfathering.py's
    conservative-bypass branch, not a special case here.
    """
    if os.environ.get('REGISTRY_ENABLED') != 'true':
        return None
    registry_id = os.environ.get('REGISTRY_ID')
    if not registry_id or not agent_id:
        return None
    try:
        from catalog.registry_client import get_agent_record
        record = get_agent_record(registry_id, agent_id)
    except Exception:
        return None
    if record is None:
        return None
    created_at = record.get('createdAt')
    return created_at if isinstance(created_at, str) and created_at else None


def _emit_release_dispatch_metric(
    *, mode: str, outcome: str, would_block: bool, workflow_id: str = '',
) -> None:
    """Best-effort CloudWatch telemetry for the release-aware dispatch
    gate. Mirrors supervisor/index.py's identical helper exactly (same
    metric names/dimensions, same never-raises discipline) so a downstream
    dashboard can aggregate across both dispatch choke points without a
    branch per producer.
    """
    try:
        cw = _get_cloudwatch_client()
        dimensions = [{'Name': DIMENSION_RELEASE_MODE, 'Value': mode}]
        if workflow_id:
            dimensions.append({'Name': DIMENSION_WORKFLOW_ID, 'Value': workflow_id})
        outcome_dimensions = dimensions + [
            {'Name': DIMENSION_RELEASE_OUTCOME, 'Value': outcome},
        ]
        metric_data = [{
            'MetricName': METRIC_RELEASE_DISPATCH_EVALUATED,
            'Value': 1.0,
            'Unit': UNIT_COUNT,
            'Dimensions': outcome_dimensions,
        }]
        if would_block:
            metric_data.append({
                'MetricName': METRIC_RELEASE_DISPATCH_WOULD_BLOCK,
                'Value': 1.0,
                'Unit': UNIT_COUNT,
                'Dimensions': dimensions,
            })
        if outcome == 'refused':
            metric_data.append({
                'MetricName': METRIC_RELEASE_DISPATCH_REFUSED,
                'Value': 1.0,
                'Unit': UNIT_COUNT,
                'Dimensions': dimensions,
            })
        cw.put_metric_data(Namespace=METRIC_NAMESPACE, MetricData=metric_data)
    except Exception as exc:  # noqa: BLE001 — telemetry must never raise
        _logger.warning('release-dispatch metric emit failed: %s', exc)


def _emit_canary_assignment_metric(arm: str, workflow_id: str = '') -> None:
    """Best-effort counter of which canary arm a node dispatch resolved to
    (decision D2, attribution-only). Low-cardinality dimensions ONLY —
    WorkflowId x ReleaseArm; releaseId is never a dimension. Never raises.
    """
    if arm not in ('stable', 'candidate'):
        return
    try:
        cw = _get_cloudwatch()
        dimensions = [{'Name': DIMENSION_RELEASE_ARM, 'Value': arm}]
        if workflow_id:
            dimensions.append({'Name': DIMENSION_WORKFLOW_ID, 'Value': workflow_id})
        cw.put_metric_data(
            Namespace=METRIC_NAMESPACE,
            MetricData=[{
                'MetricName': METRIC_CANARY_ASSIGNMENT,
                'Value': 1.0,
                'Unit': UNIT_COUNT,
                'Dimensions': dimensions,
            }],
        )
    except Exception as exc:  # noqa: BLE001 — telemetry must never raise
        _logger.warning('canary-assignment metric emit failed: %s', exc)


def _check_release_gate(
    agent_id: str, workflow_id: str, execution_id: str = ''
) -> tuple[bool, str | None]:
    """Evaluates the release-aware dispatch gate for one node dispatch.

    Returns ``(refused, refusal_reason)``. ``refused`` is always False
    when ``RELEASE_DISPATCH_ENVIRONMENT`` is unset (the gate's own feature
    switch — backward-compat no-op, see module docstring above) or when
    the release-governance modules failed to load AND the switch is unset
    (irrelevant in that case). When the switch IS set but the modules
    failed to load, this refuses unconditionally — the same fail-closed
    contract as supervisor/index.py's package-unavailable gate: a missing
    package means there is nothing to evaluate against, so dispatch must
    be refused, never silently ungoverned.

    Telemetry is emitted for every mode via
    ``_emit_release_dispatch_metric`` before returning, so the rollout can
    be measured before strict is flipped, in every branch including the
    package-unavailable one.
    """
    release_dispatch_environment = os.environ.get('RELEASE_DISPATCH_ENVIRONMENT')
    if not release_dispatch_environment:
        return False, None

    if not _RELEASE_GOVERNANCE_AVAILABLE:
        _logger.error(
            "release dispatch refused: release-governance package "
            "unavailable (%s); workflow_id=%s target_agent=%s",
            _RELEASE_GOVERNANCE_IMPORT_ERROR, workflow_id, agent_id,
        )
        return True, 'release_governance_package_unavailable'

    state = load_governance_state()
    enforcement_mode = getattr(state, 'enforcement_mode', 'shadow')

    release_result = resolve_release(
        org_id=os.environ.get('RELEASE_DEFAULT_ORG_ID') or '',
        agent_target_id=agent_id,
        environment=release_dispatch_environment,
        # D1: server-minted stickiness key = executionId (the stepRunner's
        # equivalent of the supervisor's orchestrationId; server-minted,
        # never client-supplied). Interim key — no conversationId threading.
        stickiness_key=execution_id or '',
    )

    if release_result.status == ReleaseResolutionStatus.RESOLVED:
        outcome, would_block = 'proceed', False
        # Attribution-only canary metric (decision D2).
        _emit_canary_assignment_metric(arm=release_result.arm, workflow_id=workflow_id)
    elif release_result.status == ReleaseResolutionStatus.LOOKUP_FAILED:
        # Assert-or-refuse doctrine — see release_resolution.py's module
        # docstring and supervisor/index.py's identical branch. Never
        # excused by grandfathering.
        outcome = 'refused' if enforcement_mode == 'strict' else 'proceed'
        would_block = enforcement_mode != 'strict'
    else:
        # NO_POINTER — clean backward-compat state. Strict refuses unless
        # grandfathered via the ported pure rule.
        created_at = _resolve_agent_created_at(agent_id)
        grandfathered = is_grandfathered_pure(created_at, getattr(state, 'effective_at', None))
        outcome = 'refused' if (enforcement_mode == 'strict' and not grandfathered) else 'proceed'
        would_block = enforcement_mode != 'strict'

    _emit_release_dispatch_metric(
        mode=enforcement_mode, outcome=outcome, would_block=would_block,
        workflow_id=workflow_id,
    )

    if outcome == 'refused':
        refusal_reason = (
            'release_lookup_failed'
            if release_result.status == ReleaseResolutionStatus.LOOKUP_FAILED
            else 'no_release_resolvable'
        )
        _logger.error(
            "release dispatch refused: %s; workflow_id=%s target_agent=%s "
            "environment=%s detail=%s",
            refusal_reason, workflow_id, agent_id, release_dispatch_environment,
            release_result.error,
        )
        return True, refusal_reason

    return False, None


def _load_workflow(workflow_id: str) -> dict:
    """Load workflow item from DynamoDB."""
    resp = _workflows_table.get_item(Key={'workflowId': workflow_id})
    return resp.get('Item', {})


def _load_execution(execution_id: str) -> dict:
    """Load execution item from DynamoDB."""
    resp = _executions_table.get_item(Key={'executionId': execution_id})
    return resp.get('Item', {})


def _parse_definition(workflow: dict) -> dict:
    """Parse the workflow definition JSON string."""
    defn = workflow.get('definition', '{}')
    if isinstance(defn, str):
        return json.loads(defn)
    return defn


def start_execution(execution_id: str, workflow_id: str) -> None:
    """Start a workflow execution.

    1. Load workflow + execution from DynamoDB
    2. Idempotency: skip if execution is already 'running'
    3. Update execution status → running
    4. Publish workflow.started event
    5. Find root nodes → invoke them
    """
    workflow = _load_workflow(workflow_id)
    if not workflow:
        raise ValueError(f"Workflow {workflow_id} not found")

    execution = _load_execution(execution_id)
    if not execution:
        raise ValueError(f"Execution {execution_id} not found")

    # Idempotency check: skip if already running or completed
    if execution.get('status') in ('running', 'completed', 'failed', 'cancelled'):
        return

    definition = _parse_definition(workflow)
    nodes = definition.get('nodes', [])
    edges = definition.get('edges', [])

    # Update execution status to running
    now = _now_iso()
    _executions_table.update_item(
        Key={'executionId': execution_id},
        UpdateExpression='SET #status = :status, #startedAt = :startedAt',
        ExpressionAttributeNames={'#status': 'status', '#startedAt': 'startedAt'},
        ExpressionAttributeValues={':status': 'running', ':startedAt': now},
    )

    # Publish workflow.started event. run_id kwarg is omitted entirely
    # (not passed as None) when the execution row carries no runId, so a
    # pre-runId execution produces a byte-identical call signature to the
    # pre-feature code path (mirrors the omit-when-absent Detail contract).
    _run_id = execution.get('runId')
    _run_id_kwargs = {'run_id': _run_id} if _run_id else {}
    events.publish_workflow_started(
        execution_id=execution_id,
        workflow_id=workflow_id,
        app_id=execution.get('appId', ''),
        started_at=now,
        **_run_id_kwargs,
    )
    _log_event('execution_start', executionId=execution_id, workflowId=workflow_id)

    # Find and invoke root nodes
    root_ids = find_root_nodes(nodes, edges)
    configuration = workflow.get('configuration', '{}')
    if isinstance(configuration, str):
        configuration = json.loads(configuration)

    for node_id in root_ids:
        node = next((n for n in nodes if n['id'] == node_id), None)
        if node:
            # Per-node configuration overrides workflow-level per-key
            # (decision 59376546). No node configuration → workflow config
            # unchanged, byte-identical to the pre-feature dispatch.
            invoke_node(execution_id, workflow_id, node, {},
                        merge_node_configuration(configuration, node),
                        run_id=_run_id)


def invoke_node(
    execution_id: str, workflow_id: str, node: dict, input_data: dict, configuration: dict,
    *, run_id: str | None = None,
) -> None:
    """Invoke a single workflow node.

    1. Emit supervisor.chatter event for cross-system correlation (US-ARB-016)
    2. Update node status → running in DynamoDB
    3. Publish workflow.node.started event
    4. Dispatch the node to the worker by sending a discriminated message to
       the worker SQS queue (WORKER_QUEUE_URL)

    ``run_id`` is additive, optional, and nullable (Pass 1, decision
    f1cbd5ef): the server-minted correlation id read off the execution row
    by callers, threaded through to the outbound chatter/node-started
    events and the SQS dispatch message. Never fabricated — a caller that
    passes ``None`` (a pre-runId execution row) produces byte-identical
    events/messages to the pre-runId code path.
    """
    # US-ARB-016: fire-and-forget chatter event for cross-system correlation.
    # The returned correlationId is currently a local only; it becomes the
    # hook for US-ARB-008's governed dispatch to link findings back to the
    # stepRunner node that triggered them.
    #
    # run_id kwarg is omitted entirely (not passed as None) at each of the
    # three call sites below when absent, so a pre-runId caller's call
    # signature stays byte-identical to the pre-feature code path.
    _run_id_kwargs = {'run_id': run_id} if run_id else {}

    # Runtime backstop (Pass 1, decision f1cbd5ef, silent-regression guard
    # layer 3): a node dispatched with no run_id emits a WARN-level
    # CloudWatch count metric using the pinned metrics_constants module —
    # never a hand-typed string literal. Best-effort and observability
    # only: a CloudWatch failure here can never gate or delay dispatch
    # (see _emit_metric's own try/except).
    if not run_id:
        _logger.warning(
            'unstamped dispatch: node %s of execution %s dispatched with no runId',
            node.get('id', 'unknown'), execution_id,
        )
        _emit_metric(METRIC_UNSTAMPED_DISPATCH, 1, UNIT_COUNT, workflow_id=workflow_id)

    correlation_id = events.publish_supervisor_chatter(  # noqa: F841
        execution_id=execution_id,
        workflow_id=workflow_id,
        node_id=node.get('id', 'unknown'),
        **_run_id_kwargs,
    )

    node_id = node['id']
    # Canonical persisted shape: top-level node.agentId.
    # The frontend's ReactFlow runtime puts agentId under node.data.agentId,
    # but workflowService.ts converts this to top-level on serialization
    # (see WorkflowNodeDefinition in frontend/src/types/workflow.ts).
    # All backend writers (seed-blueprints, importBlueprint) and the TS
    # validator (workflow-resolver.validateDefinition) use the top-level
    # shape, so executor must read top-level too.
    agent_id = node.get('agentId', '')

    # Release-aware dispatch (this story). Evaluated before any state
    # mutation (node status update, node.started event, SQS send) so a
    # strict-mode refusal leaves no partial/inconsistent trace of a
    # dispatch that never actually happened — the node simply stays in
    # whatever state DAG scheduling left it, and the refusal is observable
    # via the ERROR-level log line and the ReleaseDispatchRefused metric
    # emitted inside _check_release_gate.
    _release_refused, _release_refusal_reason = _check_release_gate(
        agent_id, workflow_id, execution_id
    )
    if _release_refused:
        return

    now = _now_iso()

    # Correlation log: one line per node dispatch, tagged with the ids a log
    # search needs to stitch this node to its worker-side execution.
    _log_event(
        'node_dispatch',
        executionId=execution_id,
        workflowId=workflow_id,
        nodeId=node_id,
        agentId=agent_id or None,
    )

    # Exactly-once dispatch guard (conditional pending->running write). The
    # transition only commits while the node is still 'pending', so when two
    # concurrent predecessor-completions both compute a convergence node
    # "ready" (or a resume/watchdog re-drive races a live advance) exactly one
    # writer wins the pending->running flip and sends the SQS message; every
    # other dispatcher's conditional write raises ConditionalCheckFailedException
    # and is a no-op here. This is THE single serialization point that makes
    # node dispatch exactly-once regardless of which path (root dispatch,
    # completion-advance, resume, or watchdog reconcile) drives it — replacing
    # the previous unconditional SET, which let both racing dispatchers send
    # (latent double-dispatch of convergence nodes).
    try:
        _dispatch_write = _executions_table.update_item(
            Key={'executionId': execution_id},
            UpdateExpression=(
                'SET nodeResults.#nid.#status = :status, '
                'nodeResults.#nid.#startedAt = :startedAt '
                'ADD nodeResults.#nid.#gen :one'
            ),
            ConditionExpression='nodeResults.#nid.#status = :pending',
            ExpressionAttributeNames={
                '#nid': node_id,
                '#status': 'status',
                '#startedAt': 'startedAt',
                # PR2 dispatch-generation fence: a per-node monotonic counter
                # incremented on EVERY conditional pending->running transition
                # (first dispatch: 0->1; each watchdog re-dispatch: +1). The
                # worker carries the resulting value; its tool-call reserve is
                # fenced against it (same-transaction ConditionCheck), so a
                # stale re-dispatched-away worker is refused before any side
                # effect. Incremented INSIDE this exactly-once dispatch guard
                # so the counter advances once per real dispatch, never on a
                # lost race.
                '#gen': 'dispatchGeneration',
            },
            ExpressionAttributeValues={
                ':status': 'running',
                ':startedAt': now,
                ':pending': 'pending',
                ':one': 1,
            },
            ReturnValues='UPDATED_NEW',
        )
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
            # Another dispatcher already moved this node out of 'pending' —
            # dispatch is exactly-once, so skip the node.started event and the
            # SQS send entirely. Not an error: this is the guard doing its job.
            _log_event(
                'node_dispatch_skipped_not_pending',
                executionId=execution_id,
                workflowId=workflow_id,
                nodeId=node_id,
            )
            return
        # Any other DynamoDB error is unexpected — never swallow a DB write
        # error; surface it so the dispatch failure is observable.
        _logger.error(
            'invoke_node: conditional dispatch write failed for execution=%s node=%s: %s',
            execution_id, node_id, exc,
        )
        raise

    # Publish node.started event
    events.publish_node_started(
        execution_id=execution_id,
        workflow_id=workflow_id,
        node_id=node_id,
        agent_id=agent_id,
        started_at=now,
        **_run_id_kwargs,
    )

    # Dispatch the node to the worker over the shared SQS queue. The message
    # carries the workflow-node discriminator so the worker can tell it apart
    # from a supervisor task message on the same queue. The worker runs the
    # agent and emits the node-completed / node-failed event that this step
    # runner consumes (via its EventBridge rules) to advance the DAG.
    queue_url = os.environ.get('WORKER_QUEUE_URL')
    if not queue_url:
        _logger.warning(
            'WORKER_QUEUE_URL is not set; cannot dispatch node %s of execution %s',
            node_id, execution_id,
        )
        return

    message = workflow_contract.build_node_dispatch_message(
        execution_id=execution_id,
        node_id=node_id,
        workflow_id=workflow_id,
        agent_id=agent_id,
        input=input_data,
        configuration=configuration,
        trace_context=tracing.active_trace_context(),
        # Queue-wait metric: reuse the timestamp already computed above for
        # the node.started event/state update rather than taking a second
        # "now" reading — dispatch and node.started are the same instant for
        # this purpose.
        dispatched_at=now,
        # PR2 dispatch-generation fence: carry the generation this dispatch
        # just wrote so the worker's tool-call reserve can be fenced against
        # the execution row's current generation. None (omitted) when the
        # response did not surface a parseable generation, keeping the message
        # byte-identical to a pre-fence dispatch.
        dispatch_generation=_extract_dispatch_generation(_dispatch_write, node_id),
        **_run_id_kwargs,
    )

    # H3 trace-context propagation (architect task f4f4bab3-7a07-4acf-ba43-
    # ba43bb488444): add the standard AWSTraceHeader MessageAttribute (the
    # exact attribute name X-Ray/Lambda natively recognize for SQS linking)
    # ONLY when an active X-Ray segment exists. The body traceContext above
    # is already additive via the contract builder's kwarg. With no active
    # segment (the default in tests / local dev), neither is added — the
    # dispatch stays byte-identical to the pre-feature message
    # (property-tested).
    send_kwargs = {'QueueUrl': queue_url, 'MessageBody': json.dumps(message)}
    trace_context = message.get('traceContext')
    if trace_context and trace_context.get('xrayTraceHeader'):
        send_kwargs['MessageAttributes'] = {
            'AWSTraceHeader': {
                'DataType': 'String',
                'StringValue': trace_context['xrayTraceHeader'],
            },
        }
    _get_sqs_client().send_message(**send_kwargs)


def handle_node_completion(
    execution_id: str, node_id: str, output: dict, usage: list | None = None,
    *, dispatched_at: str | None = None, worker_started_at: str | None = None,
) -> None:
    """Handle a completed node and advance the workflow.

    1. Update node status → completed in DynamoDB (same call also persists
       the sanitized usage array + per-node usage totals — usage rollup hop)
    2. Publish workflow.node.completed event
    3. Evaluate conditional edges on outgoing edges
    4. For conditional edges that evaluate to false → mark downstream as skipped
    5. For convergence nodes → check if all predecessors complete
    6. Invoke ready nodes
    7. If all nodes complete → mark execution completed

    ``usage`` is additive and optional: a list of worker usage records for
    this node (the caller — ``index.handler`` — extracts it from the
    event's top-level ``usage`` key, falling back to ``output['usage']``).
    When omitted, this function itself falls back to ``output.get('usage',
    [])`` so a direct caller need not duplicate that fallback. Sanitized via
    ``parse_usage_array``/``aggregate_usage`` — malformed usage degrades to
    empty totals rather than raising. Persisted as a per-node SET (never an
    ADD) in the SAME update_item call that marks the node completed, so a
    duplicate delivery guarded by the status check below writes it at most
    once, and even an unguarded re-write is byte-identical (last-write-wins).

    ``dispatched_at`` / ``worker_started_at`` are additive and optional
    (queue-wait metric): the step runner's dispatch timestamp and the
    worker's invocation-start timestamp, both echoed back on the node-result
    event (see ``workflow_contract.NodeResultDetail``). When both are
    present and parseable, a ``NodeQueueWaitMs`` metric is emitted — the
    delta between dispatch and worker start. Missing/unparseable values
    simply skip the metric (best-effort, never fabricated), matching the
    existing ``NodeDurationMs`` convention.
    """
    execution = _load_execution(execution_id)
    if not execution:
        return

    workflow = _load_workflow(execution.get('workflowId', ''))
    if not workflow:
        return

    definition = _parse_definition(workflow)
    nodes = definition.get('nodes', [])
    edges = definition.get('edges', [])
    node_results = execution.get('nodeResults', {})

    # Completed node's prior recorded data. Under write-then-signal (decision
    # O2) this is already 'completed' — the worker persisted it BEFORE emitting
    # the event this handler consumes.
    node_data = node_results.get(node_id, {})

    now = _now_iso()

    # Usage rollup: sanitize the caller-supplied usage array (falling back to
    # output['usage'] when the caller omitted it) and compute this node's
    # totals. Both are defensive — malformed input degrades to [] / all-zero
    # totals rather than raising, so usage processing can never fail the
    # workflow.
    sanitized_usage = parse_usage_array(usage if usage is not None else output.get('usage', []))
    node_usage_totals = aggregate_usage(sanitized_usage)

    # First-write-wins completion (decision O3, conditional write #2). Under
    # write-then-signal (decision O2) the WORKER persists status=completed +
    # output to nodeResults[nodeId] BEFORE emitting workflow.node.completed, so
    # in production this conditional write is a NO-OP — its ConditionExpression
    # (status <> completed) fails against the worker's already-committed
    # completion — and the event serves purely as a DAG-advance signal.
    #
    # It is KEPT (not removed) as a first-write-wins backstop so a direct
    # invocation, an in-flight pre-feature event whose producer did not write,
    # or a lost worker write still records the completion here; whoever writes
    # first wins and a duplicate is a no-op. The old status-read early-return
    # (``if node_data.status == 'completed': return``) is DELETED: under
    # write-then-signal the node is already 'completed' when this handler runs,
    # so an early-return would swallow every advance. Idempotency now rests on
    # the conditional dispatch/finalize guards below, which absorb repeated
    # advancement (design decision O3).
    try:
        _executions_table.update_item(
            Key={'executionId': execution_id},
            UpdateExpression=(
                'SET nodeResults.#nid.#status = :status, '
                'nodeResults.#nid.#completedAt = :completedAt, '
                'nodeResults.#nid.#output = :output, '
                'nodeResults.#nid.#usage = :usage, '
                'nodeResults.#nid.#usageTotals = :usageTotals'
            ),
            ConditionExpression='nodeResults.#nid.#status <> :completed',
            ExpressionAttributeNames={
                '#nid': node_id,
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
                ':usageTotals': node_usage_totals,
                ':completed': 'completed',
            },
        )
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') != 'ConditionalCheckFailedException':
            _logger.error(
                'handle_node_completion: completion write failed for execution=%s node=%s: %s',
                execution_id, node_id, exc,
            )
            raise
        # Already completed (the worker's write-then-signal write, or a
        # duplicate delivery) — benign; fall through to idempotent advancement.

    # Best-effort telemetry (WF-053). A metric or log failure must never break
    # DAG advancement, so both are wrapped / fire-and-forget.
    workflow_id = execution.get('workflowId', '')
    _log_event(
        'node_completed',
        executionId=execution_id,
        workflowId=workflow_id,
        nodeId=node_id,
        agentId=node_data.get('agentId') or None,
    )
    duration = _duration_ms(node_data.get('startedAt'), now)
    if duration is not None:
        _emit_metric(METRIC_NODE_DURATION_MS, duration, UNIT_MILLISECONDS, workflow_id=workflow_id)

    # Queue-wait metric (dispatch -> worker-start delta). Both timestamps are
    # additive and best-effort: absent on any pre-feature dispatch/worker, or
    # if either is unparseable, the metric is simply skipped — never
    # fabricated. Reuses the same _duration_ms helper as NodeDurationMs.
    queue_wait = _duration_ms(dispatched_at, worker_started_at)
    if queue_wait is not None:
        _emit_metric(METRIC_NODE_QUEUE_WAIT_MS, queue_wait, UNIT_MILLISECONDS, workflow_id=workflow_id)

    # NOTE: workflow.node.completed is NOT re-emitted here. This handler is
    # triggered BY that event (the worker is its sole producer), and the step
    # runner's own EventBridge rule consumes workflow.node.completed — so
    # re-emitting it would self-trigger an infinite loop. We only advance the
    # DAG below and emit the terminal workflow.completed when all nodes finish.

    # Reflect this completion in the local view for edge-eval + frontier.
    node_results[node_id] = {**node_data, 'status': 'completed', 'output': output}

    # Evaluate this node's outgoing conditional edges (mark + persist skips of
    # false-branch targets), then advance via the shared re-entry primitive.
    _evaluate_and_persist_skips(execution_id, node_id, output, edges, node_results)

    # Advance-only via schedule_frontier: dispatch pending-ready nodes
    # (conditional) and finalize when all nodes are terminal (conditional). The
    # SAME primitive is reused verbatim by resume_execution and the watchdog
    # reconciler (build-once re-entry, design §1).
    execution_view = {**execution, 'nodeResults': node_results}
    schedule_frontier(execution_view, workflow, default_input=output)


def _evaluate_and_persist_skips(execution_id, node_id, output, edges, node_results):
    """Evaluate a completed node's outgoing conditional edges and mark every
    false-branch target 'skipped' (both in the passed local ``node_results``
    view and persisted to DynamoDB).

    Extracted from handle_node_completion so the resume/reconcile paths can
    re-run edge evaluation for a completed node whose conditional successors
    are still 'pending' — the §6 edge-case where a lost signal stranded a
    false branch. Idempotent: re-marking a 'skipped' node writes the identical
    value (skipped is terminal, never re-dispatched).
    """
    for edge in [e for e in edges if e.get('source') == node_id]:
        condition = edge.get('condition')
        if condition and not evaluate_condition(condition, output):
            target_id = edge['target']
            node_results[target_id] = {**node_results.get(target_id, {}), 'status': 'skipped'}
            _executions_table.update_item(
                Key={'executionId': execution_id},
                UpdateExpression='SET nodeResults.#nid.#status = :status',
                ExpressionAttributeNames={'#nid': target_id, '#status': 'status'},
                ExpressionAttributeValues={':status': 'skipped'},
            )


def _finalize_execution(execution, output) -> bool:
    """Conditionally finalize an execution (running->completed) and emit the
    terminal workflow.completed event (decision O3, conditional write #3).

    The ConditionExpression (status = running) ensures exactly one advancement
    finalizes even under concurrent tail completions or a resume/reconcile
    racing a live advance. Returns True if THIS call finalized, False if the
    execution had already left 'running'. Never emits a duplicate event.
    """
    execution_id = execution['executionId']
    now = _now_iso()
    try:
        _executions_table.update_item(
            Key={'executionId': execution_id},
            UpdateExpression='SET #status = :status, #completedAt = :completedAt',
            ConditionExpression='#status = :running',
            ExpressionAttributeNames={'#status': 'status', '#completedAt': 'completedAt'},
            ExpressionAttributeValues={
                ':status': 'completed',
                ':completedAt': now,
                ':running': 'running',
            },
        )
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
            return False
        _logger.error(
            '_finalize_execution: conditional finalize failed for execution=%s: %s',
            execution_id, exc,
        )
        raise
    events.publish_workflow_completed(
        execution_id=execution_id,
        workflow_id=execution.get('workflowId', ''),
        completed_at=now,
        output=output or {},
        eval_run_id=execution.get('evalRunId'),
    )
    return True


def schedule_frontier(execution, workflow, *, default_input=None) -> list:
    """Shared, idempotent DAG re-entry primitive (design §1).

    Re-derives the ready frontier purely from the persisted node statuses on
    the passed execution row, conditionally dispatches every ready node, and
    finalizes the execution when all nodes are terminal. It reads status ONLY
    from the row (never a caller-supplied node list), so completion-advance,
    resume, and the watchdog reconciler all reuse it verbatim.

    Idempotent by construction: the conditional pending->running dispatch guard
    in ``invoke_node`` absorbs repeated/racing dispatch of the same node, and
    ``_finalize_execution``'s conditional running->completed guard makes
    finalize exactly-once. A lost signal (0 runs) and a duplicate/replayed
    signal (N runs) therefore both converge to one dispatch per node and one
    finalize per execution.

    ``default_input`` is the input handed to each freshly dispatched ready node
    — the completing node's output for completion-advance; ``{}`` for resume /
    reconcile (matching a fresh root dispatch, where no single triggering
    output exists). Returns the list of node_ids dispatched this pass.
    """
    execution_id = execution['executionId']
    workflow_id = execution.get('workflowId', '')
    definition = _parse_definition(workflow)
    nodes = definition.get('nodes', [])
    edges = definition.get('edges', [])
    node_results = execution.get('nodeResults', {})

    status_map = {
        n['id']: node_results.get(n['id'], {}).get('status', 'pending') for n in nodes
    }

    ready_ids = find_ready_nodes(nodes, edges, status_map)

    configuration = workflow.get('configuration', '{}')
    if isinstance(configuration, str):
        configuration = json.loads(configuration)

    input_data = default_input if default_input is not None else {}
    dispatched = []
    for ready_id in ready_ids:
        node = next((n for n in nodes if n['id'] == ready_id), None)
        if node:
            # Per-node configuration overrides workflow-level per-key
            # (decision 59376546) — same merge as the root-dispatch site.
            invoke_node(execution_id, workflow_id, node, input_data,
                        merge_node_configuration(configuration, node),
                        run_id=execution.get('runId'))
            dispatched.append(ready_id)

    all_terminal = bool(nodes) and all(
        status_map.get(n['id'], 'pending') in ('completed', 'skipped', 'failed')
        for n in nodes
    )
    if all_terminal:
        _finalize_execution(execution, input_data)

    return dispatched


def _reconcile_completed_edges(execution, workflow) -> None:
    """Re-evaluate outgoing conditional edges of every already-'completed'
    node whose targets may still be un-pruned (design §6 edge-case).

    On resume/reconcile a completion whose stepRunner crashed before persisting
    a false-branch skip would otherwise strand that target 'pending' forever.
    Re-running edge evaluation for completed nodes (using each node's persisted
    output) is idempotent and repairs that gap before the frontier is scheduled.
    """
    definition = _parse_definition(workflow)
    edges = definition.get('edges', [])
    node_results = execution.get('nodeResults', {})
    execution_id = execution['executionId']
    for nid, nr in list(node_results.items()):
        if nr.get('status') == 'completed':
            _evaluate_and_persist_skips(
                execution_id, nid, nr.get('output', {}) or {}, edges, node_results,
            )


def resume_execution(execution_id: str) -> None:
    """Advance-only resume of a stuck execution (decisions O1 + O5).

    SECURITY: the caller supplies ONLY ``executionId``; the server re-derives
    the entire frontier from the persisted EXECUTIONS_TABLE row via
    ``schedule_frontier`` — never from a caller-provided node list or status
    override (the ``execution.resume.requested`` event carries no frontier
    data; any extra fields are ignored). This prevents a caller from forcing
    dispatch of arbitrary nodes, resurrecting skipped/false-branch nodes, or
    replaying completed side-effecting nodes.

    Contract:
      * running   -> allowed, idempotent. Re-derives the frontier and dispatches
                     only pending-ready nodes; NEVER re-dispatches a 'running'
                     node (decision O1 — re-driving a possibly-live worker is the
                     watchdog stall-detector's job, gated by the stall threshold
                     + first-write-wins). Concurrency-safe: every dispatch funnels
                     through the conditional pending->running guard, so a resume
                     racing a live advance or a watchdog sweep converges to one
                     dispatch per node.
      * pending   -> allowed, equivalent to (re)start: flip to running, then
                     schedule roots.
      * completed / cancelled / failed -> REJECTED (decision O5): terminal,
                     nothing to resume; no event/dispatch, returns unchanged.
    """
    execution = _load_execution(execution_id)
    if not execution:
        _log_event('resume_execution_not_found', executionId=execution_id)
        return

    status = execution.get('status')
    if status in ('completed', 'cancelled', 'failed'):
        # O5: terminal states are not resumable. Idempotent reject — no event,
        # no dispatch.
        _log_event('resume_execution_rejected_terminal', executionId=execution_id, status=status)
        return

    workflow = _load_workflow(execution.get('workflowId', ''))
    if not workflow:
        _log_event('resume_execution_workflow_missing', executionId=execution_id)
        return

    if status == 'pending':
        # Equivalent to (re)start: flip pending->running (conditional) so the
        # frontier + finalize guard operate on a 'running' row. A concurrent
        # real start winning the flip just means we reload and advance.
        now = _now_iso()
        try:
            _executions_table.update_item(
                Key={'executionId': execution_id},
                UpdateExpression='SET #status = :running, #startedAt = :startedAt',
                ConditionExpression='#status = :pending',
                ExpressionAttributeNames={'#status': 'status', '#startedAt': 'startedAt'},
                ExpressionAttributeValues={
                    ':running': 'running',
                    ':pending': 'pending',
                    ':startedAt': now,
                },
            )
            execution['status'] = 'running'
        except ClientError as exc:
            if exc.response.get('Error', {}).get('Code') != 'ConditionalCheckFailedException':
                raise
            execution = _load_execution(execution_id) or execution

    _log_event('resume_execution', executionId=execution_id, workflowId=execution.get('workflowId', ''))

    # Repair any false-branch skip lost to a crash (§6), then re-derive and
    # advance the frontier from persisted state. Reload after the skip writes
    # so schedule_frontier sees the freshest statuses.
    _reconcile_completed_edges(execution, workflow)
    execution = _load_execution(execution_id) or execution
    schedule_frontier(execution, workflow)


def handle_node_failure(execution_id: str, node_id: str, error: str) -> None:
    """Handle a failed node — retry or fail the execution.

    1. Check retry policy for the node
    2. If retryable → increment retryCount, calculate backoff, schedule retry
    3. If not retryable or retries exhausted → mark node failed
    4. Publish appropriate events
    5. Mark execution as failed if no retry
    """
    execution = _load_execution(execution_id)
    if not execution:
        return

    workflow = _load_workflow(execution.get('workflowId', ''))
    if not workflow:
        return

    definition = _parse_definition(workflow)
    nodes = definition.get('nodes', [])
    node_results = execution.get('nodeResults', {})

    node_data = node_results.get(node_id, {})
    agent_id = node_data.get('agentId', '')
    retry_count = node_data.get('retryCount', 0)

    # Idempotency guard against duplicate deliveries. If the persisted node
    # status is already the terminal 'failed' (retries exhausted), this is a
    # replay of the same node-failed event — return without re-updating state
    # or re-emitting the terminal workflow.failed event. A node still
    # 'running'/'pending' is NOT terminal, so the legitimate retry path below
    # (retries remaining) still runs.
    if node_data.get('status') == 'failed':
        return

    # Find the node definition to check retry policy
    node_def = next((n for n in nodes if n['id'] == node_id), None)
    retry_policy = node_def.get('data', {}).get('retryPolicy', {}) if node_def else {}

    max_retries = retry_policy.get('maxRetries', 0)
    retryable_errors = retry_policy.get('retryableErrors', [])
    backoff_base = retry_policy.get('backoffBase', 1.0)
    backoff_max = retry_policy.get('backoffMax', 60.0)

    now = _now_iso()

    # Governance-smell backstop (board task 9099b8cb, decision 843a959e /
    # design storm-proof path). A SETTLED denial (policy-denied / authz) is
    # never-retry; if a stale or tampered per-node ``retryableErrors`` lists
    # such a class, that is an attempt to WIDEN a never-retry governance class —
    # the taxonomy refuses the retry (should_retry vetoes below), and reaching
    # this decision at all is the signal to file. Storm-proof BY CONSTRUCTION:
    # a never-retry class fails the node immediately (no node.retrying
    # scheduled), and the terminal-status idempotency guard above returns on a
    # duplicate delivery — so at most ONE smell is emitted per node-failure.
    failure_class = failure_taxonomy.classify(error)
    if (
        error in retryable_errors
        and failure_taxonomy.is_governance_smell_on_retry(failure_class)
    ):
        _log_event(
            'retry_governance_smell',
            executionId=execution_id,
            workflowId=execution.get('workflowId', ''),
            nodeId=node_id,
            agentId=agent_id or None,
            errorClass=error,
            failureClass=failure_class.value,
        )
        _emit_metric(
            METRIC_RETRY_GOVERNANCE_SMELL, 1.0, UNIT_COUNT,
            workflow_id=execution.get('workflowId', ''),
        )

    if should_retry(error, retryable_errors, retry_count, max_retries):
        # Retry the node
        backoff = calculate_backoff(retry_count, backoff_base, backoff_max)
        new_retry_count = retry_count + 1

        _executions_table.update_item(
            Key={'executionId': execution_id},
            UpdateExpression='SET nodeResults.#nid.#rc = :rc, nodeResults.#nid.#status = :status',
            ExpressionAttributeNames={
                '#nid': node_id,
                '#rc': 'retryCount',
                '#status': 'status',
            },
            ExpressionAttributeValues={':rc': new_retry_count, ':status': 'pending'},
        )

        events.publish_node_retrying(
            execution_id=execution_id,
            workflow_id=execution.get('workflowId', ''),
            node_id=node_id,
            agent_id=agent_id,
            retry_count=new_retry_count,
            backoff=backoff,
        )
        # Correlation log only — a retry is not a terminal failure, so it does
        # NOT emit the NodeFailure metric (that would double-count retries).
        _log_event(
            'node_retrying',
            executionId=execution_id,
            workflowId=execution.get('workflowId', ''),
            nodeId=node_id,
            agentId=agent_id or None,
            retryCount=new_retry_count,
        )
    else:
        # No retry — mark node and execution as failed.
        # The single ``#status`` alias ('status') is reused for BOTH the node
        # (nodeResults.#nid.#status) and the execution (#status) attributes.
        # (A leftover ``#nstatus`` alias here was declared but never referenced
        # in the expression, so DynamoDB rejected the whole UpdateItem with
        # "Value provided in ExpressionAttributeNames unused in expressions" —
        # crashing the handler on every retry and stranding the execution in
        # status=running. Both statuses ARE meant to persist; the alias was the
        # only defect.)
        _executions_table.update_item(
            Key={'executionId': execution_id},
            UpdateExpression='SET nodeResults.#nid.#status = :nstatus, nodeResults.#nid.#error = :error, #status = :estatus, #failedAt = :failedAt',
            ExpressionAttributeNames={
                '#nid': node_id,
                '#status': 'status',
                '#failedAt': 'failedAt',
                '#error': 'error',
            },
            ExpressionAttributeValues={
                ':nstatus': 'failed',
                ':error': error,
                ':estatus': 'failed',
                ':failedAt': now,
            },
        )

        # NOTE: workflow.node.failed is NOT re-emitted here. Like completion,
        # this handler is triggered BY that event (the worker is its sole
        # producer) and the step runner's own EventBridge rule consumes it, so
        # re-emitting would self-trigger. We keep the terminal workflow.failed.

        # Best-effort telemetry (WF-053): terminal failure count + correlation
        # log. Both are non-fatal — execution failure handling proceeds
        # regardless of the telemetry backend.
        workflow_id = execution.get('workflowId', '')
        _log_event(
            'node_failed',
            executionId=execution_id,
            workflowId=workflow_id,
            nodeId=node_id,
            agentId=agent_id or None,
            error=error,
        )
        _emit_metric(METRIC_NODE_FAILURE, 1, UNIT_COUNT, workflow_id=workflow_id)

        events.publish_workflow_failed(
            execution_id=execution_id,
            workflow_id=execution.get('workflowId', ''),
            failed_node_id=node_id,
            error=error,
            failed_at=now,
            eval_run_id=execution.get('evalRunId'),
        )

        # CIT-123 slice 3: compensation unwind trigger (design D1/D2, decision
        # dfe2d9a1). Evaluated AFTER the terminal failure is fully persisted
        # and published above, so a workflow with no compensation policy (the
        # overwhelmingly common case today) is byte-identical to the
        # pre-feature code path up to this point, and the gate itself is a
        # pure read + at most one additional conditional write — never a
        # second failure path.
        _maybe_trigger_compensation_unwind(
            execution_id, node_id, error, workflow, execution, node_results,
        )


def _reverse_topo_compensation_plan(nodes, edges, node_results, failing_node_id) -> list[str]:
    """Return the ORIGINAL node ids to compensate, in strict reverse-
    topological order (design D5).

    Selection (design D1/D5/D1-INDETERMINATE-nuance): a node qualifies only
    when ALL of:
      * it is not the failing node itself (its output is indeterminate);
      * its persisted status is exactly 'completed' (a 'skipped' or
        'pending' predecessor never ran a side effect);
      * its definition carries a well-formed ``compensation`` block
        (``workflow_contract.normalize_compensation_block``);
      * that block's ``sideEffecting`` is True (the default).

    Pure function — no I/O, no mutation of any input.
    """
    order = topological_sort(nodes, edges)
    qualifying: set[str] = set()
    for node in nodes:
        nid = node['id']
        if nid == failing_node_id:
            continue
        if node_results.get(nid, {}).get('status') != 'completed':
            continue
        try:
            block = workflow_contract.normalize_compensation_block(node)
        except ValueError:
            # A malformed block at unwind time is treated the same as
            # 'absent' (fail-safe: never let a data error stop workflows
            # from completing their forward run, which already happened) —
            # skip this node's compensation. Slice 1 validation already
            # rejects malformed blocks at definition-write time; reaching
            # this branch means a definition was authored before that
            # validation existed.
            continue
        if block is None or not block.get('sideEffecting', True):
            continue
        qualifying.add(nid)

    # Reverse of forward topological order, filtered to qualifying nodes —
    # this is strictly reverse-topological (a node's compensation always
    # runs before any of its own predecessors' compensations).
    return [nid for nid in reversed(order) if nid in qualifying]


def _comp_key(original_node_id: str) -> str:
    """The ``nodeResults`` pseudo-node key for a node's compensation state
    (design D7). Never collides with a real node id (real ids come only
    from the workflow definition's ``nodes[].id``, which the frontend/
    backend validator disallows containing '#' — the same discriminator
    convention CIT-121 uses for tool-call sort keys)."""
    return f'{original_node_id}#comp'


def _dispatch_compensation(
    execution_id: str, workflow_id: str, original_node_id: str, block: dict,
    compensation_generation: int, *, run_id: str | None = None,
) -> None:
    """Write the #comp pseudo-node to 'compensating' and dispatch it to the
    worker seam over the shared SQS queue (design D2/D4).

    Inert-safety (scope item d): with no ``WORKER_QUEUE_URL`` configured this
    degrades exactly like ``invoke_node``'s own missing-queue-url branch — it
    logs and returns without dispatching, never raising. The message carries
    the RAW, unresolved template ``args`` (the slice-2 renderer is NOT
    imported here); rendering is worker-side, slice 4.
    """
    now = _now_iso()
    comp_key = _comp_key(original_node_id)

    _executions_table.update_item(
        Key={'executionId': execution_id},
        UpdateExpression=(
            'SET nodeResults.#cid.#status = :status, '
            'nodeResults.#cid.#dispatchedAt = :dispatchedAt, '
            'nodeResults.#cid.#gen = :gen'
        ),
        ExpressionAttributeNames={
            '#cid': comp_key,
            '#status': 'status',
            '#dispatchedAt': 'dispatchedAt',
            '#gen': 'compensationGeneration',
        },
        ExpressionAttributeValues={
            ':status': 'compensating',
            ':dispatchedAt': now,
            ':gen': compensation_generation,
        },
    )

    _log_event(
        'compensation_dispatch',
        executionId=execution_id,
        workflowId=workflow_id,
        nodeId=original_node_id,
        tool=block['tool'],
    )

    queue_url = os.environ.get('WORKER_QUEUE_URL')
    if not queue_url:
        _logger.warning(
            'WORKER_QUEUE_URL is not set; cannot dispatch compensation for node %s of execution %s',
            original_node_id, execution_id,
        )
        return

    message = workflow_contract.build_compensation_dispatch_message(
        execution_id=execution_id,
        node_id=comp_key,
        workflow_id=workflow_id,
        tool=block['tool'],
        args=block['args'],
        compensation_generation=compensation_generation,
        dispatched_at=now,
        run_id=run_id,
    )
    _get_sqs_client().send_message(QueueUrl=queue_url, MessageBody=json.dumps(message))


def _summary_add_completed(summary: dict, node_id: str) -> dict:
    return {**summary, 'completed': summary.get('completed', []) + [node_id]}


# --- CIT-123 slice 5 (interim sink, scope A item 2) --------------------------
#
# INTERIM CONTRACT, pending CIT-126 (the recovery queue does not exist yet).
# ``compensationSummary`` is the durable, resumable checkpoint a future
# CIT-126 consumer will drain — it must carry enough for that consumer to act
# WITHOUT re-deriving a failure classification from the raw error string a
# second time (the taxonomy module, ``common/failure_taxonomy.py``, is
# already the single source of truth for that classification — this reuses
# it, never re-implements a second classifier).
#
# Shape (additive to the existing 'completed'/'failed'/'stoppedAt'/'reason'
# keys already written by slice 3 — none of those are removed or renamed, so
# any existing reader of this dict keeps working unchanged):
#
#   compensationSummary = {
#     'completed': [nodeId, ...],       # unchanged (slice 3)
#     'failed': [nodeId, ...],          # unchanged (slice 3)
#     'stoppedAt': nodeId,              # unchanged (slice 3) — present only
#                                       # once the unwind has stopped
#     'reason': str,                    # unchanged (slice 3) — raw error
#                                       # string of the stopping compensation
#     'entries': [                      # NEW, slice 5 — one entry per
#       {                                #   FAILED compensation, in the
#         'nodeId': str,                 #   order they failed (currently at
#         'error': str,                  #   most one, since onFailure='stop'
#         'failureClass': str,           #   halts the unwind at the first
#         'recommendedAction': str,      #   failure — the list shape is kept
#       },                               #   so a future onFailure='continue'
#       ...                              #   mode can append more without a
#     ],                                 #   contract change.
#   }
#
# ``failureClass`` is the ``str``-valued ``FailureClass`` member name (e.g.
# 'policy-denied', 'unknown') — the SAME classification
# ``_maybe_trigger_compensation_unwind`` already uses to decide whether to
# compensate at all (CIRCUIT_OPEN/APPROVAL_ABSENT carve-out), so a consumer
# reading this row sees one consistent vocabulary end to end.
#
# ``recommendedAction`` is a FIXED, closed interim vocabulary (never a free
# string) so CIT-126 can switch on it without NLP/string-matching over
# ``error``:
#   * 'escalate_to_human'  — a settled governance DENY (POLICY_DENIED) or an
#     authorization failure (AUTHZ). Never auto-retryable; a human decision
#     is required (mirrors D6's "escalate rather than bypass").
#   * 'retry_after_target_recovery' — the target was known-bad at call time
#     (CIRCUIT_OPEN) or the call was transient/throttled/timed-out
#     (TRANSIENT/THROTTLE/TIMEOUT). A future recovery queue would re-drive
#     these once the target is healthy; today they just stop the unwind.
#   * 'manual_review_required' — everything else (VALIDATION, APPROVAL_ABSENT,
#     INDETERMINATE, UNKNOWN, and any tool-crash class the taxonomy has no
#     specific mapping for). The conservative default: never silently assume
#     safe-to-retry or safe-to-ignore for an unclassified/ambiguous failure.
COMPENSATION_RECOMMENDED_ACTIONS = (
    'escalate_to_human',
    'retry_after_target_recovery',
    'manual_review_required',
)

_FAILURE_CLASS_TO_RECOMMENDED_ACTION = {
    failure_taxonomy.FailureClass.POLICY_DENIED: 'escalate_to_human',
    failure_taxonomy.FailureClass.AUTHZ: 'escalate_to_human',
    failure_taxonomy.FailureClass.CIRCUIT_OPEN: 'retry_after_target_recovery',
    failure_taxonomy.FailureClass.TRANSIENT: 'retry_after_target_recovery',
    failure_taxonomy.FailureClass.THROTTLE: 'retry_after_target_recovery',
    failure_taxonomy.FailureClass.TIMEOUT: 'retry_after_target_recovery',
}


def _recommended_action_for(failure_class: 'failure_taxonomy.FailureClass') -> str:
    """Map a taxonomy ``FailureClass`` to the fixed interim vocabulary above.
    Any class with no explicit mapping (VALIDATION, APPROVAL_ABSENT,
    INDETERMINATE, UNKNOWN, ...) conservatively defaults to
    'manual_review_required' — never silently assumed retryable or
    auto-escalated."""
    return _FAILURE_CLASS_TO_RECOMMENDED_ACTION.get(failure_class, 'manual_review_required')


def _summary_mark_stopped(summary: dict, node_id: str, reason: str) -> dict:
    """Additive: keeps writing the pre-slice-5 'failed'/'stoppedAt'/'reason'
    keys UNCHANGED (byte-identical for any reader that only looks at those),
    and appends one classified 'entries' record — the CIT-126-facing interim
    contract documented above."""
    failure_class = failure_taxonomy.classify(reason)
    entry = {
        'nodeId': node_id,
        'error': reason,
        'failureClass': failure_class.value,
        'recommendedAction': _recommended_action_for(failure_class),
    }
    return {
        **summary,
        'failed': summary.get('failed', []) + [node_id],
        'stoppedAt': node_id,
        'reason': reason,
        'entries': summary.get('entries', []) + [entry],
    }


def _maybe_trigger_compensation_unwind(
    execution_id: str, failing_node_id: str, error: str, workflow: dict,
    execution: dict, node_results: dict,
) -> None:
    """Evaluate the slice-1 workflow-level compensation policy and, if it
    applies to this terminal failure, compute the reverse-topological plan
    and dispatch the FIRST compensation (design D5: sequential, one at a
    time).

    Gates, all of which must hold for an unwind to fire (scope item a):
      1. The workflow's ``configuration.compensation`` policy normalizes to
         ``enabled: True`` and ``trigger.mode == 'on_terminal_failure'``
         (``workflow_contract.normalize_compensation_policy`` — absent
         policy defaults to disabled, so this is the byte-identical-when-
         absent path).
      2. The failing node's classified failure is NOT in the
         CIRCUIT_OPEN / RETRY_AFTER_HUMAN carve-out (decision dfe2d9a1) —
         those are left for the future recovery queue, never compensated.
      3. At least ``trigger.minCompletedNodes`` qualifying nodes exist in
         the reverse-topo plan (an early failure with too few completed
         side effects skips the unwind ceremony entirely).

    A workflow with no policy, a disabled policy, or a plan of zero
    qualifying nodes writes NOTHING beyond what ``handle_node_failure``
    already wrote — no ``compensationStatus``, no ``compensationGeneration``,
    no ``#comp`` keys. This is the byte-identical assertion under test.
    """
    raw_policy = None
    configuration = workflow.get('configuration')
    if isinstance(configuration, str):
        try:
            configuration = json.loads(configuration)
        except ValueError:
            configuration = None
    if isinstance(configuration, dict):
        raw_policy = configuration.get('compensation')

    try:
        policy = workflow_contract.normalize_compensation_policy(raw_policy)
    except ValueError:
        # A malformed policy behaves as disabled (fail-safe) — a workflow's
        # compensation config must never be able to CRASH the already-
        # terminal failure path it is layered on top of.
        return

    if not policy['enabled'] or policy['trigger']['mode'] != 'on_terminal_failure':
        return

    failure_class = failure_taxonomy.classify(error)
    if failure_class in (failure_taxonomy.FailureClass.CIRCUIT_OPEN,
                          failure_taxonomy.FailureClass.APPROVAL_ABSENT):
        # decision dfe2d9a1: CIRCUIT_OPEN and RETRY_AFTER_HUMAN (the
        # disposition for APPROVAL_ABSENT) do NOT compensate — left for the
        # future recovery queue.
        return

    definition = _parse_definition(workflow)
    nodes = definition.get('nodes', [])
    edges = definition.get('edges', [])

    plan = _reverse_topo_compensation_plan(nodes, edges, node_results, failing_node_id)
    if len(plan) < policy['trigger']['minCompletedNodes']:
        return
    if not plan:
        return

    # Mint the per-execution compensationGeneration fence (design D3/scope
    # item e) exactly once per unwind, and seed compensationStatus='running'
    # + the ordered plan. A SINGLE update_item call so a reader can never
    # observe compensationGeneration without compensationStatus (or vice
    # versa) — there is no partial-write window visible to another caller.
    _executions_table.update_item(
        Key={'executionId': execution_id},
        UpdateExpression=(
            'SET #compStatus = :running, #compPlan = :plan, #compSummary = :summary '
            'ADD #compGen :one'
        ),
        ExpressionAttributeNames={
            '#compStatus': 'compensationStatus',
            '#compPlan': 'compensationPlan',
            '#compSummary': 'compensationSummary',
            '#compGen': 'compensationGeneration',
        },
        ExpressionAttributeValues={
            ':running': 'running',
            ':plan': plan,
            ':summary': {'completed': [], 'failed': []},
            ':one': 1,
        },
    )
    fresh = _load_execution(execution_id) or execution
    generation = fresh.get('compensationGeneration', 1)

    first_node_id = plan[0]
    first_node_def = next((n for n in nodes if n['id'] == first_node_id), None)
    block = workflow_contract.normalize_compensation_block(first_node_def) if first_node_def else None
    if block is None:
        # Defensive: the plan was just built from a successful normalize —
        # this branch should be unreachable, but never dispatch a malformed
        # block if it somehow is.
        return

    workflow_id = execution.get('workflowId', '')
    _dispatch_compensation(
        execution_id, workflow_id, first_node_id, block, generation,
        run_id=execution.get('runId'),
    )


def handle_compensation_result(
    execution_id: str, original_node_id: str, *, success: bool,
    output: dict | None = None, error: str | None = None,
    compensation_generation: int | None = None,
) -> None:
    """Advance (or stop) a running unwind after one compensation's result.

    This is the compensation-side analogue of ``handle_node_completion`` /
    ``handle_node_failure`` — it is the single re-entry point the (future,
    slice-4) worker result event drives, and is called directly by tests
    that simulate that event today.

    Fencing (design D3/scope item e): if ``compensation_generation`` is
    supplied and does not match the execution's CURRENT
    ``compensationGeneration``, the result is a STALE delivery (e.g. a
    watchdog already re-drove the unwind and minted a new generation) and is
    ignored entirely — no state write, no further dispatch. Mirrors CIT-121's
    forward-dispatch generation fence.

    Idempotency: a result for a #comp pseudo-node that is already terminal
    ('compensated' or 'compensation_failed') is a no-op — no re-write, no
    re-dispatch of the next plan entry. This absorbs a duplicate delivery
    exactly like ``handle_node_completion``'s first-write-wins guard.

    On failure (onFailure='stop', the only supported/default behaviour per
    decision dfe2d9a1): the #comp node is marked 'compensation_failed', the
    execution's ``compensationStatus`` becomes 'partial', and
    ``compensationSummary`` records the stop point. The remaining plan is
    NEVER dispatched.
    """
    execution = _load_execution(execution_id)
    if not execution:
        return

    if execution.get('compensationStatus') not in ('running',):
        # No unwind in flight (never started, or already reached a terminal
        # compensationStatus) — a stray/duplicate result has nothing to
        # advance.
        return

    current_generation = execution.get('compensationGeneration')
    if compensation_generation is not None and compensation_generation != current_generation:
        _log_event(
            'compensation_result_stale_generation',
            executionId=execution_id,
            nodeId=original_node_id,
            resultGeneration=compensation_generation,
            currentGeneration=current_generation,
        )
        return

    comp_key = _comp_key(original_node_id)
    node_results = execution.get('nodeResults', {})
    comp_state = node_results.get(comp_key, {})
    if comp_state.get('status') in ('compensated', 'compensation_failed'):
        # Idempotent no-op: already terminal (duplicate delivery).
        return

    plan = execution.get('compensationPlan', [])
    try:
        current_index = plan.index(original_node_id)
    except ValueError:
        # Not part of the tracked plan — ignore rather than corrupt state.
        return

    summary = execution.get('compensationSummary', {'completed': [], 'failed': []})
    workflow_id = execution.get('workflowId', '')

    if not success:
        # onFailure='stop' (decision dfe2d9a1 — the only mode this slice
        # implements; 'continue' is deferred, see design D5 owner-call).
        # STOP the unwind: mark this compensation failed, record the stop
        # point, and never dispatch the remaining plan entries.
        new_summary = _summary_mark_stopped(summary, original_node_id, error or 'compensation_failed')
        # Mirror the SAME classification the summary entry just computed
        # (never re-classify) onto the #comp pseudo-node row (design D7),
        # so a UI or CIT-126 consumer reading either location sees identical
        # failureClass/recommendedAction values.
        new_entry = new_summary['entries'][-1]
        _executions_table.update_item(
            Key={'executionId': execution_id},
            UpdateExpression=(
                'SET nodeResults.#cid.#status = :failed, '
                'nodeResults.#cid.#error = :error, '
                'nodeResults.#cid.#failureClass = :failureClass, '
                'nodeResults.#cid.#recommendedAction = :recommendedAction, '
                '#compStatus = :partial, #compSummary = :summary'
            ),
            ConditionExpression='nodeResults.#cid.#status = :compensating',
            ExpressionAttributeNames={
                '#cid': comp_key,
                '#status': 'status',
                '#error': 'error',
                '#failureClass': 'failureClass',
                '#recommendedAction': 'recommendedAction',
                '#compStatus': 'compensationStatus',
                '#compSummary': 'compensationSummary',
            },
            ExpressionAttributeValues={
                ':failed': 'compensation_failed',
                ':error': error or 'compensation_failed',
                ':failureClass': new_entry['failureClass'],
                ':recommendedAction': new_entry['recommendedAction'],
                ':partial': 'partial',
                ':summary': new_summary,
                ':compensating': 'compensating',
            },
        )
        _log_event(
            'compensation_failed_stop',
            executionId=execution_id,
            workflowId=workflow_id,
            nodeId=original_node_id,
            error=error,
            failureClass=new_entry['failureClass'],
            recommendedAction=new_entry['recommendedAction'],
        )
        return

    # Success: mark this #comp node compensated, advance to the next plan
    # entry (if any), or finish the unwind.
    new_summary = _summary_add_completed(summary, original_node_id)
    is_last = current_index == len(plan) - 1
    final_status = 'completed' if is_last else 'running'
    try:
        _executions_table.update_item(
            Key={'executionId': execution_id},
            UpdateExpression=(
                'SET nodeResults.#cid.#status = :compensated, '
                '#compStatus = :finalStatus, #compSummary = :summary'
            ),
            ConditionExpression='nodeResults.#cid.#status = :compensating',
            ExpressionAttributeNames={
                '#cid': comp_key,
                '#status': 'status',
                '#compStatus': 'compensationStatus',
                '#compSummary': 'compensationSummary',
            },
            ExpressionAttributeValues={
                ':compensated': 'compensated',
                ':finalStatus': final_status,
                ':summary': new_summary,
                ':compensating': 'compensating',
            },
        )
    except ClientError as exc:
        if exc.response.get('Error', {}).get('Code') == 'ConditionalCheckFailedException':
            # Another delivery already advanced this #comp node — benign,
            # absorbs the duplicate.
            return
        _logger.error(
            'handle_compensation_result: advance write failed for execution=%s node=%s: %s',
            execution_id, original_node_id, exc,
        )
        raise

    if is_last:
        return

    workflow = _load_workflow(workflow_id)
    if not workflow:
        return
    definition = _parse_definition(workflow)
    nodes = definition.get('nodes', [])
    next_node_id = plan[current_index + 1]
    next_node_def = next((n for n in nodes if n['id'] == next_node_id), None)
    if not next_node_def:
        return
    block = workflow_contract.normalize_compensation_block(next_node_def)
    if block is None:
        return

    fresh = _load_execution(execution_id) or execution
    generation = fresh.get('compensationGeneration', current_generation or 1)
    _dispatch_compensation(
        execution_id, workflow_id, next_node_id, block, generation,
        run_id=execution.get('runId'),
    )


def cancel_execution(execution_id: str) -> None:
    """Cancel a running execution.

    1. Load execution from DynamoDB
    2. Update execution status → cancelled
    3. Mark all pending/running nodes as cancelled
    4. Publish workflow.failed event with cancellation reason
    """
    execution = _load_execution(execution_id)
    if not execution:
        return

    now = _now_iso()
    node_results = execution.get('nodeResults', {})

    # Mark all pending/running nodes as cancelled
    for nid, nr in node_results.items():
        if nr.get('status') in ('pending', 'running'):
            _executions_table.update_item(
                Key={'executionId': execution_id},
                UpdateExpression='SET nodeResults.#nid.#status = :status',
                ExpressionAttributeNames={'#nid': nid, '#status': 'status'},
                ExpressionAttributeValues={':status': 'cancelled'},
            )

    # Update execution status to cancelled
    _executions_table.update_item(
        Key={'executionId': execution_id},
        UpdateExpression='SET #status = :status, #completedAt = :completedAt',
        ExpressionAttributeNames={'#status': 'status', '#completedAt': 'completedAt'},
        ExpressionAttributeValues={':status': 'cancelled', ':completedAt': now},
    )

    events.publish_workflow_failed(
        execution_id=execution_id,
        workflow_id=execution.get('workflowId', ''),
        failed_node_id='',
        error='Execution cancelled',
        failed_at=now,
        eval_run_id=execution.get('evalRunId'),
    )
