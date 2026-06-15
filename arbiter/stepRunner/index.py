"""Step Runner Lambda handler — routes EventBridge events to executor functions."""

from executor import start_execution, handle_node_completion, handle_node_failure, cancel_execution


def handler(event, context):
    """Route EventBridge events to the appropriate executor function."""
    detail_type = event.get('detail-type', '')
    detail = event.get('detail', {})

    if detail_type == 'execution.start.requested':
        start_execution(detail['executionId'], detail['workflowId'])
    elif detail_type == 'workflow.node.completed':
        handle_node_completion(detail['executionId'], detail['nodeId'], detail.get('output', {}))
    elif detail_type == 'workflow.node.failed':
        handle_node_failure(detail['executionId'], detail['nodeId'], detail.get('error', ''))
    elif detail_type == 'execution.cancel.requested':
        cancel_execution(detail['executionId'])

    return {'statusCode': 200}
