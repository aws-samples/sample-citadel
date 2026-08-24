"""Single DynamoDB item-marshalling boundary (finding 96d24639).

THE one place every DynamoDB *item* write on the workflow-node tool-call path
flows through before it reaches boto3. boto3's DynamoDB marshaller rejects a
native Python ``float`` outright (``Float types are not supported. Use Decimal
types instead.``) — a run-time ``TypeError`` deep inside ``put_item`` /
``transact_write_items``. Historically that error surfaced ad hoc, one write
site at a time, and in at least one path it was swallowed so the row *silently
never landed* (an unauditable tool execution). Rather than fix each site as it
breaks, every item write is routed through :func:`marshal_ddb_item`, so a float
can never silently reach DynamoDB from this path again — a NEW field carrying a
float is normalized or rejected here automatically, not discovered in
production.

Float policy (deterministic, total — the two known intents plus a hard reject):

* **Integral float → ``int``** (``1000.0 → 1000``). Lossless. This is also the
  safety net for a ttl computed as a float: DynamoDB TTL requires an integer
  epoch-seconds attribute, so callers SHOULD compute ttl as ``int(now) + …``,
  and this boundary guarantees it even if one forgets.
* **Fractional float → ``Decimal``** via ``Decimal(str(x))`` — the correct idiom
  for a *genuine* fractional value (e.g. a sub-second ``writtenAt`` or a
  fractional epoch ``timestamp`` GSI key). ``str(x)`` uses Python's
  round-trippable repr, so no spurious binary-float precision tail is stored.
* **Non-finite float (``NaN`` / ``±Infinity``) → REJECT** with
  :class:`FloatMarshallingError`. There is no faithful DynamoDB Number for these
  and ``Decimal('NaN')`` is itself rejected by DynamoDB, so failing loudly at the
  boundary is the only honest option.

Everything else is passed through untouched — ``Decimal`` (already DDB-safe),
``int`` / ``str`` / ``bool`` / ``bytes`` / ``None`` — recursing through ``dict``
and ``list`` / ``tuple`` so a float nested anywhere in the item is caught. A
``bool`` is deliberately checked before ``float``/``int`` handling because
``bool`` is an ``int`` subclass and must stay a boolean.

Pure and I/O-free. Deployed in the shared ``ArbiterCatalogLayer`` at
``/opt/python/common`` so every carrier Lambda — the worker subprocess, the
governance-layer writers, the seeded smoke tool — imports it as
``from common.ddb_marshalling import marshal_ddb_item``.
"""

from __future__ import annotations

import decimal
import math
from typing import Any


class FloatMarshallingError(TypeError):
    """A float value cannot be safely marshalled for DynamoDB.

    Raised only for the genuinely unrepresentable case — a non-finite float
    (``NaN`` / ``±Infinity``). A finite float is always converted (integral →
    ``int``, fractional → ``Decimal``), never raised on. Subclasses
    ``TypeError`` so it is a drop-in for the boto3 ``TypeError`` a raw float
    would otherwise have produced deeper in the stack.
    """


def normalize_ddb_value(value: Any) -> Any:
    """Recursively normalize a single value to a DynamoDB-safe representation.

    Applies the float policy documented at module scope; recurses through
    ``dict`` and ``list`` / ``tuple`` (a tuple becomes a list). Total for any
    finite input; raises :class:`FloatMarshallingError` only on a non-finite
    float.
    """
    # bool BEFORE int/float — bool is an int subclass and must remain boolean.
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            raise FloatMarshallingError(
                f"non-finite float cannot be stored in DynamoDB: {value!r}"
            )
        if value.is_integer():
            # Integral float → int (covers a float ttl / a 1000.0-style value).
            return int(value)
        # Genuine fractional value → Decimal via the round-trippable repr.
        return decimal.Decimal(str(value))
    if isinstance(value, dict):
        return {k: normalize_ddb_value(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [normalize_ddb_value(v) for v in value]
    # Decimal / int / str / bytes / None / anything else: DDB-safe or the
    # caller's own concern — passed through untouched.
    return value


def marshal_ddb_item(item: Any) -> dict[Any, Any]:
    """Return a new item dict with every float normalized (see module doc).

    The single choke point for a DynamoDB item write on the tool-call path:
    ``put_item(Item=marshal_ddb_item(item))`` and the ``Put``/``Item`` member of
    a ``TransactWriteItems`` request. Returns a fresh dict (never mutates the
    caller's) so it is safe to marshal an item the caller still holds a
    reference to.

    Raises ``TypeError`` if ``item`` is not a mapping (a non-dict item is never
    a valid DynamoDB write and would fail more obscurely downstream), and
    :class:`FloatMarshallingError` on a non-finite float anywhere within it.
    """
    if not isinstance(item, dict):
        raise TypeError(
            f"marshal_ddb_item expects a dict item, got {type(item).__name__}"
        )
    return {k: normalize_ddb_value(v) for k, v in item.items()}
