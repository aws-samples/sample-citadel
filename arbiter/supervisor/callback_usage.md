# Supervisor Callback Usage

The Supervisor agent now supports callback addresses for orchestration completion. When a task request includes a callback configuration, the supervisor will send the final orchestration result to the specified destination.

## Callback Types

### 1. EventBridge Callback

Send the orchestration result to a specific EventBridge event bus.

```json
{
  "source": "task.request",
  "detail": {
    "task": "Your task description here",
    "callback": {
      "type": "eventbridge",
      "eventBusName": "my-event-bus",
      "source": "supervisor.response",
      "detailType": "task.completed"
    }
  }
}
```

**Parameters:**
- `type`: Must be `"eventbridge"`
- `eventBusName`: (Optional) Target event bus name. Defaults to the supervisor's EVENT_BUS_NAME
- `source`: (Optional) Event source. Defaults to `"supervisor"`
- `detailType`: (Optional) Event detail type. Defaults to `"task.response"`

### 2. SQS Callback

Send the orchestration result to an SQS queue.

```json
{
  "source": "task.request",
  "detail": {
    "task": "Your task description here",
    "callback": {
      "type": "sqs",
      "queueUrl": "https://sqs.us-east-1.amazonaws.com/123456789012/my-queue"
    }
  }
}
```

**Parameters:**
- `type`: Must be `"sqs"`
- `queueUrl`: (Required) Full SQS queue URL

> **Note:** A previous `"mcp"` callback type has been removed from this contract. Unknown callback `type` values now fall through to a no-op log entry. If no `callback` is supplied, see the "No Callback" section below for default routing.

## Response Format

All callbacks receive a JSON payload with the following structure:

```json
{
  "message": "The final orchestration result text",
  "timestamp": 1234567890.123,
  "callback": {
    // Original callback configuration
  }
}
```

## Example: Task Runner with EventBridge Callback

```python
import boto3
import json

events = boto3.client('events')

# Submit task with callback
events.put_events(
    Entries=[
        {
            'Source': 'task.request',
            'DetailType': 'System-Task',
            'Detail': json.dumps({
                'task': 'Analyze customer order #12345',
                'callback': {
                    'type': 'eventbridge',
                    'eventBusName': 'my-results-bus',
                    'source': 'order.analysis',
                    'detailType': 'analysis.complete'
                }
            }),
            'EventBusName': 'orchestration-bus'
        }
    ]
)
```

## Example: Task Runner with SQS Callback

```python
import boto3
import json

events = boto3.client('events')

# Submit task with SQS callback
events.put_events(
    Entries=[
        {
            'Source': 'task.request',
            'DetailType': 'System-Task',
            'Detail': json.dumps({
                'task': 'Generate monthly report',
                'callback': {
                    'type': 'sqs',
                    'queueUrl': 'https://sqs.us-east-1.amazonaws.com/123456789012/report-results'
                }
            }),
            'EventBusName': 'orchestration-bus'
        }
    ]
)
```

## No Callback (Default Behavior)

If no callback is specified, the supervisor sends responses to the default EVENT_BUS_NAME with:
- Source: `"supervisor"`
- DetailType: `"task.response"`

```json
{
  "source": "task.request",
  "detail": {
    "task": "Your task description here"
  }
}
```

## Error Handling

- If a callback fails, the error is logged but does not prevent the orchestration from completing
- The supervisor will still publish to the default event bus for monitoring
- Check CloudWatch logs for callback error details

## IAM Permissions

Ensure the Supervisor Lambda has appropriate permissions:

**For EventBridge callbacks:**
```json
{
  "Effect": "Allow",
  "Action": "events:PutEvents",
  "Resource": "arn:aws:events:*:*:event-bus/*"
}
```

**For SQS callbacks:**
```json
{
  "Effect": "Allow",
  "Action": "sqs:SendMessage",
  "Resource": "arn:aws:sqs:*:*:*"
}
```

