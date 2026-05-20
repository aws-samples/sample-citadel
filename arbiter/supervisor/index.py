
if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()

import json
from typing import Any
import boto3
import os
from agent_config import load_config_from_dynamodb, load_app_scoped_agents, create_agent_specs, parse_decimals
from circuit_breaker import CircuitBreaker, CircuitBreakerOpen
import uuid
import time

MODEL_ID = "us.anthropic.claude-sonnet-4-6"

EVENT_BUS_NAME = os.environ.get('EVENT_BUS_NAME')
ORCHESTRATION_TABLE = os.environ.get('ORCHESTRATION_TABLE')
WORKER_STATE_TABLE = os.environ.get('WORKER_STATE_TABLE')

sqs = boto3.client('sqs')
dynamodb = boto3.resource('dynamodb')
bedrock = boto3.client('bedrock-runtime', region_name='us-west-2')
events_client = boto3.client('events')

# Circuit breaker for Bedrock API calls — shared across invocations within the same Lambda container
bedrock_circuit_breaker = CircuitBreaker(
    failure_threshold=3,
    recovery_timeout=30.0,
    max_retries=3,
    base_delay=1.0,
    max_delay=15.0,
)



SYSTEM_PROMPT = [{
    "text": """You are the Supervisor Agent responsible for autonomously coordinating and completing workflows on behalf of the user. Your role is to translate user requests into actionable plans, delegate tasks to the most suitable agents, and ensure successful end-to-end delivery — even when all required steps are not known upfront.

Your responsibilities:

1. Interpret & Plan
   - Convert the user’s request into a clear objective and a structured execution plan.
   - If key details are missing, infer reasonable assumptions rather than asking the user.
   - Break work into parallel tasks whenever possible to optimise speed and efficiency.

2. Delegate & Orchestrate
   - Select the most appropriate agents for each task based on their capabilities.
   - Issue multiple agent calls in parallel when tasks are independent.
   - If an agent requires information that the user did not provide, you must generate or infer the required input yourself.

3. Monitor & Adapt
   - Track progress, validate outputs, and handle failure or ambiguity autonomously.
   - If a task returns unclear or incomplete results, refine the task or re-delegate.
   - Adjust the plan as new information emerges—tasks may be iterative or exploratory.

4. Quality & Completion**
   - Ensure final output meets the user’s intent and quality expectations.
   - Compile results, summarise outcomes, and deliver a coherent final response to the user.

Rules of Engagement:
- Do not ask the user follow-up questions after their initial request, unless clarification is absolutely required for safety or correctness.
- Prefer autonomy, initiative, and inference over user re-engagement.
- Use agents as the primary mechanism for action—not yourself.
- Always aim to complete the request in the fewest number of interaction rounds.
- If no agent exists for a required step, propose a workaround or simulated execution.

Your goal is to behave as a highly autonomous supervisory system that can manage uncertainty, discover required tasks on the fly, and drive efficient, agent-based execution to fulfill the user's intent."""
}]


def create_workflow_tracking_record(nodes: list[str]):
    request_id = str(uuid.uuid4())
    if len(nodes) == 0:
        return

    item = {
        "requestId": request_id,
    }

    data = {}

    for node in nodes:
        item[node] = False
        data[node] = None

    item['data'] = data

    table = dynamodb.Table(WORKER_STATE_TABLE)
    table.put_item(
        TableName=WORKER_STATE_TABLE,
        Item=item
    )

    return request_id


def update_workflow_tracking(node: str, request_id: str, data: Any) -> bool:
    table = dynamodb.Table(WORKER_STATE_TABLE)

    response = table.update_item(
        Key={
            "requestId": request_id
        },
        UpdateExpression="SET #node = :completed, #data.#node = :node_data",
        ExpressionAttributeNames={
            "#node": node,
            "#data": "data"
        },
        ExpressionAttributeValues={
            ":completed": True,
            ":node_data": data
        },
        ReturnValues="ALL_NEW"
    )

    updated_item = response.get("Attributes", {})
    all_completed = True

    for key, value in updated_item.items():
        if key not in ["requestId", "data"] and value is False:
            all_completed = False
            break

    return all_completed, response


def create_orchestration(conversation, callback=None):
    instance = int(time.time())

    item = {
        'orchestrationId': str(uuid.uuid4()),
        'instance': instance,
        'conversation': conversation,
    }
    
    if callback:
        item['callback'] = callback
    
    return item


def save_orchestration(orchestration):
    table = dynamodb.Table(ORCHESTRATION_TABLE)
    table.put_item(
        TableName=ORCHESTRATION_TABLE,
        Item=orchestration
    )


def load_orchestration(orchestration_id=None):
    if orchestration_id is None:
        return None
    else:
        table = dynamodb.Table(ORCHESTRATION_TABLE)
        response = table.get_item(Key={'orchestrationId': orchestration_id})
        return response['Item']


def process_agent_call(agents_config, orchestration, agent_name, agent_input, agent_use_id):
    agent_config = next(
        (agent for agent in agents_config['agents'] if agent['name'] == agent_name), None)

    if agent_config is None:
        print(f"Agent {agent_name} not found in configuration.")
        return

    action = agent_config["action"]
    action_type = action["type"]
    target = action["target"]
    payload = {
        "agent_input": agent_input,
        "orchestration_id": orchestration["orchestrationId"],
        "agent_use_id": agent_use_id,
        "node": agent_name
    }

    print(f"Sending payload to {action_type} queue: {target}")
    print(f"Payload: {json.dumps(payload, default=str)}")

    # Publish to EventBridge for chatter visibility
    if EVENT_BUS_NAME:
        try:
            events_client.put_events(
                Entries=[
                    {
                        'Source': 'supervisor',
                        'DetailType': 'chatter',
                        'Detail': json.dumps({
                            'action': 'agent_call',
                            'agent_name': agent_name,
                            'agent_input': agent_input,
                            'orchestration_id': orchestration["orchestrationId"],
                            'agent_use_id': agent_use_id,
                            'target': target,
                            'timestamp': time.time()
                        }, default=str),
                        'EventBusName': EVENT_BUS_NAME
                    }
                ]
            )
            print(f"Published supervisor message to EventBridge")
        except Exception as e:
            print(f"Error publishing to EventBridge: {e}")

    if action_type == "sqs":
        response = sqs.send_message(
            QueueUrl=target,
            MessageBody=json.dumps(payload)
        )
        print(f"SQS send_message response: {json.dumps(response, default=str)}")
        return response


def invoke_agents_from_conversation(orchestration, agents_config):
    agent_ids = []
    output_message = orchestration["conversation"][-1]
    text_response = None

    print(f'Invoking agents from message: {json.dumps(output_message, default=str)}')
    print(f'Message content: {output_message.get("content", [])}')

    for content in output_message.get('content', []):
        print(f'Processing content item: {json.dumps(content, default=str)}')
        if 'toolUse' in content:
            tool_use = content['toolUse']
            print(f'Found toolUse: {json.dumps(tool_use, default=str)}')
            agent_ids.append(tool_use['name'])
            result = process_agent_call(
                agents_config,
                orchestration,
                tool_use['name'],
                tool_use['input'],
                tool_use['toolUseId']
            )
            print(f'Agent call result: {result}')
        elif 'text' in content:
            text_response = content['text']
            print(f"Text response from model: {text_response}")

    print(f'Total agents invoked: {len(agent_ids)}')
    print(f'Agent IDs: {agent_ids}')

    if len(agent_ids) > 0:
        request_id = create_workflow_tracking_record(agent_ids)
        orchestration["request_id"] = request_id
        print(f'Created workflow tracking with request_id: {request_id}')
    else:
        print('No agents were invoked - model may have responded with text only')
        
        # Send final response to callback if orchestration is complete
        callback_info = orchestration.get('callback')
        if text_response and callback_info:
            print(f"Orchestration complete, sending response to callback")
            send_response(text_response, callback=callback_info)
        
        # Publish supervisor feedback to EventBridge for chatter visibility
        if EVENT_BUS_NAME and text_response:
            try:
                events_client.put_events(
                    Entries=[
                        {
                            'Source': 'supervisor',
                            'DetailType': 'supervisor.feedback',
                            'Detail': json.dumps({
                                'action': 'direct_response',
                                'message': text_response,
                                'orchestration_id': orchestration["orchestrationId"],
                                'timestamp': time.time()
                            }, default=str),
                            'EventBusName': EVENT_BUS_NAME
                        }
                    ]
                )
                print(f"Published supervisor feedback to EventBridge")
            except Exception as e:
                print(f"Error publishing supervisor feedback to EventBridge: {e}")


def update_orchestration_with_results(results, orchestration):
    tool_results = []
    data_to_save = results['Attributes']['data']

    for key in data_to_save:
        data = data_to_save[key]
        tool_result = {
            "toolResult": {
                "toolUseId": data['agent_use_id'],
                "content": [{"json": {'data': data['data']}}],
            }
        }
        tool_results.append(tool_result)

    orchestration["conversation"].append({
        "role": "user",
        "content": tool_results
    })


def orchestrate(initial_message=None, orchestration=None, callback=None, app_id=None):
    if orchestration is None:
        orchestration = create_orchestration(
            conversation=[{
                "role": "user",
                "content": [{"text": initial_message}],
            }],
            callback=callback
        )

    if app_id is not None:
        agent_configs = load_app_scoped_agents(app_id)
    else:
        agent_configs = load_config_from_dynamodb()
    print(f"Agent configs loaded: {json.dumps(agent_configs, default=str)}")

    # Check if there are any active agents
    if not agent_configs.get('agents') or len(agent_configs['agents']) == 0:
        # Send response back to requester that there are no active agents
        print("No active agents configured")
        callback_info = orchestration.get('callback')
        send_response("No active agents configured", callback=callback_info)
        return
    
    agent_specs = create_agent_specs(agent_configs)
    print(f"Agent specs created: {json.dumps(agent_specs, default=str)}")
    print(f"Calling Bedrock with conversation: {json.dumps(orchestration['conversation'], default=str)}")

    response = bedrock_circuit_breaker.call(
        bedrock.converse,
        modelId=MODEL_ID,
        messages=orchestration["conversation"],
        system=SYSTEM_PROMPT,
        inferenceConfig={
            "maxTokens": 2048,
            "temperature": 0,
        },
        toolConfig={
            "tools": agent_specs,
            # Allow model to automatically select tools
            "toolChoice": {"auto": {}}
        }
    )

    print(f"Bedrock response: {json.dumps(response, default=str)}")
    print(f"Response output message: {json.dumps(response['output']['message'], default=str)}")

    orchestration["conversation"].append(response['output']['message'])

    invoke_agents_from_conversation(
        orchestration, agent_configs
    )

    save_orchestration(orchestration=orchestration)

def send_response(message, callback=None):
    """Send response to the default event bus or to a specific callback address"""
    
    # If no callback specified, send to default event bus
    if not callback:
        if not EVENT_BUS_NAME:
            print("EVENT_BUS_NAME not configured and no callback provided")
            return
        
        try:
            events_client.put_events(
                Entries=[
                    {
                        'Source': 'supervisor',
                        'DetailType': 'task.response',
                        'Detail': json.dumps({
                            'message': message,
                            'timestamp': time.time()
                        }, default=str),
                        'EventBusName': EVENT_BUS_NAME
                    }
                ]
            )
            print(f"Published task response to EventBridge: {message}")
        except Exception as e:
            print(f"Error publishing task response to EventBridge: {e}")
        return
    
    # Handle callback-specific routing
    callback_type = callback.get('type')
    
    if callback_type == 'eventbridge':
        try:
            event_bus_name = callback.get('eventBusName', EVENT_BUS_NAME)
            source = callback.get('source', 'supervisor')
            detail_type = callback.get('detailType', 'task.response')
            
            events_client.put_events(
                Entries=[
                    {
                        'Source': source,
                        'DetailType': detail_type,
                        'Detail': json.dumps({
                            'message': message,
                            'timestamp': time.time(),
                            'callback': callback
                        }, default=str),
                        'EventBusName': event_bus_name
                    }
                ]
            )
            print(f"Published task response to EventBridge {event_bus_name}: {message}")
        except Exception as e:
            print(f"Error publishing to EventBridge callback: {e}")
    
    elif callback_type == 'sqs':
        try:
            queue_url = callback.get('queueUrl')
            if not queue_url:
                print("SQS callback missing queueUrl")
                return
            
            sqs.send_message(
                QueueUrl=queue_url,
                MessageBody=json.dumps({
                    'message': message,
                    'timestamp': time.time(),
                    'callback': callback
                }, default=str)
            )
            print(f"Published task response to SQS {queue_url}: {message}")
        except Exception as e:
            print(f"Error publishing to SQS callback: {e}")
    
    elif callback_type == 'mcp':
        try:
            # MCP server callback - store for external polling or webhook
            # For now, log the callback details
            print(f"MCP callback requested: {json.dumps(callback, default=str)}")
            print(f"MCP response message: {message}")
            
            # TODO: Implement MCP server notification mechanism
            # This could be:
            # 1. Writing to a DynamoDB table that MCP servers poll
            # 2. Invoking a webhook URL if provided
            # 3. Publishing to a dedicated MCP notification queue
            
            mcp_endpoint = callback.get('endpoint')
            if mcp_endpoint:
                # If webhook endpoint provided, attempt HTTP POST
                import urllib.request
                import urllib.error
                
                data = json.dumps({
                    'message': message,
                    'timestamp': time.time(),
                    'callback': callback
                }).encode('utf-8')
                
                req = urllib.request.Request(
                    mcp_endpoint,
                    data=data,
                    headers={'Content-Type': 'application/json'}
                )
                
                try:
                    with urllib.request.urlopen(req, timeout=10) as response:
                        print(f"MCP webhook response: {response.status}")
                except urllib.error.URLError as e:
                    print(f"Error calling MCP webhook: {e}")
            else:
                print("MCP callback has no endpoint - response logged only")
                
        except Exception as e:
            print(f"Error handling MCP callback: {e}")
    
    else:
        print(f"Unknown callback type: {callback_type}")


def handler(event, lambda_context):
    print(f"Received event: {json.dumps(event)}")
    
    # Check if this is a task completion event from a worker agent
    if 'source' in event and event['source'] == 'task.completion':
        orchestration_id = event['detail']['orchestration_id']
        try:
            orchestration = load_orchestration(orchestration_id)
        except Exception as e:
            print(f"Error loading orchestration: {e}")
            return
        request_id = orchestration['request_id']
        print(f"request id: {request_id}")
        node = event['detail']['node']
        all_completed, results = update_workflow_tracking(
            node, request_id, event['detail'])

        if (all_completed):
            update_orchestration_with_results(
                results=results, orchestration=orchestration)
            
            # Check if this is the final completion and send callback
            parsed_orchestration = parse_decimals(orchestration)
            
            # Continue orchestration to get final response from supervisor
            orchestrate(orchestration=parsed_orchestration)
    
    # Check if this is a new task request
    elif 'source' in event and event['source'] == 'task.request':
        print("Processing new task request")
        task_details = event['detail'].get('task', '')
        callback = event['detail'].get('callback')
        app_id = event['detail'].get('appId')
        
        if callback:
            print(f"Task request includes callback: {json.dumps(callback, default=str)}")
        
        if task_details:
            orchestrate(initial_message=task_details, callback=callback, app_id=app_id)
        else:
            print("No task details found in event")
    
    # Fallback for other event types with detail
    elif 'detail' in event:
        print("Processing generic detail event")
        orchestrate(initial_message=json.dumps(event["detail"]))


if __name__ == "__main__":
    handler({
        "source": "task.request",
        "DetailType": "System-Task",
        "detail": "{\"orderId\": \"12345\", \"customerId\": \"C-1234\", \"items\": [\"cheesecake\"]}",
        "EventBusName": "orchestration-bus"
    }, {})