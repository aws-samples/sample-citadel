"""Test trigger_fabrication against a real session."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

from tools.fabricate import trigger_fabrication

SESSION_ID = sys.argv[1] if len(sys.argv) > 1 else "1d83b0f5-a7d7-403f-82de-fa9bc75dd727"
DRY_RUN = "--dry-run" in sys.argv

if DRY_RUN:
    # Patch sqs.send_message to print the message instead of sending
    import tools.fabricate as fab
    import unittest.mock as mock
    def print_message(**kwargs):
        import json
        print("── SQS message ──")
        print(json.dumps(json.loads(kwargs["MessageBody"]), indent=2))
        print("─────────────────\n")
        return {"MessageId": "dry-run"}
    fab.sqs = mock.MagicMock()
    fab.sqs.send_message.side_effect = print_message

if __name__ == "__main__":
    print(f"=== trigger_fabrication (session={SESSION_ID}, dry_run={DRY_RUN}) ===\n")
    result = trigger_fabrication(SESSION_ID)
    print(result)
