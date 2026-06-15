"""
Property-based tests for stepRunner/retry.py.

Tests cover:
- Property 4: Backoff Bounds
- should_retry returns False when attempt >= max_retries
- should_retry returns False when error_type not in retryable_errors
- should_retry returns True when error_type in retryable_errors AND attempt < max_retries
- calculate_backoff result is always in [0, base * 2^attempt] when that's less than max_delay
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from hypothesis import given, settings, assume
from hypothesis import strategies as st

from retry import calculate_backoff, should_retry


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

# Attempt numbers (non-negative)
attempts = st.integers(min_value=0, max_value=20)

# Base delay values (positive)
base_values = st.floats(min_value=0.01, max_value=100.0, allow_nan=False, allow_infinity=False)

# Max delay values (positive)
max_delay_values = st.floats(min_value=0.01, max_value=300.0, allow_nan=False, allow_infinity=False)

# Max retries (positive)
max_retries_values = st.integers(min_value=1, max_value=20)

# Error type strings
error_types = st.text(min_size=1, max_size=30, alphabet=st.characters(whitelist_categories=('L', 'N', 'P')))

# Lists of retryable error strings
retryable_error_lists = st.lists(
    st.text(min_size=1, max_size=30, alphabet=st.characters(whitelist_categories=('L', 'N', 'P'))),
    min_size=1,
    max_size=5,
    unique=True,
)


# ---------------------------------------------------------------------------
# Property 4: Backoff Bounds (Task 9.2)
# ---------------------------------------------------------------------------

class TestBackoffBounds:
    """
    **Validates: Requirements 17.1, 17.2, 17.3**

    Property 4: For all attempt >= 0, base > 0, max_delay > 0:
    0 <= calculate_backoff(attempt, base, max_delay) <= max_delay
    """

    @given(attempt=attempts, base=base_values, max_delay=max_delay_values)
    @settings(max_examples=200)
    def test_backoff_within_zero_and_max_delay(self, attempt, base, max_delay):
        """calculate_backoff always returns a value in [0, max_delay]."""
        result = calculate_backoff(attempt, base, max_delay)
        assert 0 <= result <= max_delay, (
            f"Backoff {result} not in [0, {max_delay}] for attempt={attempt}, base={base}"
        )

    @given(attempt=attempts, base=base_values, max_delay=max_delay_values)
    @settings(max_examples=200)
    def test_backoff_within_exponential_ceiling(self, attempt, base, max_delay):
        """calculate_backoff result is always in [0, base * 2^attempt] when that's less than max_delay."""
        ceiling = base * (2 ** attempt)
        result = calculate_backoff(attempt, base, max_delay)
        effective_cap = min(ceiling, max_delay)
        assert 0 <= result <= effective_cap, (
            f"Backoff {result} not in [0, {effective_cap}] for attempt={attempt}, base={base}, max_delay={max_delay}"
        )

    @given(base=base_values, max_delay=max_delay_values)
    @settings(max_examples=100)
    def test_backoff_at_attempt_zero(self, base, max_delay):
        """At attempt 0, backoff is in [0, min(base, max_delay)]."""
        result = calculate_backoff(0, base, max_delay)
        ceiling = min(base, max_delay)
        assert 0 <= result <= ceiling, (
            f"Backoff {result} not in [0, {ceiling}] at attempt 0"
        )


# ---------------------------------------------------------------------------
# should_retry: False when attempt >= max_retries (Task 9.2)
# ---------------------------------------------------------------------------

class TestShouldRetryExhausted:
    """
    **Validates: Requirements 17.1, 17.2, 17.3**

    should_retry returns False when attempt >= max_retries.
    """

    @given(
        error_type=error_types,
        retryable_errors=retryable_error_lists,
        max_retries=max_retries_values,
    )
    @settings(max_examples=100)
    def test_false_when_attempts_exhausted(self, error_type, retryable_errors, max_retries):
        """should_retry returns False when attempt >= max_retries, regardless of error type."""
        # Ensure error_type is in retryable_errors so only the attempt check matters
        if error_type not in retryable_errors:
            retryable_errors = retryable_errors + [error_type]
        result = should_retry(error_type, retryable_errors, max_retries, max_retries)
        assert result is False, (
            f"should_retry returned True when attempt ({max_retries}) >= max_retries ({max_retries})"
        )

    @given(
        error_type=error_types,
        retryable_errors=retryable_error_lists,
        max_retries=max_retries_values,
        extra=st.integers(min_value=1, max_value=10),
    )
    @settings(max_examples=100)
    def test_false_when_attempts_exceed_max(self, error_type, retryable_errors, max_retries, extra):
        """should_retry returns False when attempt > max_retries."""
        if error_type not in retryable_errors:
            retryable_errors = retryable_errors + [error_type]
        result = should_retry(error_type, retryable_errors, max_retries + extra, max_retries)
        assert result is False


# ---------------------------------------------------------------------------
# should_retry: False when error_type not in retryable_errors (Task 9.2)
# ---------------------------------------------------------------------------

class TestShouldRetryNonRetryable:
    """
    **Validates: Requirements 17.1, 17.2, 17.3**

    should_retry returns False when error_type not in retryable_errors.
    """

    @given(
        error_type=error_types,
        retryable_errors=retryable_error_lists,
        attempt=st.integers(min_value=0, max_value=5),
        max_retries=st.integers(min_value=6, max_value=20),
    )
    @settings(max_examples=100)
    def test_false_when_error_not_retryable(self, error_type, retryable_errors, attempt, max_retries):
        """should_retry returns False when error_type is not in retryable_errors."""
        # Ensure error_type is NOT in retryable_errors
        assume(error_type not in retryable_errors)
        result = should_retry(error_type, retryable_errors, attempt, max_retries)
        assert result is False, (
            f"should_retry returned True for non-retryable error '{error_type}'"
        )


# ---------------------------------------------------------------------------
# should_retry: True when retryable AND attempts remaining (Task 9.2)
# ---------------------------------------------------------------------------

class TestShouldRetryTrue:
    """
    **Validates: Requirements 17.1, 17.2, 17.3**

    should_retry returns True when error_type in retryable_errors AND attempt < max_retries.
    """

    @given(
        retryable_errors=retryable_error_lists,
        max_retries=st.integers(min_value=1, max_value=20),
    )
    @settings(max_examples=100)
    def test_true_when_retryable_and_attempts_remaining(self, retryable_errors, max_retries):
        """should_retry returns True when error is retryable and attempts not exhausted."""
        error_type = retryable_errors[0]  # Pick a known retryable error
        attempt = max_retries - 1  # One attempt remaining
        result = should_retry(error_type, retryable_errors, attempt, max_retries)
        assert result is True, (
            f"should_retry returned False for retryable error '{error_type}' "
            f"with attempt {attempt} < max_retries {max_retries}"
        )

    @given(
        retryable_errors=retryable_error_lists,
        max_retries=st.integers(min_value=2, max_value=20),
        attempt=st.integers(min_value=0, max_value=1),
    )
    @settings(max_examples=100)
    def test_true_at_low_attempt_counts(self, retryable_errors, max_retries, attempt):
        """should_retry returns True at low attempt counts for retryable errors."""
        assume(attempt < max_retries)
        error_type = retryable_errors[0]
        result = should_retry(error_type, retryable_errors, attempt, max_retries)
        assert result is True
