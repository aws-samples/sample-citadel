"""
Tests for arbiter/fabricator/transient_retry.py — bounded retry with
exponential backoff + full jitter around Bedrock fabricator invocations.

Contract under test:
  - ``calculate_backoff`` / ``should_retry`` are the stepRunner pure-function
    copies (full jitter, bounded by cap, attempt-capped).
  - ``bedrock_error_code()`` extracts the Bedrock error code from ClientError
    (including EventStreamError, its mid-stream subclass); None otherwise.
  - ``is_transient_bedrock_error()`` is True ONLY for the four transient
    codes, any casing: internalServerException, ServiceUnavailableException,
    ThrottlingException, modelStreamErrorException.
  - ``call_with_transient_retry()`` retries ONLY transient faults, sleeps a
    jittered exponential backoff between attempts, gives up after
    MAX_ATTEMPTS total attempts, and re-raises the final error unchanged.
    Non-transient faults (ValidationException, AccessDeniedException,
    arbitrary exceptions) fail fast on the first attempt.
  - ``user_actionable_failure_message()`` keeps the Bedrock detail and adds
    re-queue guidance for transient faults; passes through str(e) otherwise.
"""

import sys
import os
from unittest.mock import MagicMock

import pytest
from botocore.exceptions import ClientError, EventStreamError
from hypothesis import given, settings
from hypothesis import strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from transient_retry import (
    MAX_ATTEMPTS,
    TRANSIENT_BEDROCK_ERROR_CODES,
    bedrock_error_code,
    calculate_backoff,
    call_with_transient_retry,
    is_transient_bedrock_error,
    should_retry,
    user_actionable_failure_message,
)


def _client_error(code: str, message: str = "boom", cls=ClientError):
    return cls({"Error": {"Code": code, "Message": message}}, "ConverseStream")


# ---------------------------------------------------------------------------
# bedrock_error_code
# ---------------------------------------------------------------------------

class TestBedrockErrorCode:
    def test_extracts_code_from_client_error(self):
        err = _client_error("internalServerException")
        assert bedrock_error_code(err) == "internalServerException"

    def test_extracts_code_from_mid_stream_event_stream_error(self):
        # Mid-stream faults surface as EventStreamError (ClientError subclass)
        # during stream iteration — the classifier must cover them too.
        err = _client_error("modelStreamErrorException", cls=EventStreamError)
        assert bedrock_error_code(err) == "modelStreamErrorException"

    def test_none_for_plain_exception(self):
        assert bedrock_error_code(RuntimeError("nope")) is None

    def test_none_for_malformed_response_attribute(self):
        exc = Exception("weird")
        exc.response = {"NotError": True}
        assert bedrock_error_code(exc) is None


# ---------------------------------------------------------------------------
# is_transient_bedrock_error
# ---------------------------------------------------------------------------

class TestIsTransientBedrockError:
    @pytest.mark.parametrize("code", [
        # request-level (CamelCase) and mid-stream (camelCase) variants
        "internalServerException", "InternalServerException",
        "serviceUnavailableException", "ServiceUnavailableException",
        "throttlingException", "ThrottlingException",
        "modelStreamErrorException", "ModelStreamErrorException",
    ])
    def test_transient_codes_any_casing(self, code):
        assert is_transient_bedrock_error(_client_error(code)) is True

    @pytest.mark.parametrize("code", [
        "ValidationException",
        "AccessDeniedException",
        "ResourceNotFoundException",
        "ModelNotReadyException",
        "ExpiredTokenException",
    ])
    def test_non_transient_codes_are_not_retryable(self, code):
        assert is_transient_bedrock_error(_client_error(code)) is False

    def test_plain_exception_is_not_transient(self):
        assert is_transient_bedrock_error(RuntimeError("x")) is False


# ---------------------------------------------------------------------------
# call_with_transient_retry
# ---------------------------------------------------------------------------

class TestCallWithTransientRetry:
    def test_two_transient_failures_then_success_returns_result(self):
        sleeps = []
        op = MagicMock(side_effect=[
            _client_error("internalServerException"),
            _client_error("internalServerException"),
            "ok",
        ])
        result = call_with_transient_retry(op, sleep=sleeps.append)
        assert result == "ok"
        assert op.call_count == 3
        assert len(sleeps) == 2

    def test_backoff_delays_are_bounded_exponentially(self):
        # full jitter: uniform(0, min(base * 2**attempt, cap)) with base=1s
        sleeps = []
        op = MagicMock(side_effect=[
            _client_error("ThrottlingException"),
            _client_error("ThrottlingException"),
            "ok",
        ])
        call_with_transient_retry(op, sleep=sleeps.append)
        assert 0 <= sleeps[0] <= 1.0
        assert 0 <= sleeps[1] <= 2.0

    def test_always_failing_transient_raises_after_exactly_max_attempts(self):
        sleeps = []
        final = _client_error("modelStreamErrorException")
        op = MagicMock(side_effect=final)
        with pytest.raises(ClientError) as exc_info:
            call_with_transient_retry(op, sleep=sleeps.append)
        # The ORIGINAL Bedrock error propagates unchanged after exhaustion.
        assert exc_info.value is final
        assert op.call_count == MAX_ATTEMPTS
        assert MAX_ATTEMPTS == 3
        assert len(sleeps) == MAX_ATTEMPTS - 1

    def test_validation_exception_fails_fast_no_retry_no_sleep(self):
        sleeps = []
        op = MagicMock(side_effect=_client_error("ValidationException"))
        with pytest.raises(ClientError):
            call_with_transient_retry(op, sleep=sleeps.append)
        assert op.call_count == 1
        assert sleeps == []

    def test_access_denied_fails_fast(self):
        op = MagicMock(side_effect=_client_error("AccessDeniedException"))
        with pytest.raises(ClientError):
            call_with_transient_retry(op, sleep=lambda _d: None)
        assert op.call_count == 1

    def test_plain_exception_fails_fast(self):
        op = MagicMock(side_effect=RuntimeError("not a bedrock fault"))
        with pytest.raises(RuntimeError):
            call_with_transient_retry(op, sleep=lambda _d: None)
        assert op.call_count == 1

    def test_success_on_first_try_never_sleeps(self):
        sleeps = []
        op = MagicMock(return_value="fine")
        assert call_with_transient_retry(op, sleep=sleeps.append) == "fine"
        assert op.call_count == 1
        assert sleeps == []

    def test_mid_stream_event_stream_error_is_retried(self):
        op = MagicMock(side_effect=[
            _client_error("internalServerException", cls=EventStreamError),
            "recovered",
        ])
        assert call_with_transient_retry(op, sleep=lambda _d: None) == "recovered"
        assert op.call_count == 2


# ---------------------------------------------------------------------------
# user_actionable_failure_message
# ---------------------------------------------------------------------------

class TestUserActionableFailureMessage:
    def test_transient_exhaustion_keeps_bedrock_detail_and_adds_guidance(self):
        err = _client_error(
            "internalServerException", message="An internal error occurred"
        )
        msg = user_actionable_failure_message(err)
        # Bedrock detail is kept verbatim …
        assert str(err) in msg
        # … and the operator learns it was temporary, how many retries ran,
        # and what to do next.
        assert "temporary" in msg.lower()
        assert str(MAX_ATTEMPTS) in msg
        assert "again" in msg.lower()

    def test_non_transient_passes_through_raw_message(self):
        err = _client_error("ValidationException", message="bad input")
        assert user_actionable_failure_message(err) == str(err)

    def test_plain_exception_passes_through_raw_message(self):
        err = RuntimeError("fabrication blew up")
        assert user_actionable_failure_message(err) == str(err)


# ---------------------------------------------------------------------------
# Property tests for the stepRunner pure-function copies
# ---------------------------------------------------------------------------

class TestBackoffProperties:
    @given(
        attempt=st.integers(min_value=0, max_value=10),
        base=st.floats(min_value=0.01, max_value=10),
        cap=st.floats(min_value=0.01, max_value=60),
    )
    @settings(max_examples=100)
    def test_backoff_always_within_zero_and_cap(self, attempt, base, cap):
        delay = calculate_backoff(attempt, base, cap)
        assert 0 <= delay <= min(base * (2 ** attempt), cap)

    @given(
        attempt=st.integers(min_value=0, max_value=20),
        max_retries=st.integers(min_value=0, max_value=5),
    )
    @settings(max_examples=100)
    def test_should_retry_never_beyond_max_retries(self, attempt, max_retries):
        if attempt >= max_retries:
            assert should_retry(
                "internalserverexception",
                ["internalserverexception"],
                attempt,
                max_retries,
            ) is False

    @given(code=st.text(min_size=1, max_size=40))
    @settings(max_examples=100)
    def test_should_retry_only_listed_codes(self, code):
        retryable = sorted(TRANSIENT_BEDROCK_ERROR_CODES)
        if code not in retryable:
            assert should_retry(code, retryable, 0, 3) is False
