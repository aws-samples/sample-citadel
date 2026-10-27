"""Request-scoped session identity — the single source of truth for all tool
calls within a turn.

The entrypoint sets this once per request from the trusted payload (constructed
by agent-message-handler Lambda, not user-controlled). Tools READ from here;
a model-supplied session_id is ignored with a mismatch metric.

Thread-safety: BedrockAgentCoreApp runs one request per asyncio event loop
turn in a single-threaded container. contextvars.ContextVar is the correct
primitive: it isolates per-coroutine without locks.
"""
from __future__ import annotations

import logging
from contextvars import ContextVar
from dataclasses import dataclass

logger = logging.getLogger(__name__)

_METRIC_NAME = "IntakeSessionMismatch"


@dataclass(frozen=True)
class SessionIdentity:
    session_id: str
    user_id: str   # Cognito sub — from sessionAttributes.userId
    org_id: str     # from sessionAttributes.org (server-derived, required)


_current: ContextVar[SessionIdentity | None] = ContextVar(
    "intake_session_identity", default=None
)


class MissingSessionError(ValueError):
    """Raised when bind_request receives a payload without session_id."""


class MissingOrgError(ValueError):
    """Raised when bind_request receives a payload without sessionAttributes.org.

    The org is derived server-side (agent-message-handler reads the projects
    table). An absent org means the handler should never have invoked the
    agent — fail closed so tenant-scoped tools cannot silently operate with
    an empty org_id.
    """


def bind_request(payload: dict) -> SessionIdentity:
    """Bind the request-scoped identity from trusted payload fields.

    Called once per entrypoint invocation.  Raises MissingSessionError when
    session_id is absent or empty, and MissingOrgError when
    sessionAttributes.org is absent or empty — the entrypoint must fail closed.
    """
    session_id = (payload.get("session_id") or "").strip()
    if not session_id:
        raise MissingSessionError("payload missing required session_id")

    attrs = payload.get("sessionAttributes") or {}
    user_id = str(attrs.get("userId") or "")
    org_id = str(attrs.get("org") or "").strip()

    if not org_id:
        raise MissingOrgError(
            "payload missing required sessionAttributes.org — "
            "the invoking handler must derive the organisation from the project record"
        )

    identity = SessionIdentity(
        session_id=session_id,
        user_id=user_id,
        org_id=org_id,
    )
    _current.set(identity)
    return identity


def current_session() -> SessionIdentity:
    """Read the bound identity.  Raises RuntimeError outside a request."""
    identity = _current.get()
    if identity is None:
        raise RuntimeError("current_session() called outside request scope")
    return identity


def current_session_id() -> str:
    """Convenience: the session_id for DynamoDB/S3 keying."""
    return current_session().session_id


def require_bound_session_id(tool_name: str, model_session_id: str | None = None) -> str:
    """Return the server-bound session_id.

    If ``model_session_id`` is supplied and differs from the bound value, log
    a structured warning and emit the IntakeSessionMismatch metric name (for
    CloudWatch alarm).  Always returns the BOUND value.
    """
    bound = current_session_id()
    if model_session_id is not None and model_session_id != bound:
        logger.warning(
            "session_id mismatch: model=%.16s bound=%.16s tool=%s metric=%s",
            model_session_id,
            bound,
            tool_name,
            _METRIC_NAME,
        )
    return bound


def clear() -> None:
    """Reset after request completes (defensive cleanup)."""
    _current.set(None)
