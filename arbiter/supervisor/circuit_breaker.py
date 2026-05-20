"""
Circuit breaker with exponential backoff and jitter for Bedrock API calls.

States:
  CLOSED   – requests flow normally; failures are counted.
  OPEN     – requests are rejected immediately for `recovery_timeout` seconds.
  HALF_OPEN – one probe request is allowed; success resets, failure re-opens.

Usage:
    breaker = CircuitBreaker()
    response = breaker.call(bedrock.converse, modelId=..., messages=...)
"""

import time
import random
import threading
from enum import Enum
from typing import Any, Callable


class CircuitState(Enum):
    CLOSED = "CLOSED"
    OPEN = "OPEN"
    HALF_OPEN = "HALF_OPEN"


class CircuitBreakerOpen(Exception):
    """Raised when the circuit breaker is open and rejecting calls."""
    pass


class CircuitBreaker:
    def __init__(
        self,
        failure_threshold: int = 3,
        recovery_timeout: float = 30.0,
        max_retries: int = 3,
        base_delay: float = 1.0,
        max_delay: float = 30.0,
        retryable_errors: tuple = (
            "ThrottlingException",
            "ServiceUnavailableException",
            "ModelTimeoutException",
            "InternalServerException",
        ),
    ):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.max_retries = max_retries
        self.base_delay = base_delay
        self.max_delay = max_delay
        self.retryable_errors = retryable_errors

        self._state = CircuitState.CLOSED
        self._failure_count = 0
        self._last_failure_time: float = 0
        self._lock = threading.Lock()

    @property
    def state(self) -> CircuitState:
        with self._lock:
            if self._state == CircuitState.OPEN:
                if time.time() - self._last_failure_time >= self.recovery_timeout:
                    self._state = CircuitState.HALF_OPEN
            return self._state

    def _record_success(self) -> None:
        with self._lock:
            self._failure_count = 0
            self._state = CircuitState.CLOSED

    def _record_failure(self) -> None:
        with self._lock:
            self._failure_count += 1
            self._last_failure_time = time.time()
            if self._failure_count >= self.failure_threshold:
                self._state = CircuitState.OPEN
                print(
                    f"Circuit breaker OPEN after {self._failure_count} failures. "
                    f"Will recover after {self.recovery_timeout}s."
                )

    def _is_retryable(self, error: Exception) -> bool:
        error_code = getattr(error, "response", {}).get("Error", {}).get("Code", "")
        error_name = type(error).__name__
        return error_code in self.retryable_errors or error_name in self.retryable_errors

    def _backoff_delay(self, attempt: int) -> float:
        """Exponential backoff with full jitter."""
        delay = min(self.base_delay * (2 ** attempt), self.max_delay)
        return random.uniform(0, delay)

    def call(self, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        """
        Invoke `fn` through the circuit breaker with retry + backoff.
        Raises CircuitBreakerOpen if the circuit is open.
        """
        current_state = self.state
        if current_state == CircuitState.OPEN:
            raise CircuitBreakerOpen(
                f"Circuit breaker is OPEN. Retry after {self.recovery_timeout}s."
            )

        last_error: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                result = fn(*args, **kwargs)
                self._record_success()
                return result
            except Exception as e:
                last_error = e
                if not self._is_retryable(e):
                    self._record_failure()
                    raise

                self._record_failure()

                if self.state == CircuitState.OPEN:
                    raise CircuitBreakerOpen(
                        f"Circuit breaker tripped to OPEN after retryable error: {e}"
                    ) from e

                if attempt < self.max_retries:
                    delay = self._backoff_delay(attempt)
                    print(
                        f"Retryable error (attempt {attempt + 1}/{self.max_retries + 1}): "
                        f"{e}. Retrying in {delay:.2f}s..."
                    )
                    time.sleep(delay)

        # All retries exhausted
        raise last_error  # type: ignore[misc]
