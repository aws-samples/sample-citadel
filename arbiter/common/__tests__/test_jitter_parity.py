"""Jitter parity + throttle-backs-off-with-jitter (board task 9099b8cb).

Decision 5ac980e0: the three verbatim full-jitter copies are NOT deduplicated
in this story (the taxonomy adds no backoff math). This test PINS that the
copies stay numerically equivalent — if one drifts, this bites. The three
copies live in separately-bundled Lambdas:

  * stepRunner/retry.py::calculate_backoff              (the canonical home)
  * fabricator/transient_retry.py::calculate_backoff    (verbatim copy)
  * supervisor/circuit_breaker.py::CircuitBreaker._backoff_delay (copy)

Also asserts a throttle is auto-retryable per the taxonomy and the circuit
breaker still retries it after dropping its private error-code tuple.
"""
import random

# conftest.py seeds stepRunner/, fabricator/, supervisor/ onto sys.path.
import retry as step_retry  # stepRunner/retry.py
import transient_retry  # fabricator/transient_retry.py
from circuit_breaker import CircuitBreaker  # supervisor/circuit_breaker.py
from common import failure_taxonomy as ft


class TestJitterParity:
    def test_three_copies_are_numerically_equivalent(self):
        # Seed identically before each call: random.uniform(0, ceiling) with an
        # identical ceiling formula must produce identical draws.
        cb = CircuitBreaker(base_delay=1.0, max_delay=30.0)
        for attempt in range(0, 8):
            base, cap = 1.0, 30.0

            random.seed(1234)
            a = step_retry.calculate_backoff(attempt, base, cap)
            random.seed(1234)
            b = transient_retry.calculate_backoff(attempt, base, cap)
            random.seed(1234)
            c = cb._backoff_delay(attempt)

            assert a == b == c, f"jitter copies diverged at attempt={attempt}"

    def test_copies_share_the_same_ceiling(self):
        # Different base/cap still agree across the copies.
        cb = CircuitBreaker(base_delay=2.5, max_delay=12.0)
        for attempt in range(0, 6):
            random.seed(99)
            a = step_retry.calculate_backoff(attempt, 2.5, 12.0)
            random.seed(99)
            c = cb._backoff_delay(attempt)
            assert a == c


class TestThrottleBacksOffWithJitter:
    def test_throttle_is_auto_retryable(self):
        assert ft.classify("ThrottlingException") is ft.FailureClass.THROTTLE
        assert ft.is_auto_retryable(ft.classify("ThrottlingException")) is True

    def test_backoff_within_full_jitter_bounds(self):
        for attempt in range(0, 10):
            delay = step_retry.calculate_backoff(attempt, 1.0, 30.0)
            assert 0.0 <= delay <= min(1.0 * (2 ** attempt), 30.0)

    def test_circuit_breaker_still_retries_throttling_after_taxonomy_adoption(self):
        cb = CircuitBreaker(max_retries=3, base_delay=0.0, max_delay=0.0)
        calls = []

        def flaky():
            calls.append(1)
            if len(calls) < 2:
                err = Exception("throttled")
                err.response = {"Error": {"Code": "ThrottlingException"}}
                raise err
            return "ok"

        assert cb.call(flaky) == "ok"
        assert len(calls) == 2  # retried once after the throttle
