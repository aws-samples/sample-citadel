"""
Tests for arbiter/fabricator/deadline.py — deadline-aware execution guard.

Live evidence (2026-07-23): the fabricator Lambda (Timeout 900s) was
SIGKILLed at exactly 900s mid tool-registration (REPORT Status: timeout).
A SIGKILL skips every except/finally, so the job's terminal DDB write never
happened; SQS redelivered into the same poison state ×3 → DLQ, rows stuck
PROCESSING.

Contract under test:
  - ``FabricationDeadline`` wraps a Lambda-context-style remaining-time
    clock (zero-arg callable returning milliseconds).
  - ``exceeded()`` is True when remaining <= safety margin.
  - ``can_fit(seconds)`` is True only when that much work still leaves the
    safety margin intact.
  - ``check(where)`` raises ``FabricationDeadlineExceeded`` and latches
    ``tripped``/``tripped_where``.
  - ``FabricationDeadlineExceeded`` derives from BaseException, NOT
    Exception — the Strands @tool executor converts any Exception raised in
    a tool into an error ToolResult fed back to the model (the LLM retry
    spiral), so the hard stop must skip ``except Exception`` handlers.
  - ``from_lambda_context`` degrades to an unlimited deadline for contexts
    without ``get_remaining_time_in_millis`` (tests / __main__ pass ``{}``).
  - A broken clock never fails a build (degrades to unlimited).
  - Module-level current-deadline registry: ``set_fabrication_deadline`` /
    ``get_fabrication_deadline`` / ``clear_fabrication_deadline`` and the
    ``registration_checkpoint`` helper used by the registration @tools.
  - ``timed_out_failure_message`` is terminal + user-actionable.
"""

import sys
import os

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from deadline import (
    SAFETY_MARGIN_SECONDS,
    FabricationDeadline,
    FabricationDeadlineExceeded,
    clear_fabrication_deadline,
    get_fabrication_deadline,
    registration_checkpoint,
    set_fabrication_deadline,
    timed_out_failure_message,
)


class _FakeLambdaContext:
    """Duck-typed Lambda context with a controllable remaining-time clock."""

    def __init__(self, remaining_ms):
        self._remaining_ms = remaining_ms

    def get_remaining_time_in_millis(self):
        return self._remaining_ms


@pytest.fixture(autouse=True)
def _clean_current_deadline():
    clear_fabrication_deadline()
    yield
    clear_fabrication_deadline()


# ---------------------------------------------------------------------------
# FabricationDeadlineExceeded — hard-stop semantics
# ---------------------------------------------------------------------------

class TestFabricationDeadlineExceededClass:
    def test_is_base_exception_not_exception(self):
        # Pin the hard-stop property: the Strands tool executor and
        # call_with_transient_retry both catch ``Exception``; the deadline
        # trip must fly past both to reach process_event.
        assert issubclass(FabricationDeadlineExceeded, BaseException)
        assert not issubclass(FabricationDeadlineExceeded, Exception)


# ---------------------------------------------------------------------------
# FabricationDeadline
# ---------------------------------------------------------------------------

class TestFabricationDeadline:
    def test_remaining_seconds_converts_millis(self):
        d = FabricationDeadline(lambda: 120_000)
        assert d.remaining_seconds() == pytest.approx(120.0)

    def test_exceeded_false_with_room(self):
        d = FabricationDeadline(lambda: 300_000, safety_margin_seconds=60)
        assert d.exceeded() is False

    def test_exceeded_true_inside_margin(self):
        d = FabricationDeadline(lambda: 59_000, safety_margin_seconds=60)
        assert d.exceeded() is True

    def test_exceeded_true_at_exact_margin_boundary(self):
        d = FabricationDeadline(lambda: 60_000, safety_margin_seconds=60)
        assert d.exceeded() is True

    def test_can_fit_true_when_margin_preserved(self):
        # 100s remaining, 60s margin: 39s of work leaves 61s > 60s.
        d = FabricationDeadline(lambda: 100_000, safety_margin_seconds=60)
        assert d.can_fit(39.0) is True

    def test_can_fit_false_when_margin_would_be_consumed(self):
        # 100s remaining, 60s margin: 40s of work leaves exactly 60s — not > margin.
        d = FabricationDeadline(lambda: 100_000, safety_margin_seconds=60)
        assert d.can_fit(40.0) is False

    def test_check_passes_with_room_and_does_not_trip(self):
        d = FabricationDeadline(lambda: 300_000, safety_margin_seconds=60)
        d.check("before tool registration 'x'")
        assert d.tripped is False

    def test_check_raises_and_trips_inside_margin(self):
        d = FabricationDeadline(lambda: 10_000, safety_margin_seconds=60)
        with pytest.raises(FabricationDeadlineExceeded):
            d.check("before tool registration 'x'")
        assert d.tripped is True
        assert d.tripped_where == "before tool registration 'x'"

    def test_default_margin_is_60_seconds(self):
        assert SAFETY_MARGIN_SECONDS == 60.0
        d = FabricationDeadline(lambda: 900_000)
        assert d.safety_margin_seconds == 60.0

    def test_unlimited_when_no_clock(self):
        d = FabricationDeadline(None)
        assert d.exceeded() is False
        assert d.can_fit(10_000_000.0) is True
        d.check("anywhere")  # never raises
        assert d.tripped is False

    def test_broken_clock_degrades_to_unlimited(self):
        # A broken remaining-time clock must never fail a build.
        def broken():
            raise RuntimeError("no clock")

        d = FabricationDeadline(broken)
        assert d.exceeded() is False
        d.check("anywhere")
        assert d.tripped is False

    def test_negative_clock_clamps_to_zero_and_exceeds(self):
        d = FabricationDeadline(lambda: -5_000, safety_margin_seconds=60)
        assert d.remaining_seconds() == 0.0
        assert d.exceeded() is True


class TestFromLambdaContext:
    def test_uses_context_remaining_time(self):
        d = FabricationDeadline.from_lambda_context(_FakeLambdaContext(45_000))
        assert d.remaining_seconds() == pytest.approx(45.0)
        assert d.exceeded() is True

    def test_dict_context_degrades_to_unlimited(self):
        # __main__ and several tests pass a plain {} as the Lambda context.
        d = FabricationDeadline.from_lambda_context({})
        assert d.exceeded() is False

    def test_none_context_degrades_to_unlimited(self):
        d = FabricationDeadline.from_lambda_context(None)
        assert d.exceeded() is False


# ---------------------------------------------------------------------------
# Module-level current deadline + registration_checkpoint
# ---------------------------------------------------------------------------

class TestCurrentDeadlineRegistry:
    def test_set_get_clear_roundtrip(self):
        d = FabricationDeadline(lambda: 900_000)
        set_fabrication_deadline(d)
        assert get_fabrication_deadline() is d
        clear_fabrication_deadline()
        assert get_fabrication_deadline() is None

    def test_checkpoint_noop_when_no_deadline_set(self):
        registration_checkpoint("before tool registration 'x'")  # must not raise

    def test_checkpoint_raises_when_current_deadline_inside_margin(self):
        d = FabricationDeadline(lambda: 5_000, safety_margin_seconds=60)
        set_fabrication_deadline(d)
        with pytest.raises(FabricationDeadlineExceeded):
            registration_checkpoint("before tool registration 'x'")
        assert d.tripped is True

    def test_checkpoint_passes_when_current_deadline_has_room(self):
        set_fabrication_deadline(FabricationDeadline(lambda: 900_000))
        registration_checkpoint("after tool registration 'x'")  # must not raise


# ---------------------------------------------------------------------------
# timed_out_failure_message
# ---------------------------------------------------------------------------

class TestTimedOutFailureMessage:
    def test_names_agent_and_says_timed_out_with_requeue_action(self):
        msg = timed_out_failure_message("VarianceTriageAgent")
        assert "VarianceTriageAgent" in msg
        assert "timed out" in msg
        assert "Re-queue" in msg

    def test_includes_tripped_where_when_available(self):
        d = FabricationDeadline(lambda: 1_000, safety_margin_seconds=60)
        with pytest.raises(FabricationDeadlineExceeded):
            d.check("before tool registration 'threshold_rules_engine'")
        msg = timed_out_failure_message("MyAgent", d)
        assert "threshold_rules_engine" in msg
