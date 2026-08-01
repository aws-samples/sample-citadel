"""Bounded recovery for AgentCore Registry records stuck in CREATING state.

Why this exists (live evidence, 2026-07-23): a 900s Lambda SIGKILL mid
tool-registration orphaned Registry tool records in CREATING state. Every
subsequent ``UpdateRegistryRecordStatus`` for those tools raised
ConflictException 'Registry record cannot be modified while in CREATING
state', the fabricator LLM classified it as transient and retried the
registration tool 92-110× per run (~825-834s of the 900s budget), and the
run was killed again — kill → poison → kill, ×3 → DLQ. The record NEVER
leaves CREATING without intervention, so this ConflictException is
NON-RETRYABLE from within a run and must be either recovered or failed
terminally — never silently spun on.

Chosen recovery path (revised post-incident-2, 2026-08-01 — see
OrphanedRegistryRecordError call sites below), justified against the
bedrock-agentcore-control SDK surface (botocore 1.43.36) AND the live
registry transition table (backend REGISTRY_TRANSITIONS; CREATING is not a
key — no client-side API legally transitions a record OUT of CREATING):

(a) POLL briefly — ``GetRegistryRecord(registryId, recordId)`` returns the
    record ``status`` (enum includes CREATING). Creation is asynchronous,
    so CREATING may be genuinely in-flight: check ≤``POLL_ATTEMPTS`` (5)
    times, ``POLL_INTERVAL_SECONDS`` apart (total budget ≤15s, comfortably
    exceeding the backend's own ≤10s ``waitForStableState`` wait). If the
    record settles to a status other than CREATING, approve it IN PLACE and
    we are done.

(b) If the record settles to CREATE_FAILED (or any other ``*_FAILED``
    status), creation genuinely failed service-side — the record is not
    approvable (PENDING_APPROVAL is unreachable from a FAILED status) — so
    approve is never attempted; fail fast, terminally.

(c) If approve-in-place itself raises for any other reason, fail fast,
    terminally. There is no fallback.

(d) delete-and-recreate — REMOVED. While a record is CREATING the service
    permits neither approve nor delete (both raise ConflictException), so a
    delete-and-recreate arm can never run cleanly: recreating produces a
    SECOND record that is itself CREATING (the approve on it hits the same
    conflict), and the best-effort cleanup-delete on that fresh CREATING
    record also fails and is swallowed — the recreated record survives as a
    NEW orphan. Recovery therefore never creates or deletes anything: this
    makes "zero net-new orphans" a STRUCTURAL invariant of this module, not
    a best-effort.

(e) versioned/suffixed record name — REJECTED: the record NAME is the
    tool's resolution key (records are located by tool_id name by every
    downstream consumer), so a suffixed record would register a tool that
    is invisible to the system. Failing fast is strictly better.

(f) FAIL FAST — any recovery step failing raises
    ``OrphanedRegistryRecordError``: terminal, user-actionable, naming the
    orphaned record, and explicitly marked NON-RETRYABLE so the fabricator
    LLM does not re-enter the retry spiral.

The whole path is strictly bounded: ≤``POLL_ATTEMPTS`` (5) GetRegistryRecord
calls + ≤1 approve call, ≤5 short sleeps (~15s) — versus the observed
~825-834s retry burn. Recovery never calls CreateRegistryRecord or
DeleteRegistryRecord.
"""

import logging
import time

from transient_retry import bedrock_error_code

logger = logging.getLogger(__name__)

# Bounded poll, seconds apart, per bounded-recovery contract — never spins.
# 5 × 3.0s = 15s total budget, comfortably exceeding the backend's own
# waitForStableState wait (≤10s, registry-service.ts:890-903).
POLL_ATTEMPTS = 5
POLL_INTERVAL_SECONDS = 3.0

CREATING_STATUS = "CREATING"

# Statuses the record can settle into where creation genuinely failed
# service-side: the record is not approvable (PENDING_APPROVAL is
# unreachable from any *_FAILED status), so approve must not be attempted.
_FAILED_STATUSES = ("CREATE_FAILED", "UPDATE_FAILED")

# Test seam: recovery sleeps go through this module-level hook so tests can
# neutralize them without patching the global ``time`` module.
_sleep = time.sleep


class OrphanedRegistryRecordError(Exception):
    """Terminal, NON-RETRYABLE registry registration failure.

    An ordinary Exception on purpose: it must reach the LLM as a tool error
    result whose text says DO NOT retry (unlike the deadline hard stop,
    which must bypass the LLM entirely).
    """


def is_creating_conflict(exc):
    """True only for the poison shape: ConflictException mentioning CREATING.

    The live error: ConflictException when calling the
    UpdateRegistryRecordStatus operation: 'Registry record cannot be
    modified while in CREATING state.' Other conflicts (e.g. concurrent
    UPDATING) have different semantics and keep their original handling.
    """
    if bedrock_error_code(exc) != "ConflictException":
        return False
    return CREATING_STATUS in str(exc)


def _is_not_found(exc):
    return bedrock_error_code(exc) == "ResourceNotFoundException"


def _orphaned(name, record_id, registry_id, detail):
    return OrphanedRegistryRecordError(
        f"NON-RETRYABLE: Registry record '{name}' (recordId {record_id}, "
        f"registryId {registry_id}) is orphaned in CREATING state and the "
        f"automatic recovery (poll -> approve in place) failed: {detail} "
        f"DO NOT retry this registration - it cannot succeed until the "
        f"orphaned record is removed. Ask an operator to delete the record "
        f"from the AgentCore Registry, then re-queue this agent."
    )


def recover_creating_record(
    client,
    registry_id,
    record_id,
    name,
    approve,
    *,
    sleep=None,
    poll_attempts=POLL_ATTEMPTS,
    poll_interval_seconds=POLL_INTERVAL_SECONDS,
):
    """Recover a registration blocked by a record stuck in CREATING.

    Approve-in-place is the PRIMARY and ONLY recovery mechanism: this
    function never creates or deletes a Registry record. On any non-success
    outcome (record never settles within the poll budget, settles to a
    ``*_FAILED`` status, or the approve call itself raises) it raises the
    terminal, NON-RETRYABLE ``OrphanedRegistryRecordError`` — leaving the
    single original record in place for operator cleanup. Zero net-new
    orphans is therefore a structural property of this function, not a
    best-effort.

    Args:
        client: bedrock-agentcore-control client (get_registry_record used).
        registry_id: Registry containing the record.
        record_id: The recordId whose approve raised the CREATING conflict.
        name: Record name (the tool_id) — for logs and terminal messages.
        approve: One-arg callable moving a recordId to its usable status
            (the legal two-step DRAFT->PENDING_APPROVAL->APPROVED sequence
            lives in the caller's ``approve`` implementation).
        sleep: Injectable sleep for tests; defaults to the module hook.
        poll_attempts / poll_interval_seconds: Bounded-poll knobs.

    Returns:
        The recordId that ended up approved (always ``record_id`` — this
        function never recreates the record).

    Raises:
        OrphanedRegistryRecordError: Terminal, NON-RETRYABLE — any recovery
            step failed; the message names the orphaned record and the
            operator action. This function NEVER silently spins and NEVER
            creates or deletes a Registry record.
    """
    sleep_fn = _sleep if sleep is None else sleep

    def _status():
        response = client.get_registry_record(
            registryId=registry_id, recordId=record_id
        )
        return (response or {}).get("status")

    # --- bounded poll: CREATING may be genuinely in-flight ------------------
    status = CREATING_STATUS
    for _ in range(poll_attempts):
        sleep_fn(poll_interval_seconds)
        try:
            status = _status()
        except Exception as poll_err:  # noqa: BLE001 — terminal by contract
            raise _orphaned(
                name, record_id, registry_id,
                f"status poll failed with {type(poll_err).__name__}: {poll_err}.",
            )
        if status != CREATING_STATUS:
            break

    if status == CREATING_STATUS:
        raise _orphaned(
            name, record_id, registry_id,
            "the record was still in CREATING state after "
            f"{poll_attempts} checks, {poll_interval_seconds:.0f}s apart.",
        )

    if status in _FAILED_STATUSES:
        # Creation failed service-side; PENDING_APPROVAL is unreachable from
        # a *_FAILED status, so the approve call is doomed — do not attempt
        # it (that would just be a second, differently-shaped failure).
        raise _orphaned(
            name, record_id, registry_id,
            f"the record settled to {status}; creation failed service-side "
            "and the record is not approvable.",
        )

    logger.warning(
        "Registry record '%s' (%s) settled to %s after CREATING conflict; "
        "approving in place", name, record_id, status,
    )
    try:
        approve(record_id)
    except Exception as approve_err:  # noqa: BLE001 — terminal by contract
        raise _orphaned(
            name, record_id, registry_id,
            f"approving the settled record (status {status}) failed with "
            f"{type(approve_err).__name__}: {approve_err}.",
        )

    return record_id
