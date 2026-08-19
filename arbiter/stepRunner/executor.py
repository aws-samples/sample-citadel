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
)
from condition import evaluate_condition
from retry import calculate_backoff, should_retry
from common import workflow_contract
from common.usage import aggregate_usage, parse_usage_array
from common.metrics_constants import (
    METRIC_NAMESPACE,
    METRIC_NODE_DURATION_MS,
    METRIC_NODE_FAILURE,
    METRIC_NODE_QUEUE_WAIT_MS,
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
        _executions_table.update_item(
            Key={'executionId': execution_id},
            UpdateExpression='SET nodeResults.#nid.#status = :status, nodeResults.#nid.#startedAt = :startedAt',
            ConditionExpression='nodeResults.#nid.#status = :pending',
            ExpressionAttributeNames={
                '#nid': node_id,
                '#status': 'status',
                '#startedAt': 'startedAt',
            },
            ExpressionAttributeValues={
                ':status': 'running',
                ':startedAt': now,
                ':pending': 'pending',
            },
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

    # Find the completed node's agent ID
    node_data = node_results.get(node_id, {})

    # Idempotency guard against duplicate deliveries. At-least-once transports
    # (SQS / EventBridge) can redeliver the same node-completed event. If the
    # persisted node status is already the terminal 'completed', this is a
    # replay — return without re-updating state, re-advancing the DAG,
    # re-invoking downstream nodes, or re-emitting the terminal
    # workflow.completed event.
    if node_data.get('status') == 'completed':
        return

    now = _now_iso()

    # Usage rollup: sanitize the caller-supplied usage array (falling back to
    # output['usage'] when the caller omitted it) and compute this node's
    # totals. Both are defensive — malformed input degrades to [] / all-zero
    # totals rather than raising, so usage processing can never fail the
    # workflow.
    sanitized_usage = parse_usage_array(usage if usage is not None else output.get('usage', []))
    node_usage_totals = aggregate_usage(sanitized_usage)

    # Update node to completed. The usage + usageTotals SET rides in the SAME
    # update_item call as status/completedAt/output — never a second call,
    # never an ADD — so reprocessing (if the guard above were ever bypassed)
    # writes the identical bytes under the same nodeResults[node_id] key.
    _executions_table.update_item(
        Key={'executionId': execution_id},
        UpdateExpression=(
            'SET nodeResults.#nid.#status = :status, '
            'nodeResults.#nid.#completedAt = :completedAt, '
            'nodeResults.#nid.#output = :output, '
            'nodeResults.#nid.#usage = :usage, '
            'nodeResults.#nid.#usageTotals = :usageTotals'
        ),
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
        },
    )

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

    # Update local state for ready-node calculation
    node_results[node_id] = {**node_data, 'status': 'completed', 'output': output}

    # Evaluate outgoing edges from this node
    outgoing_edges = [e for e in edges if e['source'] == node_id]
    for edge in outgoing_edges:
        condition = edge.get('condition')
        if condition:
            if not evaluate_condition(condition, output):
                # Condition false → skip the target node
                target_id = edge['target']
                node_results[target_id] = {**node_results.get(target_id, {}), 'status': 'skipped'}
                _executions_table.update_item(
                    Key={'executionId': execution_id},
                    UpdateExpression='SET nodeResults.#nid.#status = :status',
                    ExpressionAttributeNames={'#nid': target_id, '#status': 'status'},
                    ExpressionAttributeValues={':status': 'skipped'},
                )

    # Build node list with current statuses for find_ready_nodes
    nodes_with_status = []
    for n in nodes:
        nid = n['id']
        status = node_results.get(nid, {}).get('status', 'pending')
        nodes_with_status.append(n)
        node_results.setdefault(nid, {})['status'] = status

    status_map = {nid: nr.get('status', 'pending') for nid, nr in node_results.items()}

    # Find ready nodes
    ready_ids = find_ready_nodes(nodes, edges, status_map)

    configuration = workflow.get('configuration', '{}')
    if isinstance(configuration, str):
        configuration = json.loads(configuration)

    for ready_id in ready_ids:
        node = next((n for n in nodes if n['id'] == ready_id), None)
        if node:
            # Per-node configuration overrides workflow-level per-key
            # (decision 59376546) — same merge as the root-dispatch site.
            invoke_node(execution_id, execution.get('workflowId', ''), node, output,
                        merge_node_configuration(configuration, node),
                        run_id=execution.get('runId'))

    # Check if all nodes are terminal (completed, skipped, or failed)
    all_terminal = all(
        status_map.get(n['id'], 'pending') in ('completed', 'skipped', 'failed')
        for n in nodes
    )

    if all_terminal:
        # Finalize guard (conditional running->completed write). Under
        # concurrent tail completions two advancements can both observe
        # all-terminal; the ConditionExpression ensures exactly one flips the
        # execution to 'completed' and emits the terminal workflow.completed
        # event. A losing advancement raises ConditionalCheckFailedException
        # and is a no-op (never a duplicate finalize / duplicate event).
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
                # Execution already left 'running' (a concurrent advancement
                # finalized it, or it was cancelled/failed). Do not re-emit the
                # terminal event.
                return
            _logger.error(
                'handle_node_completion: conditional finalize failed for execution=%s: %s',
                execution_id, exc,
            )
            raise
        events.publish_workflow_completed(
            execution_id=execution_id,
            workflow_id=execution.get('workflowId', ''),
            completed_at=now,
            output=output,
            eval_run_id=execution.get('evalRunId'),
        )


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
        # No retry — mark node and execution as failed
        _executions_table.update_item(
            Key={'executionId': execution_id},
            UpdateExpression='SET nodeResults.#nid.#status = :nstatus, nodeResults.#nid.#error = :error, #status = :estatus, #failedAt = :failedAt',
            ExpressionAttributeNames={
                '#nid': node_id,
                '#status': 'status',
                '#failedAt': 'failedAt',
                '#nstatus': 'status',
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
