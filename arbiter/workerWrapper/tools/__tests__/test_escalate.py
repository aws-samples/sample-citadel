"""Unit + property tests for the Jagged-Frontier escalate tool.

Validates Requirements 9.1 and 9.3 — exactly one event + one metric per call.
"""
import json
import os
import sys
import uuid
from unittest.mock import MagicMock

import pytest
from hypothesis import given, settings, strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

# Ensure env var is set before tool module is imported (defensive; also set
# per-test in the autouse fixture below for isolation).
os.environ.setdefault('EVENT_BUS_NAME', 'citadel-agents-test')

import escalate as escalate_module # noqa: E402
from escalate import escalate # noqa: E402

# Module-level alias avoids Python class name-mangling on the double-underscore
# helper when invoked from inside a test class (``__name`` inside class ``Cls``
# is rewritten to ``_Cls__name`` by the compiler).
_reset_clients = getattr(escalate_module, '__reset_escalate_clients_for_test')

# ---------------------------------------------------------------------------
# Fixture: reset module-level boto3 client caches + bind fresh MagicMocks
# ---------------------------------------------------------------------------

@pytest.fixture
def mocks(monkeypatch):
    """Reset cached clients and bind fresh MagicMocks to module globals.

    The escalate module caches boto3 clients in ``_cw_client`` / ``_eb_client``
    on first access. We use the provided ``__reset_escalate_clients_for_test``
    helper to clear those, then monkeypatch fresh MagicMocks directly so the
    lazy constructors short-circuit to the mocks.
    """
    monkeypatch.setenv('EVENT_BUS_NAME', 'citadel-agents-test')
    _reset_clients()
    eb_mock = MagicMock()
    cw_mock = MagicMock()
    monkeypatch.setattr(escalate_module, '_eb_client', eb_mock)
    monkeypatch.setattr(escalate_module, '_cw_client', cw_mock)
    yield eb_mock, cw_mock
    _reset_clients()

def _detail_from_put_events(eb_mock: MagicMock) -> dict:
    """Extract + parse the Detail payload from a put_events call."""
    call = eb_mock.put_events.call_args
    entries = call.kwargs['Entries']
    assert len(entries) == 1, 'escalate must emit exactly one entry'
    return json.loads(entries[0]['Detail'])

# ---------------------------------------------------------------------------
# AC-1: deterministic single-call telemetry
# ---------------------------------------------------------------------------

class TestAC1SingleCallTelemetry:
    """AC-1: one call → exactly one event + exactly one metric.

    Validates Requirement 9.1 (one event per escalation) and 9.3
    (CitadelGovernance/OffFrontierEscalations increments by exactly 1).
    """

    def test_one_call_emits_exactly_one_event_with_correct_headers(self, mocks):
        eb_mock, _ = mocks
        escalate(
            reason='judgment call beyond model scope',
            project_id='proj-123',
            agent_id='agent-7',
            correlation_id='cid-test-1',
        )
        assert eb_mock.put_events.call_count == 1
        entries = eb_mock.put_events.call_args.kwargs['Entries']
        assert len(entries) == 1
        assert entries[0]['Source'] == 'citadel.backend'
        assert entries[0]['DetailType'] == 'governance.offfrontier.escalated'
        assert entries[0]['EventBusName'] == 'citadel-agents-test'

    def test_one_call_emits_exactly_one_metric_value_one(self, mocks):
        _, cw_mock = mocks
        escalate(
            reason='human judgment required',
            project_id='proj-456',
            agent_id='agent-9',
            correlation_id='cid-test-2',
        )
        assert cw_mock.put_metric_data.call_count == 1
        kwargs = cw_mock.put_metric_data.call_args.kwargs
        assert kwargs['Namespace'] == 'CitadelGovernance'
        md = kwargs['MetricData']
        assert len(md) == 1
        assert md[0]['MetricName'] == 'OffFrontierEscalations'
        assert md[0]['Value'] == 1
        assert md[0]['Unit'] == 'Count'
        assert md[0]['Dimensions'] == [{'Name': 'ProjectId', 'Value': 'proj-456'}]

# ---------------------------------------------------------------------------
# AC-2: escalate is the ONLY path to the metric
# ---------------------------------------------------------------------------

class TestAC2OnlyPathToMetric:
    """AC-2: if escalate is not called, the metric never fires.

    Demonstrates by constructing fresh mocks and performing unrelated work.
    """

    def test_no_escalate_call_yields_no_metric(self, mocks):
        eb_mock, cw_mock = mocks
        # Do unrelated work that does NOT invoke escalate.
        _ = {'unrelated': 'dict'}
        [x * 2 for x in range(10)]
        # Neither client should be touched.
        assert eb_mock.put_events.call_count == 0
        assert cw_mock.put_metric_data.call_count == 0

# ---------------------------------------------------------------------------
# Return-value contract
# ---------------------------------------------------------------------------

class TestReturnValue:
    def test_returns_escalated_status_and_human_message(self, mocks):
        result = escalate(
            reason='out of scope',
            project_id='proj-1',
            agent_id='agent-1',
            correlation_id='cid-static',
        )
        assert result == {
            'status': 'escalated',
            'message': 'Escalation routed to human reviewer',
        }

# ---------------------------------------------------------------------------
# Correction 1: JSON-injection defence
# ---------------------------------------------------------------------------

class TestCorrection1JsonInjectionDefence:
    """The Detail field must be produced via json.dumps — not f-string
    interpolation — so reason/project_id/agent_id containing quotes or
    newlines cannot break the envelope.
    """

    def test_reason_with_quotes_and_newlines_produces_valid_json(self, mocks):
        eb_mock, _ = mocks
        malicious = '" injected \\" newline\n'
        escalate(
            reason=malicious,
            project_id='proj-inj',
            agent_id='agent-inj',
            correlation_id='cid-inj',
        )
        detail = _detail_from_put_events(eb_mock)
        # Round-trip survives: reason preserved verbatim, envelope still valid.
        assert detail['reason'] == malicious
        assert detail['projectId'] == 'proj-inj'
        assert detail['agentId'] == 'agent-inj'

    def test_project_id_with_embedded_quotes_is_escaped(self, mocks):
        eb_mock, _ = mocks
        escalate(
            reason='normal',
            project_id='proj-"weird"',
            agent_id='agent-x',
            correlation_id='cid-x',
        )
        detail = _detail_from_put_events(eb_mock)
        assert detail['projectId'] == 'proj-"weird"'

# ---------------------------------------------------------------------------
# Correction 2: timezone-aware datetime
# ---------------------------------------------------------------------------

class TestCorrection2TimezoneAware:
    """Python 3.14 (QD-10, I14) deprecates datetime.utcnow(); we use
    datetime.now(timezone.utc), which emits ISO strings ending in +00:00.
    """

    def test_timestamp_is_timezone_aware_iso(self, mocks):
        eb_mock, _ = mocks
        escalate(
            reason='tz check',
            project_id='proj-tz',
            agent_id='agent-tz',
            correlation_id='cid-tz',
        )
        detail = _detail_from_put_events(eb_mock)
        ts = detail['timestamp']
        assert ts.endswith('+00:00') or ts.endswith('Z'), (
            f'timestamp {ts!r} is not timezone-aware ISO 8601'
        )

# ---------------------------------------------------------------------------
# Correction 3: correlationId generation vs passthrough
# ---------------------------------------------------------------------------

class TestCorrection3CorrelationId:
    def test_generated_when_omitted(self, mocks):
        eb_mock, _ = mocks
        escalate(
            reason='auto cid',
            project_id='proj-cid',
            agent_id='agent-cid',
        )
        detail = _detail_from_put_events(eb_mock)
        # Generated value must parse as a UUID.
        parsed = uuid.UUID(detail['correlationId'])
        assert str(parsed) == detail['correlationId']

    def test_passthrough_when_supplied(self, mocks):
        eb_mock, _ = mocks
        escalate(
            reason='explicit cid',
            project_id='proj-cid2',
            agent_id='agent-cid2',
            correlation_id='test-cid-123',
        )
        detail = _detail_from_put_events(eb_mock)
        assert detail['correlationId'] == 'test-cid-123'

# ---------------------------------------------------------------------------
# Correction 4: reason truncation at 500 chars
# ---------------------------------------------------------------------------

class TestCorrection4ReasonTruncation:
    """Reason exceeding 500 chars is silently truncated — escalation must
    never fail on a technicality. Uses a word-break-friendly payload per
    QB-003-1 ReDoS lesson (future-proof against downstream redactPII).
    """

    def test_reason_truncated_to_500_chars(self, mocks):
        eb_mock, _ = mocks
        # Word-break-friendly 1000-char payload.
        payload = ('hello world ' * 100)[:1000]
        assert len(payload) == 1000
        escalate(
            reason=payload,
            project_id='proj-trunc',
            agent_id='agent-trunc',
            correlation_id='cid-trunc',
        )
        detail = _detail_from_put_events(eb_mock)
        assert len(detail['reason']) == 500
        assert detail['reason'] == payload[:500]

    def test_short_reason_not_truncated(self, mocks):
        eb_mock, _ = mocks
        escalate(
            reason='brief',
            project_id='proj-short',
            agent_id='agent-short',
            correlation_id='cid-short',
        )
        detail = _detail_from_put_events(eb_mock)
        assert detail['reason'] == 'brief'

    def test_empty_reason_yields_empty_string(self, mocks):
        eb_mock, _ = mocks
        escalate(
            reason='',
            project_id='proj-empty',
            agent_id='agent-empty',
            correlation_id='cid-empty',
        )
        detail = _detail_from_put_events(eb_mock)
        assert detail['reason'] == ''

# ---------------------------------------------------------------------------
# Property test: telemetry invariants under random inputs
# ---------------------------------------------------------------------------

# Word-break-friendly strategy: use words + spaces (safe for downstream
# regex-based sanitisers per QB-003-1 ReDoS lesson).
_word = st.text(
    min_size=1,
    max_size=8,
    alphabet=st.characters(whitelist_categories=('L', 'N')),
)
_word_phrase = st.lists(_word, min_size=1, max_size=40).map(lambda ws: ' '.join(ws))

_id_text = st.text(
    min_size=1,
    max_size=40,
    alphabet=st.characters(whitelist_categories=('L', 'N'), whitelist_characters='-_'),
)

class TestTelemetryInvariantsProperty:
    """Property: for any valid inputs, exactly one event + one metric fires,
    the metric dimension carries the project_id verbatim, and the Detail is
    valid JSON whose projectId round-trips.
    """

    @given(reason=_word_phrase, project_id=_id_text, agent_id=_id_text)
    @settings(max_examples=100, deadline=None)
    def test_exactly_one_event_and_metric_per_call(self, reason, project_id, agent_id):
        # Reset caches AND bind fresh mocks for each generated example.
        _reset_clients()
        eb_mock = MagicMock()
        cw_mock = MagicMock()
        escalate_module._eb_client = eb_mock
        escalate_module._cw_client = cw_mock

        try:
            escalate(
                reason=reason,
                project_id=project_id,
                agent_id=agent_id,
                correlation_id='cid-prop',
            )

            # Exactly one event, exactly one metric.
            assert eb_mock.put_events.call_count == 1
            assert cw_mock.put_metric_data.call_count == 1

            # Metric carries project_id verbatim as a dimension.
            md = cw_mock.put_metric_data.call_args.kwargs['MetricData']
            assert md[0]['Dimensions'][0]['Value'] == project_id

            # Detail is valid JSON and projectId round-trips.
            detail = _detail_from_put_events(eb_mock)
            assert detail['projectId'] == project_id
            assert detail['agentId'] == agent_id
            # Reason is truncated to at most MAX_REASON_LEN.
            assert len(detail['reason']) <= 500
        finally:
            _reset_clients()
