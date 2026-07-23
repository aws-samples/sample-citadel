"""Bounded transient-fault retry for fabricator Bedrock invocations.

Why this exists: Bedrock ConverseStream can fail MID-STREAM — after the
HTTP 200, error events (internalServerException, modelStreamErrorException,
serviceUnavailableException, throttlingException) arrive inside the event
stream and surface as botocore ``EventStreamError`` during iteration —
OUTSIDE the scope of botocore's ``Config(retries=...)``. The Strands SDK
retries only throttling; every other fault previously propagated on the
first occurrence and the fabrication job was marked FAILED immediately.

This module provides a bounded application-level retry (``MAX_ATTEMPTS``
total attempts, exponential backoff with full jitter) around the whole
fabricator invocation — which consumes the full stream, so mid-stream faults
are covered — retrying ONLY transient Bedrock faults. Non-transient faults
(ValidationException, AccessDeniedException, arbitrary exceptions) fail fast
unchanged. Strands' own ``ModelThrottledException`` (raised only after the
SDK's 6-attempt throttling retry exhausts) carries no ``.response`` and is
deliberately NOT re-retried here.

``calculate_backoff`` and ``should_retry`` are copied verbatim from
``arbiter/stepRunner/retry.py`` — each arbiter module bundles as a separate
Lambda, so a cross-module import would couple packaging.
"""

import logging
import random
import time

logger = logging.getLogger(__name__)

# Total attempts (1 initial + up to 2 retries).
MAX_ATTEMPTS = 3
# Full-jitter exponential backoff ceilings between attempts: ~1s, ~2s.
BASE_DELAY_SECONDS = 1.0
MAX_DELAY_SECONDS = 8.0

# Transient Bedrock fault codes, lowercased. Comparison is case-insensitive
# because Bedrock reports request-level faults in CamelCase
# (ThrottlingException) and mid-stream event faults in camelCase
# (throttlingException, modelStreamErrorException).
TRANSIENT_BEDROCK_ERROR_CODES = frozenset({
    "internalserverexception",
    "serviceunavailableexception",
    "throttlingexception",
    "modelstreamerrorexception",
})


# --- copied verbatim from arbiter/stepRunner/retry.py (pure functions) ------

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
    """Determine whether a failed operation should be retried.

    Args:
        error_type: The error type string from the failed operation.
        retryable_errors: List of error type strings eligible for retry.
        attempt: Current attempt number (zero-based).
        max_retries: Maximum number of retries allowed.

    Returns:
        True if the error is retryable and attempts are not exhausted.
    """
    if attempt >= max_retries:
        return False
    return error_type in retryable_errors

# --- end of stepRunner copies ------------------------------------------------


def bedrock_error_code(exc: BaseException) -> str | None:
    """Extract the Bedrock error code from a raised exception, if any.

    Covers ``botocore.exceptions.ClientError`` AND its mid-stream subclass
    ``EventStreamError`` — both carry ``.response['Error']['Code']``.
    Returns None for anything else (no isinstance check so test doubles and
    duck-typed errors classify identically).
    """
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        error = response.get("Error")
        if isinstance(error, dict):
            code = error.get("Code")
            if code:
                return str(code)
    return None


def is_transient_bedrock_error(exc: BaseException) -> bool:
    """True only for the four transient Bedrock fault codes (any casing)."""
    code = bedrock_error_code(exc)
    return code is not None and code.lower() in TRANSIENT_BEDROCK_ERROR_CODES


def call_with_transient_retry(
    operation,
    *,
    max_attempts: int = MAX_ATTEMPTS,
    base_delay: float = BASE_DELAY_SECONDS,
    max_delay: float = MAX_DELAY_SECONDS,
    sleep=None,
    deadline=None,
):
    """Invoke ``operation()``, retrying ONLY transient Bedrock faults.

    Sleeps a full-jitter exponential backoff between attempts. After
    ``max_attempts`` total attempts the final error is re-raised unchanged,
    so callers' except blocks see the original Bedrock message. Non-transient
    errors propagate immediately (fail fast).

    Deadline rule (kill→poison→kill fix, live evidence 2026-07-23): never
    START an attempt or a backoff that cannot fit before
    (deadline - safety_margin) — the terminal status write must win over
    more retry work. Starting inside the margin raises
    FabricationDeadlineExceeded (via ``deadline.check``); a backoff that
    would eat into the margin declines the retry and re-raises the ORIGINAL
    transient error instead.

    Args:
        operation: Zero-arg callable to invoke (e.g. ``lambda: agent(task)``).
        max_attempts: Total attempts including the first (default 3).
        base_delay: Backoff base in seconds (default 1.0 → ~1s/~2s ceilings).
        max_delay: Backoff cap in seconds.
        sleep: Injectable sleep function for tests; defaults to time.sleep.
        deadline: Optional FabricationDeadline; None keeps legacy behavior.
    """
    sleep_fn = time.sleep if sleep is None else sleep
    for attempt in range(max_attempts):
        if deadline is not None:
            # Raises FabricationDeadlineExceeded (a BaseException — it must
            # bypass the ``except Exception`` below) when already inside the
            # safety margin, so process_event writes the terminal 'timed
            # out' FAILED status instead of the Lambda burning its last
            # seconds on an attempt that cannot finish.
            deadline.check(
                f"transient-retry attempt {attempt + 1}/{max_attempts}"
            )
        try:
            return operation()
        except Exception as exc:  # noqa: BLE001 — classified below; re-raised unless transient
            code = (bedrock_error_code(exc) or "").lower()
            if not should_retry(code, TRANSIENT_BEDROCK_ERROR_CODES, attempt, max_attempts - 1):
                raise
            delay = calculate_backoff(attempt, base_delay, max_delay)
            if deadline is not None and not deadline.can_fit(delay):
                logger.warning(
                    "Declining transient retry (attempt %d/%d): %.2fs backoff "
                    "cannot fit before the deadline safety margin "
                    "(%.1fs remaining); re-raising the original error",
                    attempt + 1, max_attempts, delay,
                    deadline.remaining_seconds(),
                )
                raise
            logger.warning(
                "Transient Bedrock fault (%s) on attempt %d/%d; retrying in %.2fs",
                code, attempt + 1, max_attempts, delay,
            )
            sleep_fn(delay)
    raise RuntimeError("unreachable: retry loop must return or raise")


def user_actionable_failure_message(
    exc: BaseException, attempts: int = MAX_ATTEMPTS
) -> str:
    """Build the fabrication-jobs errorMessage for a terminal failure.

    Transient exhaustion → user-actionable guidance that KEEPS the Bedrock
    detail verbatim; every other error → its raw message unchanged.
    (The status writer truncates to 1000 chars downstream.)
    """
    if is_transient_bedrock_error(exc):
        return (
            "Bedrock had a temporary service problem while building this "
            f"agent; retried {attempts} times without success. Re-queue the "
            f"agent to try again. Detail: {exc}"
        )
    return str(exc)
