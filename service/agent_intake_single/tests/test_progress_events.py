"""Simulate progress events for all phases and publish to EventBridge.

Usage:
  python tests/test_progress_events.py <session_id>

Publishes the full sequence: assessment → design → planning (33/66/100) → implementation
then waits between each so you can watch the DynamoDB/UI update in real time.
"""
import sys, os, json, time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

import boto3
from datetime import datetime

SESSION_ID = sys.argv[1] if len(sys.argv) > 1 else "1d83b0f5-a7d7-403f-82de-fa9bc75dd727"
EVENT_BUS_NAME = os.environ.get('EVENT_BUS_NAME', '')
AWS_REGION = os.environ.get('AWS_REGION', 'us-east-1')

events_client = boto3.client('events', region_name=AWS_REGION)

SEQUENCE = [
    ('assessment', 50,  'Half way through assessment'),
    ('assessment', 100, 'Go confirmed'),
    ('design',     100, 'Technical design complete'),
    ('planning',   33,  'Resourcing report complete'),
    ('planning',   66,  'Business plan complete'),
    ('planning',   100, 'Commercial plan complete'),
    ('implementation', 100, 'Agents queued for fabrication'),
]

def publish(phase: str, progress: int, summary: str):
    resp = events_client.put_events(Entries=[{
        'Source': f'agent_intake.{phase}',
        'DetailType': 'intake.progress.updated',
        'Detail': json.dumps({
            'sessionId': SESSION_ID,
            'phase': phase,
            'completionPercentage': progress,
            'changeSummary': summary,
            'timestamp': datetime.now().isoformat(),
        }),
        'EventBusName': EVENT_BUS_NAME,
    }])
    failed = resp.get('FailedEntryCount', 0)
    status = '✓' if failed == 0 else f'✗ ({resp["Entries"]})'
    print(f"  {status}  phase={phase:15s} progress={progress:3d}%  — {summary}")

if __name__ == '__main__':
    if not EVENT_BUS_NAME:
        print("ERROR: EVENT_BUS_NAME not set in .env")
        sys.exit(1)

    print(f"Publishing progress events for session: {SESSION_ID}")
    print(f"Event bus: {EVENT_BUS_NAME}\n")

    for phase, progress, summary in SEQUENCE:
        publish(phase, progress, summary)
        time.sleep(1)

    print("\nDone. Check DynamoDB citadel-projects-dev for updated progress.")
