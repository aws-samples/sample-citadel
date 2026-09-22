"""Step Runner Lambda handler — routes EventBridge events to executor functions."""

from executor import (
    start_execution,
    handle_node_completion,
    handle_node_failure,
    handle_compensation_result,
    cancel_execution,
    resume_execution,
)
from common import workflow_contract
from common.tracing import annotate_execution, annotate_from_carried, extract_carried


def handler(event, context):
    """Route EventBridge events to the appropriate executor function."""
    detail_type = event.get('detail-type', '')
    detail = event.get('detail', {})

    # Consumer parse+annotate (architect task f4f4bab3-7a07-4acf-ba43-
    # ba43bb488444, H2/H4 hop): no-op-safe when detail carries no
    # traceContext or a malformed one (property-tested in
    # common/__tests__/test_tracing.py).
    annotate_from_carried(extract_carried(detail))

    # Finding 3d92ef6b (CIT-181): annotate_from_carried above only fires
    # when the detail carries a traceContext (carried-context hops); the
    # plain EventBridge workflow-dispatch path did not otherwise stamp
    # run_id/execution_id/correlation_id, leaving StepRunner spans
    # unqueryable. Stamp the ids this handler already has in the detail
    # payload directly, independent of traceContext presence.
    annotate_execution(
        run_id=detail.get('runId'),
        execution_id=detail.get('executionId'),
        correlation_id=detail.get('correlationId') or detail.get('executionId'),
        node_id=detail.get('nodeId'),
        workflow_id=detail.get('workflowId'),
    )

    if detail_type == 'execution.start.requested':
        start_execution(detail['executionId'], detail['workflowId'])
    elif detail_type == 'workflow.node.completed':
        output = detail.get('output', {})
        # Usage rollup hop: prefer the additive top-level 'usage' key (the
        # worker promotes it there via workflow_contract.build_node_result_detail);
        # fall back to output['usage'] for an in-flight event emitted before
        # this change, and finally to [] when neither is present.
        usage = detail.get('usage')
        if usage is None:
            usage = output.get('usage', [])
        # Queue-wait metric: dispatchedAt/workerStartedAt are additive and
        # optional on the detail (absent on any pre-feature worker/dispatch);
        # handle_node_completion treats missing values as best-effort skips.
        handle_node_completion(
            detail['executionId'], detail['nodeId'], output, usage,
            dispatched_at=detail.get('dispatchedAt'),
            worker_started_at=detail.get('workerStartedAt'),
        )
    elif detail_type == 'workflow.node.failed':
        handle_node_failure(detail['executionId'], detail['nodeId'], detail.get('error', ''))
    elif detail_type in (
        workflow_contract.COMPENSATION_COMPLETED_DETAIL_TYPE,
        workflow_contract.COMPENSATION_FAILED_DETAIL_TYPE,
    ):
        # CIT-123 slice 5 (scope A): closes the missing worker -> step-runner
        # seam — nothing previously routed a compensation's outcome (emitted
        # by the worker's _process_workflow_compensation) into
        # handle_compensation_result. parse_compensation_result_detail
        # returns handle_compensation_result's exact keyword shape so this
        # stays a thin routing hop, no re-derivation of the parsed fields.
        parsed = workflow_contract.parse_compensation_result_detail(detail)
        handle_compensation_result(**parsed)
    elif detail_type == 'execution.cancel.requested':
        cancel_execution(detail['executionId'])
    elif detail_type == 'execution.resume.requested':
        # Advance-only resume (decisions O1/O5). Only executionId is consumed;
        # the server re-derives the frontier from persisted state, never from
        # the event payload (SECURITY: server-side frontier re-derivation).
        resume_execution(detail['executionId'])

    return {'statusCode': 200}
