import boto3
import json
import logging
import time
import os
from strands.tools import tool
from datetime import datetime

logger = logging.getLogger(__name__)

dynamodb = boto3.resource('dynamodb', region_name=os.environ.get('AWS_REGION', 'ap-southeast-2'))
events_client = boto3.client('events', region_name=os.environ.get('AWS_REGION', 'ap-southeast-2'))

TABLE_NAME = os.environ.get('SESSION_MEMORY_TABLE', '')
EVENT_BUS_NAME = os.environ.get('EVENT_BUS_NAME', '')
PROJECTS_TABLE = os.environ.get('PROJECTS_TABLE', '')
CONVERSATIONS_TABLE = os.environ.get('CONVERSATIONS_TABLE', '')

PHASES = ['assessment', 'design', 'planning', 'implementation']

# Map agent phases to project statuses
PHASE_TO_PROJECT_STATUS = {
    'assessment': 'IN_PROGRESS',
    'design': 'DESIGN_COMPLETE',
    'planning': 'PLANNING_COMPLETE',
    'implementation': 'COMPLETED',
}


def _table():
    return dynamodb.Table(TABLE_NAME)


def _update_project_status(session_id: str, phase: str, progress: int):
    """Update the project record's status and progress when phase milestones are reached."""
    if not PROJECTS_TABLE or not CONVERSATIONS_TABLE:
        return
    try:
        # Look up project ID from conversation table
        conv_table = dynamodb.Table(CONVERSATIONS_TABLE)
        resp = conv_table.scan(
            FilterExpression='#cid = :cid',
            ExpressionAttributeNames={'#cid': 'id'},
            ExpressionAttributeValues={':cid': session_id},
            ProjectionExpression='projectId',
            Limit=10,
        )
        items = resp.get('Items', [])
        if not items:
            # Try using session_id as projectId directly
            project_id = session_id
        else:
            project_id = items[0].get('projectId')
            if not project_id:
                return

        # Determine project status based on phase completion
        if progress >= 100:
            status = PHASE_TO_PROJECT_STATUS.get(phase, 'IN_PROGRESS')
        else:
            status = 'IN_PROGRESS'

        # Update project - two calls to avoid reserved word conflicts
        projects_table = dynamodb.Table(PROJECTS_TABLE)
        projects_table.update_item(
            Key={'id': project_id},
            UpdateExpression='SET progress.#phase = :prog, progress.currentPhase = :cp, progress.overall = :overall, updatedAt = :ts',
            ExpressionAttributeNames={'#phase': phase},
            ExpressionAttributeValues={
                ':prog': progress,
                ':cp': phase.upper(),
                ':overall': min(100, progress * (PHASES.index(phase) + 1) * 25 // 100),
                ':ts': datetime.now().isoformat() + 'Z',
            },
        )
        projects_table.update_item(
            Key={'id': project_id},
            UpdateExpression='SET #s = :s',
            ExpressionAttributeNames={'#s': 'status'},
            ExpressionAttributeValues={':s': status},
        )
    except Exception as e:
        logger.warning('Failed to update project status: %s', e)


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


def _internal_update_progress(session_id: str, phase: str, progress: int, change_summary: str) -> str:
    """Plain function for internal tool-to-tool calls (bypasses @tool decorator)."""
    if phase not in PHASES:
        return f"Invalid phase: {phase}. Must be one of: {', '.join(PHASES)}"
    progress = max(0, min(100, progress))
    timestamp = int(time.time())
    try:
        _table().update_item(
            Key={'p_key': session_id, 's_key': 'intake:latest'},
            UpdateExpression='SET #phase = :phase, #prog = :prog, #ts = :ts',
            ExpressionAttributeNames={'#phase': 'phase', '#prog': f'{phase}_progress', '#ts': 'last_updated'},
            ExpressionAttributeValues={':phase': phase, ':prog': progress, ':ts': timestamp},
        )
    except Exception as e:
        print(f"Error updating progress: {e}")
    _publish_event(phase, session_id, progress, change_summary)
    _update_project_status(session_id, phase, progress)
    return f"{phase} progress: {progress}%"


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
    return _internal_update_progress(session_id, phase, progress, change_summary)

