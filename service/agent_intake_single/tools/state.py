import tools.tracing as tracing
import boto3
import json
import logging
import time
import os
from strands.tools import tool
from datetime import datetime
from uuid import uuid4

logger = logging.getLogger(__name__)
tracing.install_log_filter(logger)

dynamodb = boto3.resource('dynamodb', region_name=os.environ.get('AWS_REGION', 'ap-southeast-2'))
events_client = boto3.client('events', region_name=os.environ.get('AWS_REGION', 'ap-southeast-2'))

TABLE_NAME = os.environ.get('SESSION_MEMORY_TABLE', '')
EVENT_BUS_NAME = os.environ.get('EVENT_BUS_NAME', '')

PHASES = ['assessment', 'design', 'planning', 'implementation']


def _table():
    return dynamodb.Table(TABLE_NAME)


def _publish_event(phase: str, session_id: str, progress: int, summary: str, run_id: str | None = None):
    if not EVENT_BUS_NAME:
        return
    try:
        detail = {
            'sessionId': session_id,
            'phase': phase,
            'completionPercentage': progress,
            'changeSummary': summary,
            'timestamp': datetime.now().isoformat(),
        }
        # Additive, optional traceContext (design §"Carried-context format
        # decision" / H6): merged in only when an active X-Ray (sub)segment
        # exists, so the Detail shape is byte-identical to pre-feature
        # callers with no active segment (property-tested — the case for
        # every pytest run, hence the pre-existing exact-keys assertion in
        # test_state_usage_event.py::test_existing_progress_event_source_and_shape_unchanged
        # stays green).
        trace_context = tracing.active_trace_context()
        if trace_context:
            detail['traceContext'] = trace_context
        # Additive, optional, nullable runId (Pass 1, decision f1cbd5ef):
        # server-minted per intake turn by the caller (agent.py's invoke),
        # threaded down here best-effort. Included only when a non-empty
        # string is supplied — absent/None/malformed omits the key entirely,
        # keeping the Detail byte-identical to pre-runId callers.
        if isinstance(run_id, str) and run_id:
            detail['runId'] = run_id
        events_client.put_events(Entries=[{
            'Source': f'agent_intake.{phase}',
            'DetailType': 'intake.progress.updated',
            'Detail': json.dumps(detail),
            'EventBusName': EVENT_BUS_NAME,
        }])
    except Exception as e:
        print(f"Failed to publish event: {e}")


def publish_usage_event(session_id: str, usage_record: dict, run_id: str | None = None) -> None:
    """Publish one model-invocation usage record onto the
    ``agent_intake.usage`` EventBridge namespace, additive to the existing
    ``agent_intake.<phase>`` progress namespaces.

    Attribution rides ``sessionId`` (== ``projectId`` per the existing
    session/project convention — see ``_internal_update_progress``) plus a
    per-event ``correlationId`` so downstream consumers can join usage
    records to a single model call without any existing consumer needing to
    change (a brand-new Source/DetailType, so nothing currently subscribed
    to ``agent_intake.<phase>`` sees this event). Best-effort: usage capture
    must never break a conversation turn, so failures are logged and
    swallowed, never raised.

    ``run_id`` is additive, optional, and nullable (Pass 1, decision
    f1cbd5ef): included as ``runId`` only when a non-empty string is
    supplied. A missing/None/malformed value never gates this publish and
    omits the key entirely — byte-identical to the pre-runId Detail shape.
    """
    if not EVENT_BUS_NAME:
        return
    try:
        detail = {
            'sessionId': session_id,
            'projectId': session_id,
            'correlationId': str(uuid4()),
            **usage_record,
        }
        # Additive, optional traceContext (design §"Carried-context format
        # decision" / H6): merged in only when an active X-Ray (sub)segment
        # exists. No-op-safe otherwise (property-tested), so existing
        # consumers ignoring the new key are unaffected (R20).
        trace_context = tracing.active_trace_context()
        if trace_context:
            detail['traceContext'] = trace_context
        if isinstance(run_id, str) and run_id:
            detail['runId'] = run_id
        events_client.put_events(Entries=[{
            'Source': 'agent_intake.usage',
            'DetailType': 'intake.usage.captured',
            'Detail': json.dumps(detail),
            'EventBusName': EVENT_BUS_NAME,
        }])
    except Exception as e:
        logger.warning('Failed to publish usage event for session %s: %s', session_id, e)


@tool
def get_intake_state(session_id: str) -> str:
    """Get the current intake phase and progress for all phases.

    Args:
        session_id: The session ID

    Returns:
        JSON with current phase and progress per phase. The progress keys
        mirror PHASES exactly (assessment, design, planning, implementation) —
        i.e. the '<phase>_progress' fields the write path actually stores.
    """
    try:
        resp = _table().get_item(Key={'p_key': session_id, 's_key': 'intake:latest'})
        if 'Item' in resp:
            item = resp['Item']
            return json.dumps({
                'phase': item.get('phase', 'assessment'),
                'assessment_progress': int(item.get('assessment_progress', 0)),
                'design_progress': int(item.get('design_progress', 0)),
                'planning_progress': int(item.get('planning_progress', 0)),
                'implementation_progress': int(item.get('implementation_progress', 0)),
                'last_updated': int(item.get('last_updated', 0)),
            })
    except Exception as e:
        print(f"Error getting intake state: {e}")

    return json.dumps({
        'phase': 'assessment',
        'assessment_progress': 0,
        'design_progress': 0,
        'planning_progress': 0,
        'implementation_progress': 0,
        'last_updated': 0,
    })


def _internal_update_progress(session_id: str, phase: str, progress: int, change_summary: str, run_id: str | None = None) -> str:
    """Plain function for internal tool-to-tool calls (bypasses @tool decorator).

    Hot path (~30 ticks during design generation): writes the intake state
    row and publishes intake.progress.updated — nothing else. The project
    record (nested progress.<phase> + currentPhase, monotonic + idempotent,
    keyed id=sessionId) is updated asynchronously by the event's consumer,
    backend/src/lambda/project-progress-updater.ts; agent-message-handler
    sets sessionId == projectId, so the event targets the right row. The
    former synchronous write ran a full paginated Scan of the conversations
    table on EVERY tick and was removed.

    ``run_id`` is additive/optional (Pass 1, decision f1cbd5ef) and threaded
    straight through to ``_publish_event``'s best-effort stamp.
    """
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
    _publish_event(phase, session_id, progress, change_summary, run_id=run_id)
    return f"{phase} progress: {progress}%"


# Post-fabrication flow marker (design: resumable, consent-gated state machine).
# Stored as a single JSON string attribute so a corrupt payload degrades to
# "no marker" (failure mode 17) instead of poisoning every read.
POSTFAB_SORT_KEY = 'intake:postfab'


def get_postfab_marker(session_id: str) -> dict:
    """Read the intake:postfab marker for a session.

    Returns {} when absent, unreadable, or corrupt — callers treat that as a
    fresh flow and re-derive from live queries. Never raises.
    """
    try:
        resp = _table().get_item(Key={'p_key': session_id, 's_key': POSTFAB_SORT_KEY})
        item = resp.get('Item')
        if not item:
            return {}
        marker = json.loads(item.get('marker') or '{}')
        return marker if isinstance(marker, dict) else {}
    except Exception as e:
        logger.warning('postfab marker read failed for %s: %s', session_id, e)
        return {}


def set_postfab_marker(session_id: str, **updates) -> dict:
    """Merge ``updates`` into the intake:postfab marker and persist it.

    Best-effort write (the governed mutation that preceded it is the durable
    unit of work); always stamps updatedAt and invalidates the cached Agent so
    the baked-in stage stays current. Returns the merged marker.
    """
    marker = get_postfab_marker(session_id)
    marker.update(updates)
    marker['updatedAt'] = datetime.now().isoformat() + 'Z'
    try:
        _table().put_item(Item={
            'p_key': session_id,
            's_key': POSTFAB_SORT_KEY,
            'marker': json.dumps(marker),
        })
    except Exception as e:
        logger.warning('postfab marker write failed for %s: %s', session_id, e)
    try:
        _invalidate_agent_cache(session_id)
    except Exception as e:
        logger.warning('Cache invalidation failed for session %s: %s', session_id, e)
    return marker


def _invalidate_agent_cache(session_id: str) -> None:
    """Evict the session's cached Agent so its baked-in progress is rebuilt.

    ``agent.py`` runs as ``__main__`` in the container (``CMD python agent.py``)
    but is imported as ``agent`` under test, so resolve whichever module holds
    the live cache rather than re-importing it — a fresh ``import agent`` would
    spin up a second, empty cache and leave the running one stale.
    """
    import sys
    mod = sys.modules.get('agent') or sys.modules.get('__main__')
    invalidate = getattr(mod, 'invalidate_agent_cache', None)
    if invalidate is not None:
        invalidate(session_id)


@tool
def update_intake_progress(session_id: str, phase: str, progress: int, change_summary: str) -> str:
    """Update progress for a phase and publish a UI progress event.
    Call this at key milestones: after extraction, after go/no-go, after each design section, on completion.

    Args:
        session_id: The session ID
        phase: One of: assessment, design, planning, implementation
        progress: Completion percentage (0-100)
        change_summary: Brief description of what changed

    Returns:
        Confirmation.
    """
    result = _internal_update_progress(session_id, phase, progress, change_summary)
    # A progress change makes the cached Agent's baked-in system prompt stale, so
    # evict it. Best-effort: the DynamoDB write above is the committed unit of
    # work, so a cache failure is logged and swallowed, not surfaced to the user.
    try:
        _invalidate_agent_cache(session_id)
    except Exception as e:
        logger.warning('Cache invalidation failed for session %s: %s', session_id, e)
    return result

