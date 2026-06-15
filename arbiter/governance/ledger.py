"""
Governance ledger — write-once legibility records (US-ARB-004).

Every ``GovernanceFinding`` produced by the arbitration engine is written to
DynamoDB immediately after evaluation. The ledger is write-once: never
updated, never deleted (TTL-managed retention, QT1-10 = 90 days).

Fail-closed contract (Article 3 of the framework): if the ledger write fails
for *any* reason — throttling, network, permission, missing env var — the
caller MUST treat the underlying governance decision as ``DENY``. A
successful PERMIT without a successful ledger write is not allowed. To
guarantee this at the code level, every failure path in this module raises
``LedgerWriteError``; no exception is swallowed.

Ported from the Agentic Fabric reference (``src/governance/ledger.py``) with
Citadel-specific adaptations:

* boto3 resource is constructed lazily (QB-013-1) rather than at import time,
  so tests can patch ``boto3.resource`` before the first call and the module
  does not trigger AWS credential discovery on import.
* TTL is derived from ``time.time()`` at write-time rather than from the
  finding's own timestamp, so retention is counted from the moment the record
  was *persisted*, independent of any clock drift on the producing agent.
* Enum / datetime / Decimal normalisation is centralised in
  ``_normalize_value`` so dataclass fields of any supported type flatten to a
  DDB-safe scalar. ``None`` values are stripped because DDB rejects them for
  type S/N attributes.
"""

from __future__ import annotations

import dataclasses
import datetime
import decimal
import logging
import os
import time
from enum import Enum
from typing import Any

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from .models import GovernanceFinding

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Public exception
# ---------------------------------------------------------------------------


class LedgerWriteError(Exception):
    """Raised when the ledger write fails.

    Callers MUST treat a ``LedgerWriteError`` as a governance DENY: the
    legibility record was not produced, therefore the underlying decision
    cannot be honoured (fail-closed per Article 3).
    """


# ---------------------------------------------------------------------------
# Lazy DDB resource accessor (QB-013-1: do NOT construct at import time)
# ---------------------------------------------------------------------------


_ddb_resource: Any = None


def _get_dynamodb_resource() -> Any:
    """Return a boto3 DynamoDB resource, constructed on demand and cached.

    Constructing the resource lazily lets tests patch ``boto3.resource``
    before this function is first called, and avoids triggering AWS
    credential discovery at import time.
    """
    global _ddb_resource
    if _ddb_resource is None:
        _ddb_resource = boto3.resource("dynamodb")
    return _ddb_resource


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------


def _normalize_value(value: Any) -> Any:
    """Normalise a Python value to a DynamoDB-safe representation.

    * ``Enum`` → ``.value``
    * ``datetime`` → ISO-8601 string
    * ``Decimal`` → preserved (DDB accepts Decimal directly)
    * ``float`` / ``int`` / ``bool`` / ``str`` → as-is
    * ``dict`` → recursively normalised, ``None`` children stripped
    * ``list`` / ``tuple`` → recursively normalised, ``None`` children stripped
    * ``None`` → returned as-is; callers are responsible for stripping it
      before writing to DDB.

    Anything else is coerced to ``str`` so the ledger write cannot fail on an
    unexpected field type — losing fidelity is preferable to losing the
    audit record.
    """
    if value is None:
        return None
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, bool):  # bool is a subclass of int — check first
        return value
    if isinstance(value, (int, float, str, decimal.Decimal)):
        return value
    if isinstance(value, datetime.datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _normalize_value(v) for k, v in value.items() if v is not None}
    if isinstance(value, (list, tuple)):
        return [_normalize_value(v) for v in value if v is not None]
    return str(value)


def _serialize_finding(finding: GovernanceFinding) -> dict[str, Any]:
    """Flatten a ``GovernanceFinding`` dataclass into a DDB item.

    Dataclass field names are used as-is (``finding_id``, ``workflow_id``)
    except for the three attributes that participate in the table's key
    schema / GSI, which are also emitted in camelCase form:

    * ``findingId``  — table HASH key (write-once condition target)
    * ``workflowId`` — ``workflow-index`` GSI HASH key
    * ``timestamp``  — ``workflow-index`` GSI RANGE key (NUMBER)

    ``None`` values are stripped because DDB rejects ``None`` for type S / N.
    """
    raw = dataclasses.asdict(finding)
    item: dict[str, Any] = {}
    for key, value in raw.items():
        normalised = _normalize_value(value)
        if normalised is None:
            continue
        item[key] = normalised

    # Key-schema aliases. These MUST always be present on the written item:
    # findingId is the table HASH and the write-once condition target;
    # workflowId / timestamp are the workflow-index GSI keys.
    item["findingId"] = finding.finding_id
    item["workflowId"] = finding.workflow_id
    item["timestamp"] = float(finding.timestamp)
    return item


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def write_finding(finding: GovernanceFinding, *, ttl_days: int = 90) -> None:
    """Write-once record of a governance finding to the ledger.

    Enforces write-once semantics with
    ``ConditionExpression='attribute_not_exists(findingId)'`` — a duplicate
    ``finding_id`` is rejected by DDB as ``ConditionalCheckFailedException``
    and re-raised here as :class:`LedgerWriteError`.

    Sets ``ttl = time.time() + ttl_days * 86400`` seconds (QT1-10 requires a
    90-day default retention window).

    Reads the table name from the ``GOVERNANCE_LEDGER_TABLE`` environment
    variable. If it is unset, raises :class:`LedgerWriteError` immediately
    without attempting any network I/O (fail-closed).

    Any other exception from the underlying ``boto3`` call — ``ClientError``,
    ``BotoCoreError``, ``TypeError`` from a malformed item, etc. — is wrapped
    and re-raised as :class:`LedgerWriteError`. Callers MUST treat the wrap
    as a DENY.
    """
    table_name = os.environ.get("GOVERNANCE_LEDGER_TABLE")
    if not table_name:
        # Fail-closed: no table configured means no legibility record can
        # be produced, so the caller's decision cannot be honoured.
        raise LedgerWriteError(
            "GOVERNANCE_LEDGER_TABLE not configured — cannot produce "
            "legibility record (fail-closed)"
        )

    try:
        item = _serialize_finding(finding)
        item["ttl"] = time.time() + (ttl_days * 86400)
    except Exception as exc:  # pragma: no cover — defensive, asdict is total
        raise LedgerWriteError(
            f"Failed to serialise GovernanceFinding {finding.finding_id!r}: {exc}"
        ) from exc

    try:
        table = _get_dynamodb_resource().Table(table_name)
        table.put_item(
            Item=item,
            ConditionExpression="attribute_not_exists(findingId)",
        )
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "Unknown")
        raise LedgerWriteError(
            f"DDB put_item failed ({code}) for finding "
            f"{finding.finding_id!r}: {exc}"
        ) from exc
    except BotoCoreError as exc:
        raise LedgerWriteError(
            f"boto3 transport error writing finding "
            f"{finding.finding_id!r}: {exc}"
        ) from exc
    except Exception as exc:
        # Catch-all: never let an unexpected exception bypass the
        # fail-closed contract by being raised as something other than
        # LedgerWriteError.
        raise LedgerWriteError(
            f"Unexpected error writing finding "
            f"{finding.finding_id!r}: {exc}"
        ) from exc


def __reset_ledger_client_for_test() -> None:
    """Clear the cached boto3 resource.

    Test-only helper. Safe to call from production code — the next
    ``write_finding`` call will simply rebuild the resource.
    """
    global _ddb_resource
    _ddb_resource = None
