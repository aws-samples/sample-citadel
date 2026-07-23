"""Deadline-aware execution guard for the fabricator Lambda.

Why this exists (live evidence, 2026-07-23): the fabricator Lambda
(Timeout 900s; successful builds measure 585-748s) was SIGKILLed at exactly
900s mid tool-registration (REPORT Status: timeout). A SIGKILL skips every
except/finally, so the job's terminal DynamoDB status write never happened;
SQS redelivered the message (visibility 90 min, maxReceiveCount 3) into the
same poison state, each redelivery burned another 900s and was killed again,
and after the 3rd kill the messages parked in the DLQ with the job rows
stuck PROCESSING forever.

``FabricationDeadline`` wraps the Lambda context's remaining-time clock
(``context.get_remaining_time_in_millis``). The registration @tools
checkpoint against it before/after each registry registration, and
``call_with_transient_retry`` declines attempts/backoffs that cannot fit
before (deadline - safety margin). When a checkpoint lands inside the
margin it raises ``FabricationDeadlineExceeded`` so ``process_event`` can
STOP, write the job's terminal FAILED status with a 'timed out' actionable
message, and return cleanly INSTEAD of being SIGKILLed — guaranteeing a
terminal write even on time exhaustion.

``FabricationDeadlineExceeded`` deliberately derives from ``BaseException``:
the Strands @tool executor converts ANY ``Exception`` raised inside a tool
into an error ToolResult fed back to the model (strands/tools/decorator.py,
``except Exception``) — which is exactly the LLM-driven retry spiral this
guard exists to stop — and ``call_with_transient_retry`` likewise catches
``Exception``. A ``BaseException`` skips both handlers and propagates
straight to ``process_event``. Belt-and-braces: the deadline also latches
``tripped``, so even if some layer converted the exception anyway,
``process_event`` still detects the trip and refuses to write COMPLETED.
"""

import logging

logger = logging.getLogger(__name__)

# Safety-margin sizing (justified against the live numbers): after a
# checkpoint trips we still need to (a) unwind out of the Strands agent
# loop, (b) write the terminal FAILED row to DynamoDB and (c) publish two
# EventBridge signals — single-digit seconds of API calls — plus, on the
# fallback path where a converted trip only surfaces after the agent loop
# finishes its current model round, ONE final short model round. 30s covers
# (a)-(c) alone but leaves no headroom for that fallback round; anything
# well above 60s donates back budget the build itself needs (successful
# builds run 585-748s against the 900s ceiling — only ~150-315s of total
# headroom exists). 60s is the top of the justified 30-60s band.
SAFETY_MARGIN_SECONDS = 60.0

_UNLIMITED_SECONDS = float("inf")


class FabricationDeadlineExceeded(BaseException):
    """Raised by a deadline checkpoint when remaining time <= safety margin.

    BaseException on purpose — see the module docstring: it must skip the
    ``except Exception`` handlers in the Strands tool executor and in
    ``call_with_transient_retry`` to reach ``process_event`` as a hard stop.
    """


class FabricationDeadline:
    """Remaining-time deadline with a safety margin and a tripped latch.

    Args:
        remaining_ms: Zero-arg callable returning the milliseconds left
            before the Lambda is SIGKILLed (the Lambda context's
            ``get_remaining_time_in_millis``), or None for an unlimited
            deadline (local runs / tests passing ``{}`` as context).
        safety_margin_seconds: Stop-work threshold — see
            ``SAFETY_MARGIN_SECONDS`` for the sizing rationale.
    """

    def __init__(self, remaining_ms=None, safety_margin_seconds=SAFETY_MARGIN_SECONDS):
        self._remaining_ms = remaining_ms
        self.safety_margin_seconds = float(safety_margin_seconds)
        self.tripped = False
        self.tripped_where = None

    @classmethod
    def from_lambda_context(cls, context, safety_margin_seconds=SAFETY_MARGIN_SECONDS):
        """Build a deadline from a Lambda context, degrading gracefully.

        ``__main__`` and many tests pass ``{}`` (or other duck contexts)
        instead of a real Lambda context — those get an unlimited deadline
        so behavior is unchanged outside the Lambda runtime.
        """
        remaining_ms = getattr(context, "get_remaining_time_in_millis", None)
        return cls(
            remaining_ms if callable(remaining_ms) else None,
            safety_margin_seconds,
        )

    def remaining_seconds(self):
        """Seconds left on the clock; unlimited when there is no clock.

        A broken clock must never fail a build — degrade to unlimited and
        log, rather than raising out of a checkpoint.
        """
        if self._remaining_ms is None:
            return _UNLIMITED_SECONDS
        try:
            return max(float(self._remaining_ms()) / 1000.0, 0.0)
        except Exception:  # noqa: BLE001 — degraded clock is non-fatal by design
            logger.warning(
                "FabricationDeadline clock raised; treating deadline as unlimited",
                exc_info=True,
            )
            return _UNLIMITED_SECONDS

    def exceeded(self):
        """True when the remaining time is inside the safety margin."""
        return self.remaining_seconds() <= self.safety_margin_seconds

    def can_fit(self, seconds):
        """True when ``seconds`` of work still leaves the safety margin."""
        remaining = self.remaining_seconds()
        if remaining == _UNLIMITED_SECONDS:
            return True
        return remaining - float(seconds) > self.safety_margin_seconds

    def check(self, where):
        """Checkpoint: raise (and latch ``tripped``) when inside the margin.

        Args:
            where: Human-readable checkpoint label, kept for the terminal
                'timed out' message (e.g. "before tool registration 'x'").
        """
        if self.exceeded():
            self.tripped = True
            self.tripped_where = where
            raise FabricationDeadlineExceeded(
                f"Lambda deadline safety margin reached at {where}: "
                f"{self.remaining_seconds():.1f}s remaining <= "
                f"{self.safety_margin_seconds:.0f}s margin — stopping work "
                f"now so the terminal status write happens INSTEAD of a "
                f"SIGKILL at the Lambda timeout."
            )


# --- module-level current deadline -------------------------------------------
#
# The registration @tools (store_tool_config_registry, create_custom_tool,
# store_agent_config_registry) are MODULE-LEVEL functions invoked by the
# Strands agent loop; a @tool signature is the model-visible schema, so the
# deadline cannot be threaded through their parameters without exposing it
# to the LLM. The Lambda processes one SQS record at a time (queue
# batchSize=1 and lambda_handler iterates sequentially), so a module global
# is race-free — but Lambda CONTAINERS ARE REUSED across invocations, so
# process_event must set it at the start of every run and clear it in a
# finally.

_current_deadline = None


def set_fabrication_deadline(deadline):
    """Install the current run's deadline for the registration checkpoints."""
    global _current_deadline
    _current_deadline = deadline


def get_fabrication_deadline():
    """Return the current run's deadline, or None outside a run."""
    return _current_deadline


def clear_fabrication_deadline():
    """Remove the current run's deadline (call from process_event's finally)."""
    global _current_deadline
    _current_deadline = None


def registration_checkpoint(where):
    """Watchdog checkpoint used before/after each registry registration.

    No-op when no deadline is installed (direct calls, local runs, tests).
    """
    if _current_deadline is not None:
        _current_deadline.check(where)


def timed_out_failure_message(agent_use_id, deadline=None):
    """Terminal, user-actionable errorMessage for a deadline-tripped job."""
    where = getattr(deadline, "tripped_where", None) or "fabrication"
    return (
        f"Fabrication of '{agent_use_id}' timed out: the Lambda's remaining "
        f"execution time fell below the safety margin at {where}. The job "
        f"was stopped cleanly so this terminal status could be written "
        f"(instead of the Lambda being killed mid-write). Re-queue the "
        f"agent to try again."
    )
