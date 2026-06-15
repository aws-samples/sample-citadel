"""Retry module — pure functions for exponential backoff and retry decisions.

Provides backoff calculation with full jitter and retry eligibility checks
for workflow node execution retry policies.
All functions are pure (no side effects, no AWS calls).
"""

import random


def calculate_backoff(attempt: int, base: float, max_delay: float) -> float:
    """Exponential backoff with full jitter: uniform(0, min(base * 2^attempt, max_delay)).

    Args:
        attempt: Zero-based attempt number (0 = first retry).
        base: Base delay in seconds (must be > 0).
        max_delay: Maximum delay cap in seconds (must be > 0).

    Returns:
        A random float in [0, min(base * 2^attempt, max_delay)].
    """
    ceiling = min(base * (2 ** attempt), max_delay)
    return random.uniform(0, ceiling)


def should_retry(error_type: str, retryable_errors: list[str], attempt: int, max_retries: int) -> bool:
    """Determine whether a failed node should be retried.

    Args:
        error_type: The error type string from the failed node.
        retryable_errors: List of error type strings eligible for retry.
        attempt: Current attempt number (zero-based).
        max_retries: Maximum number of retries allowed.

    Returns:
        True if the error is retryable and attempts are not exhausted.
    """
    if attempt >= max_retries:
        return False
    return error_type in retryable_errors
