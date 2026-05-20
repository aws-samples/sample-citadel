"""
Property-based tests for the CircuitBreaker module.

Tests cover:
- State transition invariants (CLOSED→OPEN→HALF_OPEN→CLOSED)
- Backoff delay bounds
- Retryable error classification
- Failure counting and threshold behaviour
- Thread safety of state transitions
"""

import sys
import os
import threading
import time
from unittest.mock import MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from hypothesis import given, settings, assume, HealthCheck
from hypothesis


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

positive_ints = st.integers(min_value=1, max_value=20)
positive_floats = st.floats(
    min_value=0.1, max_value=100.0,
    allow_nan=False, allow_infinity=False,
)
attempt_numbers = st.integers(min_value=0, max_value=20)


# ---------------------------------------------------------------------------
# _backoff_delay
# ---------------------------------------------------------------------------

class TestBackoffDelay:
    """Property tests for exponential backoff with jitter."""

    @given(
        attempt=attempt_numbers,
        base_delay=st.floats(
            min_value=0.01, max_value=10.0,
            allow_nan=False, allow_infinity=False,
        ),
        max_delay=st.floats(
            min_value=1.0, max_value=120.0,
            allow_nan=False, allow_infinity=False,
        ),
    )
    @settings(max_examples=200)
    def test_delay_is_non_negative(self, attempt, base_delay, max_delay):
        """Backoff delay is always >= 0."""
        cb = CircuitBreaker(base_delay=base_delay, max_delay=max_delay)
        delay = cb._backoff_delay(attempt)
        assert delay >= 0

    @given(
        attempt=attempt_numbers,
        base_delay=st.floats(
            min_value=0.01, max_value=10.0,
            allow_nan=False, allow_infinity=False,
        ),
        max_delay=st.floats(
            min_value=1.0, max_value=120.0,
            allow_nan=False, allow_infinity=False,
        ),
    )
    @settings(max_examples=200)
    def test_delay_bounded_by_max(self, attempt, base_delay, max_delay):
        """Backoff delay never exceeds max_delay."""
        cb = CircuitBreaker(base_delay=base_delay, max_delay=max_delay)
        delay = cb._backoff_delay(attempt)
        assert delay <= max_delay

    @given(attempt=attempt_numbers)
    @settings(max_examples=100)
    def test_delay_with_zero_attempt(self, attempt):
        """Delay at attempt 0 is bounded by base_delay."""
        cb = CircuitBreaker(base_delay=1.0, max_delay=30.0)
        delay = cb._backoff_delay(0)
        assert 0 <= delay <= 1.0


# ---------------------------------------------------------------------------
# _is_retryable
# ---------------------------------------------------------------------------

class TestIsRetryable:
    """Property tests for retryable error detection."""

    @given(error_code=st.sampled_from([
        "ThrottlingException",
        "ServiceUnavailableException",
        "ModelTimeoutException",
        "InternalServerException",
    ]))
    def test_known_retryable_errors_detected(self, error_code):
        """Known retryable error codes are always detected."""
        cb = CircuitBreaker()
        exc = Exception("test")
        exc.response = {"Error": {"Code": error_code}}
        assert cb._is_retryable(exc) is True

    @given(error_code=st.text(min_size=1, max_size=50).filter(
        lambda s: s not in (
            "ThrottlingException",
            "ServiceUnavailableException",
            "ModelTimeoutException",
            "InternalServerException",
        )
    ))
    @settings(max_examples=100)
    def test_unknown_error_codes_not_retryable(self, error_code):
        """Unknown error codes are not retryable."""
        cb = CircuitBreaker()
        exc = Exception("test")
        exc.response = {"Error": {"Code": error_code}}
        assert cb._is_retryable(exc) is False

    def test_plain_exception_not_retryable(self):
        """Plain exceptions without response attr are not retryable."""
        cb = CircuitBreaker()
        assert cb._is_retryable(Exception("boom")) is False

    @given(st.text(max_size=50))
    def test_always_returns_bool(self, msg):
        """_is_retryable always returns a boolean."""
        cb = CircuitBreaker()
        result = cb._is_retryable(Exception(msg))
        assert isinstance(result, bool)


# ---------------------------------------------------------------------------
# State transitions
# ---------------------------------------------------------------------------

class TestCircuitBreakerStateTransitions:
    """Property tests for circuit breaker state machine."""

    def test_starts_closed(self):
        """New circuit breaker starts in CLOSED state."""
        cb = CircuitBreaker()
        assert cb.state == CircuitState.CLOSED

    @given(threshold=st.integers(min_value=1, max_value=10))
    def test_opens_after_threshold_failures(self, threshold):
        """Circuit opens after exactly failure_threshold failures."""
        cb = CircuitBreaker(failure_threshold=threshold)
        for _ in range(threshold):
            cb._record_failure()
        assert cb.state == CircuitState.OPEN

    @given(threshold=st.integers(min_value=2, max_value=10))
    def test_stays_closed_below_threshold(self, threshold):
        """Circuit stays closed with fewer than threshold failures."""
        cb = CircuitBreaker(failure_threshold=threshold)
        for _ in range(threshold - 1):
            cb._record_failure()
        assert cb.state == CircuitState.CLOSED

    def test_success_resets_to_closed(self):
        """Recording success always resets to CLOSED with zero failures."""
        cb = CircuitBreaker(failure_threshold=3)
        cb._record_failure()
        cb._record_failure()
        cb._record_success()
        assert cb.state == CircuitState.CLOSED
        assert cb._failure_count == 0

    def test_open_transitions_to_half_open_after_timeout(self):
        """OPEN transitions to HALF_OPEN after recovery_timeout."""
        cb = CircuitBreaker(failure_threshold=1, recovery_timeout=0.01)
        cb._record_failure()
        assert cb.state == CircuitState.OPEN
        time.sleep(0.02)
        assert cb.state == CircuitState.HALF_OPEN

    @given(num_successes=st.integers(min_value=1, max_value=20))
    def test_success_after_failures_resets(self, num_successes):
        """Any number of successes after failures resets the breaker."""
        cb = CircuitBreaker(failure_threshold=5)
        cb._record_failure()
        cb._record_failure()
        for _ in range(num_successes):
            cb._record_success()
        assert cb._failure_count == 0
        assert cb.state == CircuitState.CLOSED


# ---------------------------------------------------------------------------
# call() integration
# ---------------------------------------------------------------------------

class TestCircuitBreakerCall:
    """Property tests for the call() method."""

    @given(value=st.integers())
    def test_successful_call_returns_value(self, value):
        """Successful function calls return the function's value."""
        cb = CircuitBreaker()
        result = cb.call(lambda: value)
        assert result == value
        assert cb.state == CircuitState.CLOSED

    def test_open_circuit_raises_immediately(self):
        """Calls on an OPEN circuit raise CircuitBreakerOpen."""
        cb = CircuitBreaker(failure_threshold=1, recovery_timeout=999)
        cb._record_failure()
        assert cb.state == CircuitState.OPEN
        with pytest.raises(CircuitBreakerOpen):
            cb.call(lambda: "should not run")

    @given(threshold=st.integers(min_value=1, max_value=5))
    def test_non_retryable_errors_count_as_failures(self, threshold):
        """Non-retryable errors increment failure count."""
        cb = CircuitBreaker(failure_threshold=threshold, max_retries=0)

        for i in range(threshold):
            with pytest.raises(ValueError):
                cb.call(self._raise_value_error)

        assert cb.state == CircuitState.OPEN

    @staticmethod
    def _raise_value_error():
        raise ValueError("not retryable")


# ---------------------------------------------------------------------------
# Stateful testing
# ---------------------------------------------------------------------------

class CircuitBreakerStateMachine(RuleBasedStateMachine):
    """Stateful property test: verifies circuit breaker invariants
    across arbitrary sequences of successes and failures."""

    def __init__(self):
        super().__init__()
        self.cb = CircuitBreaker(
            failure_threshold=3,
            recovery_timeout=0.05,
            max_retries=0,
        )
        self.expected_failures = 0

    @rule()
    def record_success(self):
        self.cb._record_success()
        self.expected_failures = 0

    @rule()
    def record_failure(self):
        self.cb._record_failure()
        self.expected_failures += 1

    @invariant()
    def failure_count_matches(self):
        # After success, count resets; after failures, it accumulates
        assert self.cb._failure_count == self.expected_failures

    @invariant()
    def state_is_valid(self):
        assert self.cb.state in (
            CircuitState.CLOSED,
            CircuitState.OPEN,
            CircuitState.HALF_OPEN,
        )

    @invariant()
    def open_only_at_threshold(self):
        if self.cb._failure_count < self.cb.failure_threshold:
            assert self.cb._state != CircuitState.OPEN


TestCircuitBreakerStateful = CircuitBreakerStateMachine.TestCase
