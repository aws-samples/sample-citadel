"""Unit tests for arbiter/common/failure_taxonomy.py — the unified failure
taxonomy (board task 9099b8cb).

Covers the invariants the story asserts:
  * every error type from the inventory maps to the decided FailureClass;
  * the three-valued disposition (84494854): APPROVAL_ABSENT -> RETRY_AFTER_HUMAN,
    INDETERMINATE -> NEVER;
  * APPROVAL_ABSENT vs DENY differential (absent approval is NOT a DENY and NOT
    a governance smell);
  * classify(exception) == classify(class-name string) parity;
  * an unknown class defaults to never-auto-retry (fail-safe);
  * the narrow-only veto (843a959e): a recognised never-retry class is forbidden,
    an unknown class is NOT (defers to the per-node list).
"""

from common import failure_taxonomy as ft
from common.failure_taxonomy import FailureClass as FC, RetryDisposition as RD


# ---------------------------------------------------------------------------
# Disposition matrix (84494854): three-valued, INDETERMINATE -> NEVER
# ---------------------------------------------------------------------------


class TestDispositionMatrix:
    def test_auto_retry_classes(self):
        for fc in (FC.TRANSIENT, FC.THROTTLE, FC.TIMEOUT):
            assert ft.disposition(fc) is RD.RETRY_WITH_BACKOFF
            assert ft.is_auto_retryable(fc) is True

    def test_never_classes(self):
        for fc in (FC.VALIDATION, FC.POLICY_DENIED, FC.AUTHZ, FC.INDETERMINATE, FC.UNKNOWN):
            assert ft.disposition(fc) is RD.NEVER
            assert ft.is_auto_retryable(fc) is False

    def test_approval_absent_is_retry_after_human(self):
        assert ft.disposition(FC.APPROVAL_ABSENT) is RD.RETRY_AFTER_HUMAN
        # NOT auto-retryable (no storm) and NOT a governance smell.
        assert ft.is_auto_retryable(FC.APPROVAL_ABSENT) is False
        assert ft.is_governance_smell_on_retry(FC.APPROVAL_ABSENT) is False

    def test_indeterminate_maps_to_never_failsafe(self):
        assert ft.disposition(FC.INDETERMINATE) is RD.NEVER


class TestCircuitOpenClass:
    """The NEW CIRCUIT_OPEN class (task 28d624b1, D1): disposition NEVER,
    reusing the existing NEVER disposition (no parallel disposition invented)."""

    def test_circuit_open_is_never_and_not_auto_retryable(self):
        assert ft.disposition(FC.CIRCUIT_OPEN) is RD.NEVER
        assert ft.is_auto_retryable(FC.CIRCUIT_OPEN) is False

    def test_circuit_open_is_forbidden_by_taxonomy_cannot_be_widened(self):
        # A stale per-node retryableErrors list can NEVER widen an OPEN breaker
        # into an in-line retry against a known-bad target (narrow-only veto).
        assert ft.is_retry_forbidden_by_taxonomy("CircuitBreakerOpen") is True
        assert ft.is_retry_forbidden_by_taxonomy("ToolTargetCircuitOpen") is True
        assert ft.is_retry_forbidden_by_taxonomy("CircuitOpenError") is True

    def test_circuit_open_is_not_a_governance_smell(self):
        # OPEN is a target-health signal, not a settled denial.
        assert ft.is_governance_smell_on_retry(FC.CIRCUIT_OPEN) is False

    def test_circuit_open_classnames_and_value_string(self):
        assert ft.classify("CircuitBreakerOpen") is FC.CIRCUIT_OPEN
        assert ft.classify("CircuitOpenError") is FC.CIRCUIT_OPEN
        assert ft.classify("ToolTargetCircuitOpen") is FC.CIRCUIT_OPEN
        # value string round-trips via the lower index.
        assert ft.classify("circuit-open") is FC.CIRCUIT_OPEN

    def test_circuit_open_exception_matches_string_parity(self):
        class CircuitBreakerOpen(Exception):
            pass

        assert ft.classify(CircuitBreakerOpen("x")) == ft.classify("CircuitBreakerOpen")
        assert ft.classify(CircuitBreakerOpen("x")) is FC.CIRCUIT_OPEN


# ---------------------------------------------------------------------------
# Every inventory error type maps as decided
# ---------------------------------------------------------------------------


class TestInventoryMapping:
    def test_bedrock_codes(self):
        assert ft.classify("ThrottlingException") is FC.THROTTLE
        assert ft.classify("ServiceUnavailableException") is FC.TRANSIENT
        assert ft.classify("InternalServerException") is FC.TRANSIENT
        assert ft.classify("ModelStreamErrorException") is FC.TRANSIENT
        assert ft.classify("ModelTimeoutException") is FC.TIMEOUT
        assert ft.classify("ValidationException") is FC.VALIDATION
        assert ft.classify("AccessDeniedException") is FC.AUTHZ

    def test_governance_ledger_hierarchy(self):
        assert ft.classify("LedgerError") is FC.TRANSIENT
        assert ft.classify("LedgerWriteError") is FC.TRANSIENT
        assert ft.classify("ApprovalReadError") is FC.TRANSIENT
        assert ft.classify("RetryableNoExecutionError") is FC.TRANSIENT
        assert ft.classify("OutcomeIndeterminateError") is FC.INDETERMINATE
        assert ft.classify("StaleWorkerFencedError") is FC.INDETERMINATE
        assert ft.classify("CrossOrgResultRefError") is FC.AUTHZ

    def test_approval_required_is_absent_not_deny(self):
        # APPROVAL_ABSENT, explicitly NOT policy-denied.
        assert ft.classify("ApprovalRequiredError") is FC.APPROVAL_ABSENT
        assert ft.classify("ApprovalRequiredError") is not FC.POLICY_DENIED

    def test_governance_deny(self):
        assert ft.classify(ft.POLICY_DENIED_CLASS) is FC.POLICY_DENIED
        assert ft.classify("policy-denied") is FC.POLICY_DENIED

    def test_tool_crash_and_domain_error_defer_to_policy(self):
        # A bare crash / tool-returned domain error is UNKNOWN so the per-node
        # policy governs (documented deliberate absence).
        assert ft.classify("ToolExecutionError") is FC.UNKNOWN
        assert ft.classify("AgentExecutionError") is FC.UNKNOWN
        assert ft.classify("tool_error_result") is FC.UNKNOWN


# ---------------------------------------------------------------------------
# classify(exception) == classify(string) parity + case-insensitivity
# ---------------------------------------------------------------------------


class TestClassifyParity:
    def test_exception_type_name_matches_string(self):
        class ApprovalRequiredError(Exception):
            pass

        assert ft.classify(ApprovalRequiredError("x")) == ft.classify("ApprovalRequiredError")
        assert ft.classify(ApprovalRequiredError("x")) is FC.APPROVAL_ABSENT

    def test_botocore_response_code_matches_string(self):
        class ClientError(Exception):
            def __init__(self, code):
                super().__init__(code)
                self.response = {"Error": {"Code": code}}

        exc = ClientError("ThrottlingException")
        assert ft.classify(exc) == ft.classify("ThrottlingException")
        assert ft.classify(exc) is FC.THROTTLE

    def test_case_insensitive_midstream_codes(self):
        # Bedrock reports mid-stream faults in camelCase.
        assert ft.classify("throttlingException") is FC.THROTTLE
        assert ft.classify("modelStreamErrorException") is FC.TRANSIENT
        assert ft.classify("internalServerException") is FC.TRANSIENT


# ---------------------------------------------------------------------------
# Unknown -> never-auto-retry (fail-safe)
# ---------------------------------------------------------------------------


class TestUnknownFailsafe:
    def test_unknown_string_is_unknown_and_not_auto_retryable(self):
        assert ft.classify("SomeNovelError") is FC.UNKNOWN
        assert ft.is_auto_retryable(ft.classify("SomeNovelError")) is False

    def test_none_and_empty_classify_unknown(self):
        assert ft.classify(None) is FC.UNKNOWN
        assert ft.classify("") is FC.UNKNOWN


# ---------------------------------------------------------------------------
# Narrow-only veto (843a959e)
# ---------------------------------------------------------------------------


class TestNarrowOnlyVeto:
    def test_recognised_never_classes_are_forbidden(self):
        for token in (
            "AccessDeniedException",      # authz
            "ValidationException",        # validation
            ft.POLICY_DENIED_CLASS,       # policy-denied
            "OutcomeIndeterminateError",  # indeterminate
            "ApprovalRequiredError",      # approval-absent (retry-after-human, not auto)
            "CrossOrgResultRefError",     # authz
        ):
            assert ft.is_retry_forbidden_by_taxonomy(token) is True, token

    def test_auto_retryable_classes_are_not_forbidden(self):
        for token in ("ThrottlingException", "InternalServerException", "ModelTimeoutException"):
            assert ft.is_retry_forbidden_by_taxonomy(token) is False, token

    def test_unknown_is_not_forbidden_defers_to_author_list(self):
        # The load-bearing distinction: an unrecognised error is NOT vetoed, so
        # the per-node retryableErrors list still governs it (narrow-only).
        assert ft.is_retry_forbidden_by_taxonomy("TimeoutError") is False
        assert ft.is_retry_forbidden_by_taxonomy("SomeNovelError") is False


# ---------------------------------------------------------------------------
# Governance-smell-on-retry only for settled denials
# ---------------------------------------------------------------------------


class TestGovernanceSmell:
    def test_only_policy_denied_and_authz_are_smells(self):
        assert ft.is_governance_smell_on_retry(FC.POLICY_DENIED) is True
        assert ft.is_governance_smell_on_retry(FC.AUTHZ) is True
        for fc in (FC.VALIDATION, FC.INDETERMINATE, FC.APPROVAL_ABSENT,
                   FC.TRANSIENT, FC.THROTTLE, FC.TIMEOUT, FC.UNKNOWN):
            assert ft.is_governance_smell_on_retry(fc) is False, fc
