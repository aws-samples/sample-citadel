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

Chosen recovery path, in order of preference, justified against the
bedrock-agentcore-control SDK surface (botocore 1.43.36):

(a) POLL briefly — ``GetRegistryRecord(registryId, recordId)`` returns the
    record ``status`` (enum includes CREATING). Creation is asynchronous,
    so CREATING may be genuinely in-flight: check ≤``POLL_ATTEMPTS`` (2)
    times, ``POLL_INTERVAL_SECONDS`` apart. If the record settles, approve
    it and we are done.

(b) DELETE-AND-RECREATE — the SDK DOES support
    ``DeleteRegistryRecord(registryId, recordId)``: "Deletes a registry
    record. The record's status transitions to DELETING and the record is
    removed asynchronously." No CREATING restriction is documented, so
    deleting the orphan is the sanctioned cleanup. Because deletion is
    asynchronous, wait ≤2 checks for the record to disappear
    (ResourceNotFoundException), then recreate it and approve the fresh
    record. If approving the recreated record fails too, best-effort delete
    it so we never leave a FRESH orphan behind.

(c) versioned/suffixed record name — REJECTED: the record NAME is the
    tool's resolution key (records are located by tool_id name by every
    downstream consumer), so a suffixed record would register a tool that
    is invisible to the system. Failing fast is strictly better.

(d) FAIL FAST — any recovery step failing raises
    ``OrphanedRegistryRecordError``: terminal, user-actionable, naming the
    orphaned record, and explicitly marked NON-RETRYABLE so the fabricator
    LLM does not re-enter the retry spiral.

The whole path is strictly bounded: ≤ ~8 registry API calls and ≤4 short
sleeps (~12s) — versus the observed ~825-834s retry burn.
"""

import logging
import time

from transient_retry import bedrock_error_code

logger = logging.getLogger(__name__)

# ≤2 checks, seconds apart, per bounded-recovery contract — never spins.
POLL_ATTEMPTS = 2
POLL_INTERVAL_SECONDS = 3.0

CREATING_STATUS = "CREATING"

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
        f"automatic recovery (poll -> delete -> recreate) failed: {detail} "
        f"DO NOT retry this registration - it cannot succeed until the "
        f"orphaned record is removed. Ask an operator to delete the record "
        f"from the AgentCore Registry, then re-queue this agent."
    )


def recover_creating_record(
    client,
    registry_id,
    record_id,
    name,
    recreate,
    approve,
    *,
    sleep=None,
    poll_attempts=POLL_ATTEMPTS,
    poll_interval_seconds=POLL_INTERVAL_SECONDS,
):
    """Recover a registration blocked by a record stuck in CREATING.

    Args:
        client: bedrock-agentcore-control client (get/delete record used).
        registry_id: Registry containing the record.
        record_id: The recordId whose approve raised the CREATING conflict.
        name: Record name (the tool_id) — for logs and terminal messages.
        recreate: Zero-arg callable re-issuing the original
            CreateRegistryRecord; returns the NEW recordId.
        approve: One-arg callable moving a recordId to its usable status.
        sleep: Injectable sleep for tests; defaults to the module hook.
        poll_attempts / poll_interval_seconds: Bounded-poll knobs.

    Returns:
        The recordId that ended up approved (original or recreated).

    Raises:
        OrphanedRegistryRecordError: Terminal, NON-RETRYABLE — any recovery
            step failed; the message names the orphaned record and the
            operator action. This function NEVER silently spins.
    """
    sleep_fn = _sleep if sleep is None else sleep

    def _status():
        response = client.get_registry_record(
            registryId=registry_id, recordId=record_id
        )
        return (response or {}).get("status")

    # --- (a) brief bounded poll: CREATING may be genuinely in-flight -------
    status = CREATING_STATUS
    record_exists = True
    for _ in range(poll_attempts):
        sleep_fn(poll_interval_seconds)
        try:
            status = _status()
        except Exception as poll_err:  # noqa: BLE001 — classified below
            if _is_not_found(poll_err):
                # The orphan vanished (e.g. an operator already deleted it):
                # skip the delete and go straight to recreate.
                record_exists = False
                break
            raise _orphaned(
                name, record_id, registry_id,
                f"status poll failed with {type(poll_err).__name__}: {poll_err}.",
            )
        if status != CREATING_STATUS:
            break

    if record_exists and status != CREATING_STATUS:
        logger.warning(
            "Registry record '%s' (%s) settled to %s after CREATING conflict; "
            "approving in place", name, record_id, status,
        )
        try:
            approve(record_id)
            return record_id
        except Exception as approve_err:  # noqa: BLE001 — fall through to (b)
            # Settled somewhere unusable (e.g. CREATE_FAILED) or raced back
            # into a conflict — the record is not salvageable in place;
            # continue to delete-and-recreate.
            logger.warning(
                "Approving settled record '%s' (%s, status %s) failed with "
                "%s: %s — falling back to delete-and-recreate",
                name, record_id, status, type(approve_err).__name__, approve_err,
            )

    # --- (b) delete-and-recreate the orphaned record ------------------------
    if record_exists:
        try:
            client.delete_registry_record(
                registryId=registry_id, recordId=record_id
            )
        except Exception as delete_err:  # noqa: BLE001 — classified below
            if not _is_not_found(delete_err):
                raise _orphaned(
                    name, record_id, registry_id,
                    f"DeleteRegistryRecord failed with "
                    f"{type(delete_err).__name__}: {delete_err}.",
                )

        # Deletion is asynchronous (status -> DELETING, removed async): wait
        # for the record to actually disappear before recreating the name.
        gone = False
        for _ in range(poll_attempts):
            sleep_fn(poll_interval_seconds)
            try:
                _status()
            except Exception as check_err:  # noqa: BLE001 — classified below
                if _is_not_found(check_err):
                    gone = True
                    break
                raise _orphaned(
                    name, record_id, registry_id,
                    f"deletion check failed with "
                    f"{type(check_err).__name__}: {check_err}.",
                )
        if not gone:
            raise _orphaned(
                name, record_id, registry_id,
                "the record was still present after the asynchronous delete "
                f"({poll_attempts} checks, {poll_interval_seconds:.0f}s apart).",
            )

    try:
        new_record_id = recreate()
    except Exception as create_err:  # noqa: BLE001 — terminal by contract
        raise _orphaned(
            name, record_id, registry_id,
            f"recreating the record failed with "
            f"{type(create_err).__name__}: {create_err}.",
        )

    try:
        approve(new_record_id)
    except Exception as approve_err:  # noqa: BLE001 — terminal by contract
        # Never leave a FRESH orphan behind: best-effort cleanup of the
        # record we just recreated but could not approve.
        try:
            client.delete_registry_record(
                registryId=registry_id, recordId=new_record_id
            )
        except Exception as cleanup_err:  # noqa: BLE001 — best-effort only
            logger.warning(
                "Best-effort cleanup of recreated record '%s' (%s) failed: %s",
                name, new_record_id, cleanup_err,
            )
        raise _orphaned(
            name, new_record_id, registry_id,
            f"approving the recreated record failed with "
            f"{type(approve_err).__name__}: {approve_err}.",
        )

    logger.warning(
        "Recovered orphaned CREATING record '%s': deleted %s, recreated as %s "
        "and approved", name, record_id, new_record_id,
    )
    return new_record_id
