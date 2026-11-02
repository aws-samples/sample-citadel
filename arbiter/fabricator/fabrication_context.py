"""Per-request fabrication context — ContextVar-based (CIT-250 pattern).

process_event sets these once from the validated SQS event fields, and
upload_tool_to_s3 / upload_to_s3 read them.  LLM-supplied arguments are
NEVER used for tenant-scoped key construction.
"""
from __future__ import annotations

from contextvars import ContextVar

# org_id: the caller's organisation, validated non-empty by process_event's
# tenancy gate before any fabrication work starts.
fabrication_org_id: ContextVar[str] = ContextVar("fabrication_org_id", default="")

# job_id: the orchestration_id from the SQS event — stable across retries
# for the same fabrication request.  Used as the second segment in the
# tenant-scoped S3 key so every tool in one fabrication run shares a
# prefix that can be listed/cleaned independently.
fabrication_job_id: ContextVar[str] = ContextVar("fabrication_job_id", default="")

# Per-job map {tool_name -> scoped S3 key} recorded by upload_tool_to_s3.
# get_worker_tool consults this FIRST so the same fabrication run can
# retrieve a tool it just uploaded without relying on the registry record
# (which may not exist yet).  The map is reset between runs by
# process_event's finally block.
fabrication_tool_keys: ContextVar[dict[str, str]] = ContextVar(
    "fabrication_tool_keys", default=None,  # type: ignore[arg-type]
)


def record_tool_key(tool_name: str, s3_key: str) -> None:
    """Record a tool's scoped S3 key in the per-job map."""
    keys = fabrication_tool_keys.get(None)
    if keys is None:
        keys = {}
        fabrication_tool_keys.set(keys)
    keys[tool_name] = s3_key


def lookup_tool_key(tool_name: str) -> str | None:
    """Look up a tool's scoped S3 key from the per-job map."""
    keys = fabrication_tool_keys.get(None)
    if keys is None:
        return None
    return keys.get(tool_name)
