import boto3
import json
import time
import os
from strands.tools import tool
from datetime import datetime

dynamodb = boto3.resource('dynamodb', region_name=os.environ.get('AWS_REGION', 'ap-southeast-2'))
events_client = boto3.client('events', region_name=os.environ.get('AWS_REGION', 'ap-southeast-2'))

TABLE_NAME = os.environ.get('SESSION_MEMORY_TABLE', '')
EVENT_BUS_NAME = os.environ.get('EVENT_BUS_NAME', '')

PHASES = ['assessment', 'design', 'planning', 'implementation']


def _table():
    return dynamodb.Table(TABLE_NAME)


def _publish_event(phase: str, session_id: str, progress: int, summary: str):
    if not EVENT_BUS_NAME:
        return
    try:
        events_client.put_events(Entries=[{
            'Source': f'agent_intake.{phase}',
            'DetailType': 'intake.progress.updated',
            'Detail': json.dumps({
                'sessionId': session_id,
                'phase': phase,
                'completionPercentage': progress,
                'changeSummary': summary,
                'timestamp': datetime.now().isoformat(),
            }),
            'EventBusName': EVENT_BUS_NAME,
        }])
    except Exception as e:
        print(f"Failed to publish event: {e}")


@tool
def get_intake_state(session_id: str) -> str:
    """Get the current intake phase and progress for all phases.

    Args:
        session_id: The session ID

    Returns:
        JSON with current phase and progress per phase.
    """
    try:
        resp = _table().get_item(Key={'p_key': session_id, 's_key': 'intake:latest'})
        if 'Item' in resp:
            item = resp['Item']
            return json.dumps({
                'phase': item.get('phase', 'assessment'),
                'assessment_progress': int(item.get('assessment_progress', 0)),
                'design_progress': int(item.get('design_progress', 0)),
                'delivery_plan_progress': int(item.get('delivery_plan_progress', 0)),
                'last_updated': int(item.get('last_updated', 0)),
            })
    except Exception as e:
        print(f"Error getting intake state: {e}")

    return json.dumps({
        'phase': 'assessment',
        'assessment_progress': 0,
        'design_progress': 0,
        'delivery_plan_progress': 0,
        'last_updated': 0,
    })


@tool
def update_intake_progress(session_id: str, phase: str, progress: int, change_summary: str) -> str:
    """Update progress for a phase and publish a UI progress event.
    Call this at key milestones: after extraction, after go/no-go, after each design section, on completion.

    Args:
        session_id: The session ID
        phase: One of: assessment, technical_design, delivery_plan
        progress: Completion percentage (0-100)
        change_summary: Brief description of what changed

    Returns:
        Confirmation.
    """
    if phase not in PHASES:
        return f"Invalid phase: {phase}. Must be one of: {', '.join(PHASES)}"

    progress = max(0, min(100, progress))
    timestamp = int(time.time())

    try:
        _table().update_item(
            Key={'p_key': session_id, 's_key': 'intake:latest'},
            UpdateExpression='SET #phase = :phase, #prog = :prog, #ts = :ts',
            ExpressionAttributeNames={
                '#phase': 'phase',
                '#prog': f'{phase}_progress',
                '#ts': 'last_updated',
            },
            ExpressionAttributeValues={':phase': phase, ':prog': progress, ':ts': timestamp},
        )
    except Exception as e:
        print(f"Error updating progress: {e}")

    _publish_event(phase, session_id, progress, change_summary)

    # Invalidate agent cache so next invocation gets fresh state
    try:
        import agent
        if session_id in agent._agent_cache:
            del agent._agent_cache[session_id]
    except Exception:
        pass

    return f"{phase} progress: {progress}%"
