
if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()

import json
import logging
import sys
from typing import Any
import boto3
import os

# Ensure this file's own directory is on sys.path before the flat
# same-directory imports below. In the repo/pytest layout,
# arbiter/conftest.py already inserts arbiter/supervisor/ onto sys.path, so
# this is a no-op there. In the Lambda asset layout (entry=arbiter/,
# index=supervisor/index.py) only /var/task is on sys.path by default —
# /var/task/supervisor is not — so `from agent_config import ...` and
# `from circuit_breaker import ...` would otherwise raise ModuleNotFoundError
# at runtime. Inserting unconditionally keeps both layouts working from a
# single code path.
_this_dir = os.path.dirname(os.path.abspath(__file__))
if _this_dir not in sys.path:
    sys.path.insert(0, _this_dir)

from agent_config import load_config_from_dynamodb, load_app_scoped_agents, create_agent_specs, parse_decimals
from circuit_breaker import CircuitBreaker, CircuitBreakerOpen
import uuid
import time

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Governance imports (US-ARB-008)
#
# arbiter/governance/ is a sibling package of arbiter/supervisor/. Its
# submodules use relative imports (``from .models import ...``) so they MUST
# be imported as the ``governance`` package, which in turn requires the
# parent directory (arbiter/) to be on ``sys.path``.
#
# Fail-closed contract: the deployed Lambda asset MUST bundle
# arbiter/governance/ alongside arbiter/supervisor/ (see
# backend/lib/arbiter-stack.ts bundling commandHooks, and
# backend/scripts/verify-supervisor-bundle.sh for a CI-enforced check). If
# the package files are missing at runtime for any reason (packaging
# regression, partial deploy), ``_GOVERNANCE_AVAILABLE`` is set to ``False``
# below and ``governed_process_agent_call`` REFUSES every dispatch with a
# structured denial result and an error-level log — it never falls through
# to ungoverned dispatch. This module must still import successfully in that
# case (the handler has to start) so the refusal itself is observable.
#
# ARBITER_GOVERNANCE_BYPASS semantics (documented here per Requirement 6):
#   Default: unset / any value other than 'true' -> no effect.
#   'true'  -> emergency override. Forces shadow-style behaviour (evaluate +
#              record a finding + always proceed) even when the persisted
#              enforcement mode resolved via ``hierarchy.load_governance_state``
#              is 'strict'. Intended for a human operator to flip temporarily
#              during an incident — NOT a default deployment posture. It has
#              NO effect on the package-availability gate above: a missing
#              governance package is refused unconditionally regardless of
#              this variable.
#
# In tests, arbiter/conftest.py puts arbiter/supervisor/ on sys.path; we
# add arbiter/ ourselves below so ``import governance`` resolves.
# ---------------------------------------------------------------------------
_supervisor_dir = os.path.dirname(os.path.abspath(__file__))
_arbiter_dir = os.path.dirname(_supervisor_dir)
if _arbiter_dir not in sys.path:
    sys.path.insert(0, _arbiter_dir)

from common.region import cross_region_prefix
from model_config_loader import load_model_id


def _load_governance_package():
    """Load ``arbiter/governance/`` as a package under a private name.

    arbiter/workerWrapper/governance.py is a flat module that also ends up on
    sys.path under the name ``governance`` in test runs, and the Lambda
    bundle may not ship the governance package at all. To keep both worlds
    working we load the governance package explicitly from its filesystem
    location under the private name ``_citadel_governance`` and expose the
    submodules under that namespace, so ``sys.modules['governance']`` is
    left untouched for any other consumer.

    Returns the loaded package or ``None`` if the files are unavailable.
    """
    import importlib.util as _ilu
    pkg_dir = os.path.join(_arbiter_dir, 'governance')
    init_file = os.path.join(pkg_dir, '__init__.py')
    if not os.path.isfile(init_file):
        return None

    pkg_name = '_citadel_governance'
    if pkg_name in sys.modules:
        return sys.modules[pkg_name]

    spec = _ilu.spec_from_file_location(
        pkg_name, init_file,
        submodule_search_locations=[pkg_dir],
    )
    pkg = _ilu.module_from_spec(spec)
    sys.modules[pkg_name] = pkg
    spec.loader.exec_module(pkg)

    # Explicitly load the submodules the supervisor needs. They use relative
    # imports (``from .models import ...``) which need the parent package
    # (``_citadel_governance``) to already be registered — done above.
    for submod in ('models', 'hierarchy', 'engine', 'ledger'):
        sub_file = os.path.join(pkg_dir, f'{submod}.py')
        if not os.path.isfile(sub_file):
            continue
        sub_spec = _ilu.spec_from_file_location(
            f'{pkg_name}.{submod}', sub_file,
        )
        sub_mod = _ilu.module_from_spec(sub_spec)
        sys.modules[f'{pkg_name}.{submod}'] = sub_mod
        sub_spec.loader.exec_module(sub_mod)
        setattr(pkg, submod, sub_mod)

    return pkg


try:
    _gov_pkg = _load_governance_package()
    if _gov_pkg is None:
        raise ImportError("governance package files not found next to supervisor")
    load_governance_state = _gov_pkg.hierarchy.load_governance_state
    GovernanceEngine = _gov_pkg.engine.GovernanceEngine
    write_finding = _gov_pkg.ledger.write_finding
    LedgerWriteError = _gov_pkg.ledger.LedgerWriteError
    DispatchRequest = _gov_pkg.models.DispatchRequest
    ArbitrationDecision = _gov_pkg.models.ArbitrationDecision
    GovernanceFinding = _gov_pkg.models.GovernanceFinding
    _GOVERNANCE_AVAILABLE = True
    _GOVERNANCE_IMPORT_ERROR: str | None = None
except ImportError as e:
    # Fail-closed (Requirement 6 / D9): the governance package is required
    # to gate dispatch. If its files are not present in the deployed asset
    # (e.g. a packaging regression that excludes arbiter/governance/), every
    # dispatch must be REFUSED rather than silently allowed through. This
    # branch must NOT crash the module — the handler still has to start so
    # the Lambda remains invokable and observable (it will simply refuse
    # every dispatch, which is itself actionable signal via the error log
    # below and the structured denial result returned per-call).
    _GOVERNANCE_AVAILABLE = False
    _GOVERNANCE_IMPORT_ERROR = str(e)
    logger.error(
        "governance package unavailable (%s); ALL dispatches will be "
        "refused fail-closed until the deployed asset includes "
        "arbiter/governance/. This is not a bypass.",
        e,
    )

_REGION = os.environ.get('AWS_REGION', 'us-west-2')
MODEL_ID = load_model_id(
    region=_REGION,
    fallback_model_id=f"{cross_region_prefix(_REGION)}.anthropic.claude-sonnet-4-6",
)

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


# ---------------------------------------------------------------------------
# Governance control surface (US-ARB-008)
# ---------------------------------------------------------------------------

# SNS client for escalations (lazy — avoids credential discovery at import).
_sns_client = None


def _get_sns():
    global _sns_client
    if _sns_client is None:
        _sns_client = boto3.client('sns')
    return _sns_client


ESCALATION_TOPIC_ARN = os.environ.get('ESCALATION_TOPIC_ARN')


def governed_process_agent_call(
    agents_config: dict,
    orchestration: dict,
    agent_name: str,
    agent_input: Any,
    agent_use_id: str,
    app_id: str | None = None,
) -> Any:
    """Control-surface wrapper around ``process_agent_call`` (US-ARB-008).

    Fail-closed at the dispatch seam. Two independent gates apply, in order:

    1. Governance package availability. If ``arbiter/governance/`` could not
       be loaded at import time (``_GOVERNANCE_AVAILABLE`` is ``False`` —
       see the module-level import block above), every dispatch is REFUSED
       with a structured denial result and an error-level log. This applies
       regardless of enforcement mode and regardless of
       ``ARBITER_GOVERNANCE_BYPASS`` — a missing package means the engine
       cannot be consulted at all, so there is nothing to evaluate against.
       There is no code path from "package unavailable" to
       ``process_agent_call`` — dispatch is refused, never bypassed.

    2. Enforcement mode. The persisted mode is read from
       ``GovernanceState.enforcement_mode`` (``hierarchy.load_governance_state``,
       itself backed by the same SSM parameter
       (``/citadel/governance/enforce/{ENVIRONMENT}``) the rest of the
       platform reads) and controls how an engine DENY/ESCALATE/HALT
       decision is handled once the package IS available:

       * ``permissive`` / ``shadow`` — evaluate, write the finding, and
         proceed regardless of the decision. This differs from a bypass:
         the evaluation and ledger write still happen on every call: only
         the block on DENY/ESCALATE/HALT is skipped.
       * ``strict`` — enforce: PERMIT dispatches, DENY/ESCALATE/HALT block
         (the ESCALATE/HALT branch also publishes to SNS per D7).
       * If no mode is resolvable, ``load_governance_state`` itself already
         defaults to ``'shadow'`` (see hierarchy.py), so this function
         always receives a concrete literal.

    ``ARBITER_GOVERNANCE_BYPASS`` (default unset / falsy) is kept ONLY as an
    explicit emergency override: when set to ``'true'``, it forces
    shadow-style behaviour (evaluate + record + proceed) even when the
    resolved mode is ``'strict'``. It has NO effect on gate 1 above — a
    missing governance package is refused unconditionally. It is intended
    for a human operator to flip temporarily during an incident, not as a
    default deployment posture.

    Fail-closed per D9: any exception from ``write_finding`` propagates and
    halts dispatch, in every mode.

    ``app_id`` scopes the authority graph (D2). ``None`` means no app
    filter.
    """
    # Gate 1 — package availability. Fail-closed: refuse, never fall through
    # to ungoverned dispatch. This is intentionally unconditional; it must
    # not be affected by ARBITER_GOVERNANCE_BYPASS or enforcement mode.
    if not _GOVERNANCE_AVAILABLE:
        workflow_id = (
            orchestration.get('orchestrationId')
            or orchestration.get('workflowId')
            or 'unknown'
        )
        agent_use_id_for_log = agent_use_id
        logger.error(
            "governance dispatch refused: governance package unavailable "
            "(%s); workflow_id=%s target_agent=%s agent_use_id=%s",
            _GOVERNANCE_IMPORT_ERROR,
            workflow_id,
            agent_name,
            agent_use_id_for_log,
        )
        return {
            'denied': True,
            'reason': 'governance_package_unavailable',
            'detail': _GOVERNANCE_IMPORT_ERROR,
            'workflow_id': workflow_id,
            'target_agent': agent_name,
            'agent_use_id': agent_use_id,
        }

    # Emergency override: forces shadow-style (evaluate + record + proceed)
    # regardless of the resolved persisted mode. Documented as an incident
    # escape hatch, not a default posture — see module docstring.
    bypass_override = os.environ.get('ARBITER_GOVERNANCE_BYPASS', 'false').lower() == 'true'

    # 1. Load governance state (with app-scoped filter per D2). Carries the
    #    persisted enforcement mode alongside the four authority tables.
    state = load_governance_state(registry_id=app_id)
    enforcement_mode = getattr(state, 'enforcement_mode', 'shadow')

    # 2. Build DispatchRequest. The orchestration dict uses
    #    ``orchestrationId`` as its workflow identifier.
    workflow_id = (
        orchestration.get('orchestrationId')
        or orchestration.get('workflowId')
        or 'unknown'
    )
    # Domain from agent config (fallback to 'default' — not all agents
    # declare one).
    agent_cfg = None
    for a in agents_config.get('agents', []):
        if a.get('name') == agent_name:
            agent_cfg = a
            break
    domain = (agent_cfg or {}).get('domain', 'default')
    # Requester: we don't have an inter-agent requester concept yet, so the
    # supervisor is the default requesting_agent_id.
    requesting_agent_id = orchestration.get('requesting_agent_id', 'supervisor')

    request = DispatchRequest(
        requesting_agent_id=requesting_agent_id,
        target_agent_id=agent_name,
        action_type='invoke_agent',
        domain=domain,
        workflow_id=workflow_id,
        agent_use_id=agent_use_id,
        context={},
        agent_input=agent_input if isinstance(agent_input, dict) else {'raw': agent_input},
    )

    # 3. Evaluate via engine.
    engine = GovernanceEngine(
        authority_units=state.authority_units,
        composition_contracts=state.composition_contracts,
        case_law=state.case_law,
        constitutional_layers=state.constitutional_layers,
    )
    finding = engine.evaluate(request)

    # 4. Default scope_evaluated if the engine didn't set one (Req 6 Notes).
    if not finding.scope_evaluated:
        finding.scope_evaluated = 'supervisor-dispatch'

    # 5. Write finding (fail-closed per D9). Any exception halts dispatch,
    #    in every mode.
    write_finding(finding)

    # 6. Branch on mode + decision.
    #    permissive/shadow (or the emergency bypass override): evaluate +
    #      record (already done above) + always proceed regardless of
    #      decision.
    #    strict: PERMIT -> call, DENY -> block, ESCALATE/HALT -> SNS + block.
    if bypass_override or enforcement_mode in ('permissive', 'shadow'):
        return process_agent_call(
            agents_config, orchestration, agent_name, agent_input, agent_use_id
        )

    decision = finding.decision
    if decision == ArbitrationDecision.PERMIT:
        return process_agent_call(
            agents_config, orchestration, agent_name, agent_input, agent_use_id
        )
    elif decision == ArbitrationDecision.DENY:
        return {
            'denied': True,
            'finding_id': finding.finding_id,
            'reason': finding.reason,
        }
    else:
        # ESCALATE or HALT — same SNS + block-dispatch behaviour per D7.
        _route_escalation(finding)
        return {
            'escalated': True,
            'finding_id': finding.finding_id,
            'reason': finding.reason,
        }


def _route_escalation(finding) -> None:
    """Publish an SNS escalation notification. No-op if topic unset."""
    if not ESCALATION_TOPIC_ARN:
        logger.info(
            'ESCALATION_TOPIC_ARN unset; skipping SNS publish for finding %s',
            finding.finding_id,
        )
        return
    subject = f'Governance Escalation: {finding.reason}'[:100]
    message = json.dumps({
        'finding_id': finding.finding_id,
        'reason': finding.reason,
        'decision': finding.decision.value if hasattr(finding.decision, 'value') else str(finding.decision),
        'workflow_id': getattr(finding, 'workflow_id', None),
    })
    try:
        _get_sns().publish(
            TopicArn=ESCALATION_TOPIC_ARN,
            Subject=subject,
            Message=message,
        )
    except Exception as e:
        # Escalation SNS failure must NOT break the dispatch return.
        logger.error(
            'Failed to publish escalation SNS for %s: %s',
            finding.finding_id,
            e,
        )


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

    # Activate the per-agent modelOverride binding: resolve the configured
    # model key to a concrete inference-profile id and forward it in the
    # dispatch payload so the worker can set MODEL_OVERRIDE. Dormant no-op
    # unless a binding sets modelOverride AND it resolves against the catalog;
    # any failure is swallowed so dispatch is never broken.
    if agent_config.get('modelOverride'):
        try:
            from model_config_loader import resolve_agent_override
            _resolved = resolve_agent_override(agent_config['modelOverride'], _REGION)
            if _resolved:
                payload['modelOverride'] = _resolved
        except Exception as e:
            logger.warning(
                "modelOverride resolution failed for agent '%s' "
                "(override key '%s', region '%s'): %s",
                agent_name,
                agent_config['modelOverride'],
                _REGION,
                str(e),
            )

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


def invoke_agents_from_conversation(orchestration, agents_config, app_id=None):
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
            result = governed_process_agent_call(
                agents_config,
                orchestration,
                tool_use['name'],
                tool_use['input'],
                tool_use['toolUseId'],
                app_id=app_id if app_id is not None else orchestration.get('app_id'),
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
        orchestration, agent_configs, app_id=app_id
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
    
    else:
        # Removed: 'mcp' callback type (DDB recon: 0 production rows referenced it).
        # Unknown / removed types fall through to no-op log.
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