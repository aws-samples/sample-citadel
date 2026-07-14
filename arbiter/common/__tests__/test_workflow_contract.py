"""Property and unit tests for the workflow node-dispatch / node-result contract.

Exercises the pure message contract shared by the workflow step runner and the
worker: the SQS node-dispatch message (with the discriminator that separates a
workflow-node message from a supervisor task message on the shared queue) and
the EventBridge node-result event detail (completed / failed).

A consistency-guard test imports the step runner's event helpers and asserts
that the contract's event source and node completed/failed detail-type
constants match the values the step runner actually emits, so the two cannot
drift apart. All ids are generic placeholders — never real ARNs or account
data.
"""
from __future__ import annotations

import json
from unittest.mock import patch

import pytest
from hypothesis import given
from hypothesis import strategies as st

from common.workflow_contract import (
    MESSAGE_TYPE_WORKFLOW_NODE,
    NODE_COMPLETED_DETAIL_TYPE,
    NODE_FAILED_DETAIL_TYPE,
    STATUS_COMPLETED,
    STATUS_FAILED,
    WORKFLOW_EVENT_SOURCE,
    NodeDispatchMessage,
    NodeResultDetail,
    build_node_dispatch_message,
    build_node_result_detail,
    is_workflow_node_message,
    parse_node_dispatch_message,
    parse_node_result_detail,
)

# --- Hypothesis strategies ---------------------------------------------------

# Identifiers: non-empty, printable, no surrogates or control chars.
_ids = st.text(
    st.characters(blacklist_categories=('Cs', 'Cc'), min_codepoint=33),
    min_size=1,
    max_size=40,
)
# Free text (may be empty) with no surrogates — safe for json round-trips.
_text = st.text(st.characters(blacklist_categories=('Cs',)), max_size=60)
# Non-empty free text (for error strings).
_nonempty_text = st.text(st.characters(blacklist_categories=('Cs',)), min_size=1, max_size=60)
# JSON-safe scalar values (floats omitted so equality stays exact).
_json_scalars = st.none() | st.booleans() | st.integers() | _text
_json_dicts = st.dictionaries(_text, _json_scalars, max_size=5)


def _supervisor_body() -> dict:
    """A message shaped like the worker's supervisor task payload.

    Mirrors ``workerWrapper/index.py`` process_event: orchestration_id /
    agent_use_id / agent_input / node — and crucially carries no discriminator.
    """
    return {
        'orchestration_id': 'orch-1',
        'agent_use_id': 'use-1',
        'agent_input': {'prompt': 'hello'},
        'node': 'agent-node-1',
    }


# --- Constants ---------------------------------------------------------------


def test_discriminator_and_status_constants_have_expected_values():
    assert MESSAGE_TYPE_WORKFLOW_NODE == 'workflow_node'
    assert STATUS_COMPLETED == 'completed'
    assert STATUS_FAILED == 'failed'


# --- Node-dispatch message: round-trip + serialization -----------------------


@given(
    execution_id=_ids,
    node_id=_ids,
    workflow_id=_ids,
    agent_id=_ids,
    input_data=_json_dicts,
    configuration=_json_dicts,
    correlation_id=st.none() | _ids,
)
def test_dispatch_message_round_trips_all_fields(
    execution_id, node_id, workflow_id, agent_id, input_data, configuration, correlation_id
):
    body = build_node_dispatch_message(
        execution_id=execution_id,
        node_id=node_id,
        workflow_id=workflow_id,
        agent_id=agent_id,
        input=input_data,
        configuration=configuration,
        correlation_id=correlation_id,
    )
    assert parse_node_dispatch_message(body) == NodeDispatchMessage(
        execution_id=execution_id,
        node_id=node_id,
        workflow_id=workflow_id,
        agent_id=agent_id,
        input=input_data,
        configuration=configuration,
        correlation_id=correlation_id,
    )


@given(
    execution_id=_ids,
    node_id=_ids,
    workflow_id=_ids,
    agent_id=_ids,
    input_data=_json_dicts,
    configuration=_json_dicts,
)
def test_dispatch_message_is_json_serializable(
    execution_id, node_id, workflow_id, agent_id, input_data, configuration
):
    body = build_node_dispatch_message(
        execution_id=execution_id,
        node_id=node_id,
        workflow_id=workflow_id,
        agent_id=agent_id,
        input=input_data,
        configuration=configuration,
    )
    reloaded = json.loads(json.dumps(body))
    assert reloaded == body
    assert is_workflow_node_message(reloaded) is True
    # Survives a serialization boundary without becoming unparseable.
    parse_node_dispatch_message(reloaded)


# --- Node-dispatch message: discriminator ------------------------------------


def test_is_workflow_node_message_true_for_workflow_body():
    body = build_node_dispatch_message(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a'
    )
    assert is_workflow_node_message(body) is True


def test_is_workflow_node_message_false_for_supervisor_body():
    assert is_workflow_node_message(_supervisor_body()) is False


def test_is_workflow_node_message_false_for_non_dict():
    assert is_workflow_node_message(None) is False
    assert is_workflow_node_message('workflow_node') is False
    assert is_workflow_node_message(['workflow_node']) is False


def test_parse_dispatch_rejects_supervisor_body():
    with pytest.raises(ValueError):
        parse_node_dispatch_message(_supervisor_body())


# --- Node-dispatch message: validation ---------------------------------------


@pytest.mark.parametrize('missing', ['execution_id', 'node_id', 'workflow_id', 'agent_id'])
def test_parse_dispatch_missing_required_field_raises(missing):
    body = build_node_dispatch_message(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a'
    )
    del body[missing]
    with pytest.raises(ValueError):
        parse_node_dispatch_message(body)


@pytest.mark.parametrize('field_name', ['execution_id', 'node_id', 'workflow_id', 'agent_id'])
def test_parse_dispatch_empty_required_field_raises(field_name):
    body = build_node_dispatch_message(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a'
    )
    body[field_name] = ''
    with pytest.raises(ValueError):
        parse_node_dispatch_message(body)


def test_build_dispatch_rejects_empty_identifier():
    with pytest.raises(ValueError):
        build_node_dispatch_message(
            execution_id='', node_id='n', workflow_id='w', agent_id='a'
        )


# --- Node-result event: round-trip -------------------------------------------


@given(
    execution_id=_ids,
    node_id=_ids,
    workflow_id=_ids,
    agent_id=_ids,
    output=_json_dicts,
    timestamp=_ids,
)
def test_result_detail_round_trips_when_completed(
    execution_id, node_id, workflow_id, agent_id, output, timestamp
):
    detail = build_node_result_detail(
        execution_id=execution_id,
        node_id=node_id,
        workflow_id=workflow_id,
        agent_id=agent_id,
        status=STATUS_COMPLETED,
        output=output,
        timestamp=timestamp,
    )
    assert parse_node_result_detail(detail) == NodeResultDetail(
        execution_id=execution_id,
        node_id=node_id,
        workflow_id=workflow_id,
        agent_id=agent_id,
        status=STATUS_COMPLETED,
        timestamp=timestamp,
        output=output,
        error=None,
    )


@given(
    execution_id=_ids,
    node_id=_ids,
    workflow_id=_ids,
    agent_id=_ids,
    error=_nonempty_text,
    timestamp=_ids,
)
def test_result_detail_round_trips_when_failed(
    execution_id, node_id, workflow_id, agent_id, error, timestamp
):
    detail = build_node_result_detail(
        execution_id=execution_id,
        node_id=node_id,
        workflow_id=workflow_id,
        agent_id=agent_id,
        status=STATUS_FAILED,
        error=error,
        timestamp=timestamp,
    )
    assert parse_node_result_detail(detail) == NodeResultDetail(
        execution_id=execution_id,
        node_id=node_id,
        workflow_id=workflow_id,
        agent_id=agent_id,
        status=STATUS_FAILED,
        timestamp=timestamp,
        output=None,
        error=error,
    )


def test_result_detail_is_json_serializable():
    detail = build_node_result_detail(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a',
        status=STATUS_COMPLETED, output={'k': 'v'}, timestamp='2026-01-01T00:00:00+00:00',
    )
    reloaded = json.loads(json.dumps(detail))
    assert reloaded == detail
    assert parse_node_result_detail(reloaded).output == {'k': 'v'}


# --- Node-result event: validation -------------------------------------------


def test_build_result_rejects_invalid_status():
    with pytest.raises(ValueError):
        build_node_result_detail(
            execution_id='e', node_id='n', workflow_id='w', agent_id='a',
            status='running', output={}, timestamp='t',
        )


def test_parse_result_rejects_invalid_status():
    detail = build_node_result_detail(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a',
        status=STATUS_COMPLETED, output={}, timestamp='t',
    )
    detail['status'] = 'running'
    with pytest.raises(ValueError):
        parse_node_result_detail(detail)


def test_completed_result_requires_output():
    with pytest.raises(ValueError):
        build_node_result_detail(
            execution_id='e', node_id='n', workflow_id='w', agent_id='a',
            status=STATUS_COMPLETED, output=None, timestamp='t',
        )


def test_failed_result_requires_error():
    with pytest.raises(ValueError):
        build_node_result_detail(
            execution_id='e', node_id='n', workflow_id='w', agent_id='a',
            status=STATUS_FAILED, error=None, timestamp='t',
        )


def test_parse_completed_missing_output_raises():
    detail = build_node_result_detail(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a',
        status=STATUS_COMPLETED, output={'k': 'v'}, timestamp='t',
    )
    del detail['output']
    with pytest.raises(ValueError):
        parse_node_result_detail(detail)


def test_parse_failed_missing_error_raises():
    detail = build_node_result_detail(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a',
        status=STATUS_FAILED, error='boom', timestamp='t',
    )
    del detail['error']
    with pytest.raises(ValueError):
        parse_node_result_detail(detail)


# --- Consistency guard against the step runner's event helpers ---------------


def test_contract_matches_step_runner_event_identifiers():
    """Pin the contract's event identifiers to what the step runner emits.

    The step runner's ``events`` module is the existing producer of the
    workflow lifecycle events. Its ``SOURCE`` is a module-level constant, but
    the node completed/failed detail-types are *function-local string literals*
    inside ``publish_node_completed`` / ``publish_node_failed`` (no module
    constants exist for them). So rather than asserting against a re-typed
    literal, we exercise the real emission path with ``publish_event`` patched
    and read back the exact detail-type each helper passes — guaranteeing this
    contract reuses the same strings and cannot drift from events.py.
    """
    import events

    assert events.SOURCE == WORKFLOW_EVENT_SOURCE

    with patch.object(events, 'publish_event') as pub:
        events.publish_node_completed(
            execution_id='e', workflow_id='w', node_id='n',
            agent_id='a', completed_at='t', output={},
        )
    assert pub.call_args.args[0] == NODE_COMPLETED_DETAIL_TYPE

    with patch.object(events, 'publish_event') as pub:
        events.publish_node_failed(
            execution_id='e', workflow_id='w', node_id='n',
            agent_id='a', error='boom', retry_count=0,
        )
    assert pub.call_args.args[0] == NODE_FAILED_DETAIL_TYPE


# --- Tester-added: defensive validation branches (independent verification) --
# These characterize already-implemented guard branches that the initial suite
# left uncovered. They exercise existing, correct behavior, so passing on the
# first run is expected — the point is to pin these error paths against drift.


def test_is_workflow_node_message_false_for_wrong_discriminator_value():
    """A body carrying a *different* message_type is not a workflow node."""
    body = build_node_dispatch_message(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a'
    )
    body['message_type'] = 'supervisor_task'
    assert is_workflow_node_message(body) is False
    with pytest.raises(ValueError):
        parse_node_dispatch_message(body)


@pytest.mark.parametrize('bad', ['x', 123, ['a']])
def test_build_dispatch_rejects_non_dict_input(bad):
    with pytest.raises(ValueError):
        build_node_dispatch_message(
            execution_id='e', node_id='n', workflow_id='w', agent_id='a', input=bad
        )


@pytest.mark.parametrize('bad', ['x', 123, ['a']])
def test_build_dispatch_rejects_non_dict_configuration(bad):
    with pytest.raises(ValueError):
        build_node_dispatch_message(
            execution_id='e', node_id='n', workflow_id='w', agent_id='a', configuration=bad
        )


@pytest.mark.parametrize('bad', [123, ['a'], {'x': 1}])
def test_build_dispatch_rejects_non_str_correlation_id(bad):
    with pytest.raises(ValueError):
        build_node_dispatch_message(
            execution_id='e', node_id='n', workflow_id='w', agent_id='a', correlation_id=bad
        )


@pytest.mark.parametrize('bad', ['x', 123, ['a'], None])
@pytest.mark.parametrize('key', ['input', 'configuration'])
def test_parse_dispatch_rejects_non_dict_input_or_config(key, bad):
    body = build_node_dispatch_message(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a'
    )
    body[key] = bad
    with pytest.raises(ValueError):
        parse_node_dispatch_message(body)


def test_parse_dispatch_rejects_non_str_correlation_id():
    body = build_node_dispatch_message(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a', correlation_id='c'
    )
    body['correlation_id'] = 123
    with pytest.raises(ValueError):
        parse_node_dispatch_message(body)


@pytest.mark.parametrize('bad', [None, 'x', 123, ['a']])
def test_parse_result_rejects_non_dict_detail(bad):
    with pytest.raises(ValueError):
        parse_node_result_detail(bad)


@pytest.mark.parametrize('field_name', ['executionId', 'nodeId', 'workflowId', 'agentId', 'timestamp'])
def test_parse_result_missing_identifier_raises(field_name):
    detail = build_node_result_detail(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a',
        status=STATUS_COMPLETED, output={'k': 'v'}, timestamp='t',
    )
    del detail[field_name]
    with pytest.raises(ValueError):
        parse_node_result_detail(detail)


@pytest.mark.parametrize('field_name', ['executionId', 'nodeId', 'workflowId', 'agentId', 'timestamp'])
def test_parse_result_empty_identifier_raises(field_name):
    detail = build_node_result_detail(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a',
        status=STATUS_COMPLETED, output={'k': 'v'}, timestamp='t',
    )
    detail[field_name] = ''
    with pytest.raises(ValueError):
        parse_node_result_detail(detail)


@pytest.mark.parametrize('bad', ['x', 123, ['a']])
def test_build_completed_result_rejects_non_dict_output(bad):
    with pytest.raises(ValueError):
        build_node_result_detail(
            execution_id='e', node_id='n', workflow_id='w', agent_id='a',
            status=STATUS_COMPLETED, output=bad, timestamp='t',
        )


def test_build_result_defaults_timestamp_when_omitted():
    """Omitting timestamp populates a non-empty ISO string and stays parseable."""
    detail = build_node_result_detail(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a',
        status=STATUS_COMPLETED, output={'k': 'v'},
    )
    assert isinstance(detail['timestamp'], str) and detail['timestamp'] != ''
    assert parse_node_result_detail(detail).status == STATUS_COMPLETED
