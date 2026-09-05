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
# Identity fields that flow through _validate_identity (execution_id,
# node_id, workflow_id, agent_id on build_node_dispatch_message /
# build_node_result_detail): same as _ids but excludes the reserved ledger
# key delimiter '#', which those builders now reject (see
# common.workflow_contract._validate_identity / LEDGER_KEY_DELIMITER, the
# f9ceb38e ledger-key-collision fix). '#'-hygiene itself is covered by its
# own dedicated rejection tests below.
_identity_ids = _ids.filter(lambda s: '#' not in s)
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
    execution_id=_identity_ids,
    node_id=_identity_ids,
    workflow_id=_identity_ids,
    agent_id=_identity_ids,
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
    execution_id=_identity_ids,
    node_id=_identity_ids,
    workflow_id=_identity_ids,
    agent_id=_identity_ids,
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
    execution_id=_identity_ids,
    node_id=_identity_ids,
    workflow_id=_identity_ids,
    agent_id=_identity_ids,
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
    execution_id=_identity_ids,
    node_id=_identity_ids,
    workflow_id=_identity_ids,
    agent_id=_identity_ids,
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


# --- Node-result event: additive usage passthrough (rollup) -----------------


def test_build_result_completed_with_usage_sets_top_level_usage():
    """A completed result built with usage=[...] carries a top-level 'usage'
    key, additive to (and separate from) any usage nested inside output."""
    usage = [{'inputTokens': 5, 'outputTokens': 7}]
    detail = build_node_result_detail(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a',
        status=STATUS_COMPLETED, output={'response': 'ok'}, timestamp='t',
        usage=usage,
    )
    assert detail['usage'] == usage
    assert detail['output'] == {'response': 'ok'}


def test_build_result_completed_without_usage_omits_usage_key():
    """Omitting usage entirely keeps the detail byte-identical to before this
    feature — no 'usage' key appears."""
    detail = build_node_result_detail(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a',
        status=STATUS_COMPLETED, output={'response': 'ok'}, timestamp='t',
    )
    assert 'usage' not in detail


def test_build_result_failed_ignores_usage():
    """A failed result never carries a top-level usage key, even if a caller
    passes one — failed results have no output to attribute usage to."""
    detail = build_node_result_detail(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a',
        status=STATUS_FAILED, error='boom', timestamp='t',
        usage=[{'inputTokens': 1, 'outputTokens': 1}],
    )
    assert 'usage' not in detail


def test_build_result_malformed_usage_never_raises_and_is_sanitized():
    """A non-list usage value is sanitized to [] rather than raising or
    passing through garbage — build_node_result_detail must never raise on
    malformed usage."""
    detail = build_node_result_detail(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a',
        status=STATUS_COMPLETED, output={'response': 'ok'}, timestamp='t',
        usage='not-a-list',  # type: ignore[arg-type]
    )
    assert detail['usage'] == []


def test_parse_result_detail_passes_through_top_level_usage():
    usage = [{'inputTokens': 3, 'outputTokens': 4}]
    detail = build_node_result_detail(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a',
        status=STATUS_COMPLETED, output={'response': 'ok'}, timestamp='t',
        usage=usage,
    )
    parsed = parse_node_result_detail(detail)
    assert parsed.usage == usage


def test_parse_result_detail_defaults_usage_to_empty_list_when_absent():
    detail = build_node_result_detail(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a',
        status=STATUS_COMPLETED, output={'response': 'ok'}, timestamp='t',
    )
    parsed = parse_node_result_detail(detail)
    assert parsed.usage == []


def test_parse_result_detail_sanitizes_malformed_usage_on_the_wire():
    """A detail body that arrived over the wire with a malformed 'usage'
    value (e.g. hand-crafted or corrupted) is sanitized, never raised on."""
    detail = build_node_result_detail(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a',
        status=STATUS_COMPLETED, output={'response': 'ok'}, timestamp='t',
    )
    detail['usage'] = 'garbage'
    parsed = parse_node_result_detail(detail)
    assert parsed.usage == []


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


# ---------------------------------------------------------------------------
# R18: trace_context is an additive, optional kwarg on both builders.
# Architect task f4f4bab3-7a07-4acf-ba43-ba43bb488444, design §"File-by-file
# list" item 10 — omitted entirely when the kwarg is not passed, keeping the
# detail/message byte-identical to pre-feature callers.
# ---------------------------------------------------------------------------


def test_r18_build_node_dispatch_message_omits_trace_context_key_when_not_passed():
    message = build_node_dispatch_message(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a',
    )
    assert 'traceContext' not in message


def test_r18_build_node_dispatch_message_includes_trace_context_when_passed():
    ctx = {'traceId': '1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb', 'parentId': 'cccccccccccccccc'}
    message = build_node_dispatch_message(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a',
        trace_context=ctx,
    )
    assert message['traceContext'] == ctx
    # Round-trips through the contract's own parser without raising.
    parsed = parse_node_dispatch_message(message)
    assert parsed.node_id == 'n'


def test_r18_build_node_result_detail_omits_trace_context_key_when_not_passed():
    detail = build_node_result_detail(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a',
        status=STATUS_COMPLETED, output={'k': 'v'}, timestamp='t',
    )
    assert 'traceContext' not in detail


def test_r18_build_node_result_detail_includes_trace_context_when_passed():
    ctx = {'traceId': '1-aaaaaaaa-bbbbbbbbbbbbbbbbbbbbbbbb', 'parentId': 'cccccccccccccccc'}
    detail = build_node_result_detail(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a',
        status=STATUS_COMPLETED, output={'k': 'v'}, timestamp='t',
        trace_context=ctx,
    )
    assert detail['traceContext'] == ctx


def test_r18_build_node_result_detail_failed_omits_trace_context_when_not_passed():
    detail = build_node_result_detail(
        execution_id='e', node_id='n', workflow_id='w', agent_id='a',
        status=STATUS_FAILED, error='boom', timestamp='t',
    )
    assert 'traceContext' not in detail


# ---------------------------------------------------------------------------
# Queue-wait metric: additive dispatched_at (dispatch message) and
# worker_started_at / dispatched_at echo (node-result detail).
# ---------------------------------------------------------------------------

class TestDispatchMessageDispatchedAtAdditive:
    def test_omitted_dispatched_at_keeps_message_byte_identical(self):
        """A pre-feature caller that never passes dispatched_at gets a
        message with no 'dispatchedAt' key at all — not a null/empty one."""
        message = build_node_dispatch_message(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
        )
        assert 'dispatchedAt' not in message

    def test_supplied_dispatched_at_is_promoted_to_top_level_key(self):
        message = build_node_dispatch_message(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
            dispatched_at='2026-01-01T00:00:00+00:00',
        )
        assert message['dispatchedAt'] == '2026-01-01T00:00:00+00:00'

    def test_non_string_dispatched_at_raises(self):
        with pytest.raises(ValueError):
            build_node_dispatch_message(
                execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
                dispatched_at=12345,  # type: ignore[arg-type]
            )

    def test_parse_round_trips_dispatched_at(self):
        message = build_node_dispatch_message(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
            dispatched_at='2026-01-01T00:00:00+00:00',
        )
        parsed = parse_node_dispatch_message(message)
        assert parsed.dispatched_at == '2026-01-01T00:00:00+00:00'

    def test_parse_defaults_dispatched_at_to_none_when_absent(self):
        message = build_node_dispatch_message(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
        )
        parsed = parse_node_dispatch_message(message)
        assert parsed.dispatched_at is None

    def test_parse_never_raises_on_malformed_dispatched_at_on_the_wire(self):
        """A malformed dispatchedAt (wrong type) on the wire degrades to None
        rather than raising — queue-wait is best-effort telemetry, not a
        gate on node dispatch parsing."""
        message = build_node_dispatch_message(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
        )
        message['dispatchedAt'] = 12345
        parsed = parse_node_dispatch_message(message)
        assert parsed.dispatched_at is None


class TestNodeResultDetailQueueWaitTimestampsAdditive:
    def test_omitted_timestamps_keep_detail_byte_identical(self):
        detail = build_node_result_detail(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
            status=STATUS_COMPLETED, output={'ok': True},
        )
        assert 'dispatchedAt' not in detail
        assert 'workerStartedAt' not in detail

    def test_supplied_timestamps_are_promoted_on_completed_result(self):
        detail = build_node_result_detail(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
            status=STATUS_COMPLETED, output={'ok': True},
            dispatched_at='2026-01-01T00:00:00+00:00',
            worker_started_at='2026-01-01T00:00:01+00:00',
        )
        assert detail['dispatchedAt'] == '2026-01-01T00:00:00+00:00'
        assert detail['workerStartedAt'] == '2026-01-01T00:00:01+00:00'

    def test_supplied_timestamps_are_promoted_on_failed_result_too(self):
        """Queue-wait is measurable even for a node that ultimately failed —
        the timestamps are not gated on status."""
        detail = build_node_result_detail(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
            status=STATUS_FAILED, error='boom',
            dispatched_at='2026-01-01T00:00:00+00:00',
            worker_started_at='2026-01-01T00:00:01+00:00',
        )
        assert detail['dispatchedAt'] == '2026-01-01T00:00:00+00:00'
        assert detail['workerStartedAt'] == '2026-01-01T00:00:01+00:00'

    def test_only_one_timestamp_supplied_omits_the_other(self):
        detail = build_node_result_detail(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
            status=STATUS_COMPLETED, output={'ok': True},
            worker_started_at='2026-01-01T00:00:01+00:00',
        )
        assert 'dispatchedAt' not in detail
        assert detail['workerStartedAt'] == '2026-01-01T00:00:01+00:00'

    def test_parse_round_trips_both_timestamps(self):
        detail = build_node_result_detail(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
            status=STATUS_COMPLETED, output={'ok': True},
            dispatched_at='2026-01-01T00:00:00+00:00',
            worker_started_at='2026-01-01T00:00:01+00:00',
        )
        parsed = parse_node_result_detail(detail)
        assert parsed.dispatched_at == '2026-01-01T00:00:00+00:00'
        assert parsed.worker_started_at == '2026-01-01T00:00:01+00:00'

    def test_parse_defaults_both_timestamps_to_none_when_absent(self):
        detail = build_node_result_detail(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
            status=STATUS_COMPLETED, output={'ok': True},
        )
        parsed = parse_node_result_detail(detail)
        assert parsed.dispatched_at is None
        assert parsed.worker_started_at is None

    def test_parse_never_raises_on_malformed_timestamps_on_the_wire(self):
        detail = build_node_result_detail(
            execution_id='exec-1', node_id='n0', workflow_id='wf-1', agent_id='agent-A',
            status=STATUS_COMPLETED, output={'ok': True},
        )
        detail['dispatchedAt'] = 12345
        detail['workerStartedAt'] = {}
        parsed = parse_node_result_detail(detail)
        assert parsed.dispatched_at is None
        assert parsed.worker_started_at is None


# --- Compensation block (CIT-123 slice 1: data only, no executor behaviour) --
#
# An optional, additive per-node ``compensation`` block: ``{tool, args,
# sideEffecting?}``. Validated via ``normalize_compensation_block``. A node
# with no ``compensation`` key must behave and serialize byte-identically to
# today. See ``COMPENSATION_TRIGGER_DEFAULTS`` / ``COMPENSATION_ON_FAILURE_DEFAULT``
# below for the workflow-level policy defaults (owner call, provisional).


class TestNormalizeCompensationBlock:
    """Red-first unit tests for the pure per-node compensation validator."""

    def test_absent_block_returns_none(self):
        from common.workflow_contract import normalize_compensation_block

        assert normalize_compensation_block({'id': 'n1', 'agentId': 'a1'}) is None

    def test_none_block_returns_none(self):
        from common.workflow_contract import normalize_compensation_block

        assert normalize_compensation_block({'id': 'n1', 'compensation': None}) is None

    def test_valid_block_roundtrips_with_defaults(self):
        from common.workflow_contract import normalize_compensation_block

        node = {
            'id': 'n1',
            'compensation': {
                'tool': 'close_ticket',
                'args': {'ticketId': '${output.ticketId}'},
            },
        }
        result = normalize_compensation_block(node)
        assert result == {
            'tool': 'close_ticket',
            'args': {'ticketId': '${output.ticketId}'},
            'sideEffecting': True,
        }

    def test_valid_block_preserves_explicit_side_effecting_false(self):
        from common.workflow_contract import normalize_compensation_block

        node = {
            'compensation': {
                'tool': 'noop',
                'args': {},
                'sideEffecting': False,
            }
        }
        result = normalize_compensation_block(node)
        assert result == {'tool': 'noop', 'args': {}, 'sideEffecting': False}

    def test_missing_tool_raises(self):
        from common.workflow_contract import normalize_compensation_block

        with pytest.raises(ValueError, match="'tool'"):
            normalize_compensation_block({'compensation': {'args': {}}})

    def test_empty_tool_raises(self):
        from common.workflow_contract import normalize_compensation_block

        with pytest.raises(ValueError, match="'tool'"):
            normalize_compensation_block({'compensation': {'tool': '', 'args': {}}})

    def test_non_string_tool_raises(self):
        from common.workflow_contract import normalize_compensation_block

        with pytest.raises(ValueError, match="'tool'"):
            normalize_compensation_block({'compensation': {'tool': 123, 'args': {}}})

    def test_missing_args_raises(self):
        from common.workflow_contract import normalize_compensation_block

        with pytest.raises(ValueError, match="'args'"):
            normalize_compensation_block({'compensation': {'tool': 'close_ticket'}})

    def test_non_object_args_raises(self):
        from common.workflow_contract import normalize_compensation_block

        with pytest.raises(ValueError, match="'args'"):
            normalize_compensation_block(
                {'compensation': {'tool': 'close_ticket', 'args': 'not-a-dict'}}
            )

    def test_non_object_compensation_block_raises(self):
        from common.workflow_contract import normalize_compensation_block

        with pytest.raises(ValueError, match='compensation'):
            normalize_compensation_block({'compensation': 'not-a-dict'})

    def test_unknown_key_raises(self):
        from common.workflow_contract import normalize_compensation_block

        with pytest.raises(ValueError, match='unknown'):
            normalize_compensation_block(
                {
                    'compensation': {
                        'tool': 'close_ticket',
                        'args': {},
                        'bogusKey': True,
                    }
                }
            )

    def test_non_bool_side_effecting_raises(self):
        from common.workflow_contract import normalize_compensation_block

        with pytest.raises(ValueError, match="'sideEffecting'"):
            normalize_compensation_block(
                {'compensation': {'tool': 'close_ticket', 'args': {}, 'sideEffecting': 'yes'}}
            )

    def test_node_not_a_dict_raises(self):
        from common.workflow_contract import normalize_compensation_block

        with pytest.raises(ValueError):
            normalize_compensation_block('not-a-dict')  # type: ignore[arg-type]

    # --- template-syntax validation at parse time (renderer is slice 2) -----
    # Only syntactic well-formedness of ``${output....}`` tokens is checked
    # here: balanced ``${`` / ``}``, and (when present) the token body must
    # start with ``output`` followed only by ``.<identifier>`` or
    # ``[<int>]`` segments. Resolving the reference against a recorded
    # output is explicitly out of scope (slice 2).

    def test_template_syntax_valid_nested_path_accepted(self):
        from common.workflow_contract import normalize_compensation_block

        node = {
            'compensation': {
                'tool': 'close_ticket',
                'args': {'id': '${output.ticket.id}'},
            }
        }
        result = normalize_compensation_block(node)
        assert result['args'] == {'id': '${output.ticket.id}'}

    def test_template_syntax_valid_array_index_accepted(self):
        from common.workflow_contract import normalize_compensation_block

        node = {
            'compensation': {
                'tool': 'close_ticket',
                'args': {'id': '${output.tickets[0].id}'},
            }
        }
        normalize_compensation_block(node)  # must not raise

    def test_template_syntax_plain_string_without_tokens_accepted(self):
        from common.workflow_contract import normalize_compensation_block

        node = {
            'compensation': {
                'tool': 'close_ticket',
                'args': {'reason': 'manual rollback, no template here'},
            }
        }
        normalize_compensation_block(node)  # must not raise

    def test_template_syntax_unbalanced_brace_raises(self):
        from common.workflow_contract import normalize_compensation_block

        node = {
            'compensation': {
                'tool': 'close_ticket',
                'args': {'id': '${output.ticketId'},
            }
        }
        with pytest.raises(ValueError, match='template'):
            normalize_compensation_block(node)

    def test_template_syntax_wrong_root_raises(self):
        from common.workflow_contract import normalize_compensation_block

        node = {
            'compensation': {
                'tool': 'close_ticket',
                'args': {'id': '${input.ticketId}'},
            }
        }
        with pytest.raises(ValueError, match='template'):
            normalize_compensation_block(node)

    def test_template_syntax_empty_token_raises(self):
        from common.workflow_contract import normalize_compensation_block

        node = {
            'compensation': {
                'tool': 'close_ticket',
                'args': {'id': '${}'},
            }
        }
        with pytest.raises(ValueError, match='template'):
            normalize_compensation_block(node)

    def test_template_syntax_checked_recursively_in_nested_args(self):
        from common.workflow_contract import normalize_compensation_block

        node = {
            'compensation': {
                'tool': 'close_ticket',
                'args': {'nested': {'deep': ['${output.foo}', '${bad syntax']}},
            }
        }
        with pytest.raises(ValueError, match='template'):
            normalize_compensation_block(node)

    def test_template_syntax_eval_gadget_string_is_inert_literal_not_rejected(self):
        # Per D4: no eval/format; a gadget-shaped literal that isn't a
        # well-formed ${output...} token is just an ordinary string value —
        # NOT a template reference — so it is accepted, not executed.
        from common.workflow_contract import normalize_compensation_block

        node = {
            'compensation': {
                'tool': 'close_ticket',
                'args': {'payload': '{0.__class__.__mro__}'},
            }
        }
        normalize_compensation_block(node)  # must not raise


# --- Absent-block equivalence (byte-identical when no compensation block) ---


class TestCompensationAbsentEquivalence:
    """A workflow/node with no ``compensation`` key must be byte-identical
    (dispatch message + serialization) to pre-feature behaviour."""

    def test_build_node_dispatch_message_unaffected_by_compensation_feature(self):
        # No compensation kwarg exists on the dispatch builder (slice 1 keeps
        # the wire dispatch message untouched per the design note) — this
        # pins that the dispatch message shape is unchanged.
        message = build_node_dispatch_message(
            execution_id='exec-1',
            node_id='node-1',
            workflow_id='wf-1',
            agent_id='agent-1',
        )
        assert message == {
            'message_type': MESSAGE_TYPE_WORKFLOW_NODE,
            'execution_id': 'exec-1',
            'node_id': 'node-1',
            'workflow_id': 'wf-1',
            'agent_id': 'agent-1',
            'input': {},
            'configuration': {},
        }

    @given(
        node_dict=st.fixed_dictionaries(
            {
                'id': _ids,
                'agentId': _ids,
            }
        )
    )
    def test_normalize_compensation_block_is_none_for_any_node_without_the_key(
        self, node_dict: dict
    ):
        from common.workflow_contract import normalize_compensation_block

        # Property: for any node dict that does not carry a 'compensation'
        # key, the normalizer is a no-op (returns None) regardless of what
        # other keys/values the node carries.
        before = json.dumps(node_dict, sort_keys=True)
        assert normalize_compensation_block(node_dict) is None
        after = json.dumps(node_dict, sort_keys=True)
        assert before == after  # normalizer must not mutate its input


# --- Workflow-level compensation policy defaults (owner call, provisional) --


class TestCompensationPolicyDefaults:
    """The workflow-level opt-in/policy surface: conservative defaults,
    declared in one place so the (still-open) owner decision is a one-line
    change. See the module-level comment above the constants for rationale.
    """

    def test_defaults_module_constants_exist_and_are_conservative(self):
        from common.workflow_contract import (
            COMPENSATION_ON_FAILURE_DEFAULT,
            COMPENSATION_TRIGGER_MIN_COMPLETED_NODES_DEFAULT,
            COMPENSATION_TRIGGER_MODE_DEFAULT,
        )

        # Conservative: disabled unless explicitly opted in.
        assert COMPENSATION_TRIGGER_MODE_DEFAULT == 'off'
        assert COMPENSATION_TRIGGER_MIN_COMPLETED_NODES_DEFAULT == 0
        # Conservative: stop rather than best-effort continue on failure.
        assert COMPENSATION_ON_FAILURE_DEFAULT == 'stop'

    def test_normalize_compensation_policy_applies_defaults_when_absent(self):
        from common.workflow_contract import normalize_compensation_policy

        assert normalize_compensation_policy(None) == {
            'enabled': False,
            'trigger': {'mode': 'off', 'minCompletedNodes': 0},
            'onFailure': 'stop',
        }
        assert normalize_compensation_policy({}) == {
            'enabled': False,
            'trigger': {'mode': 'off', 'minCompletedNodes': 0},
            'onFailure': 'stop',
        }

    def test_normalize_compensation_policy_roundtrips_explicit_values(self):
        from common.workflow_contract import normalize_compensation_policy

        policy = {
            'enabled': True,
            'trigger': {'mode': 'on_terminal_failure', 'minCompletedNodes': 2},
            'onFailure': 'continue',
        }
        assert normalize_compensation_policy(policy) == policy

    def test_normalize_compensation_policy_rejects_unknown_top_level_key(self):
        from common.workflow_contract import normalize_compensation_policy

        with pytest.raises(ValueError, match='unknown'):
            normalize_compensation_policy({'enabled': True, 'bogus': 1})

    def test_normalize_compensation_policy_rejects_unknown_trigger_key(self):
        from common.workflow_contract import normalize_compensation_policy

        with pytest.raises(ValueError, match='unknown'):
            normalize_compensation_policy({'trigger': {'mode': 'off', 'bogus': 1}})

    def test_normalize_compensation_policy_rejects_bad_trigger_mode(self):
        from common.workflow_contract import normalize_compensation_policy

        with pytest.raises(ValueError, match='mode'):
            normalize_compensation_policy({'trigger': {'mode': 'sometimes'}})

    def test_normalize_compensation_policy_rejects_negative_min_completed_nodes(self):
        from common.workflow_contract import normalize_compensation_policy

        with pytest.raises(ValueError, match='minCompletedNodes'):
            normalize_compensation_policy({'trigger': {'minCompletedNodes': -1}})

    def test_normalize_compensation_policy_rejects_bad_on_failure(self):
        from common.workflow_contract import normalize_compensation_policy

        with pytest.raises(ValueError, match='onFailure'):
            normalize_compensation_policy({'onFailure': 'retry'})

    def test_normalize_compensation_policy_rejects_non_bool_enabled(self):
        from common.workflow_contract import normalize_compensation_policy

        with pytest.raises(ValueError, match='enabled'):
            normalize_compensation_policy({'enabled': 'yes'})

    def test_normalize_compensation_policy_rejects_non_object_policy(self):
        from common.workflow_contract import normalize_compensation_policy

        with pytest.raises(ValueError, match='compensation'):
            normalize_compensation_policy('not-a-dict')  # type: ignore[arg-type]
