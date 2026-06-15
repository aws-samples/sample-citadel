#!/usr/bin/env python3
"""
Case-law admin CLI (US-ARB-013).

Writes to and reads from the CDK ``CaseLawTable`` (US-ARB-002 schema):

    PK: entryId            (string, uuid4)
    pattern                (map)
    resolution             (string: 'permit' | 'deny' | 'escalate' | 'halt')
    createdAt              (ISO-8601 string)
    createdBy              (string, adjudicator identity)
    scopeOfApplicability   (map)
    precedence             (number, higher = evaluated first)
    revoked                (bool, soft-delete flag)
    revokedAt              (ISO-8601 string, set when revoked=True)

The hierarchy loader (``arbiter.governance.hierarchy._case_law_from_item``)
skips rows where ``revoked=True`` so revoked entries never reach the engine.

Usage
-----
    python arbiter/governance/case_law_admin.py encode \
        --agent payments-agent --target fraud-agent \
        --outcome deny --adjudicator operator@acme.com \
        [--precedence 10] [--description "..."] [--scope-json '{}']

    python arbiter/governance/case_law_admin.py list [--include-revoked]

    python arbiter/governance/case_law_admin.py verify --entry-id EID

    python arbiter/governance/case_law_admin.py revoke --entry-id EID

Environment
-----------
    CASE_LAW_TABLE   (required) — DynamoDB table name for case-law rows.

The four subcommands are implemented as plain functions (``encode_entry``,
``list_entries``, ``verify_entry``, ``revoke_entry``) so tests can exercise
them without a subprocess.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import uuid
from datetime import datetime, timezone
from typing import Any

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Lazy DDB resource accessor (QB-013-1: do NOT construct at import time).
# ---------------------------------------------------------------------------

_dynamodb: Any = None


def _get_table() -> Any:
    """Return a DynamoDB ``Table`` for the configured case-law table.

    The resource is constructed lazily on first call so tests can patch
    ``_get_table`` directly, and module import does not trigger AWS
    credential discovery.
    """
    global _dynamodb
    table_name = os.environ.get("CASE_LAW_TABLE")
    if not table_name:
        raise RuntimeError(
            "CASE_LAW_TABLE environment variable is not set. "
            "Set it to the DynamoDB table name, e.g. "
            "'citadel-case-law-dev'."
        )
    if _dynamodb is None:
        _dynamodb = boto3.resource("dynamodb")
    return _dynamodb.Table(table_name)


def _iso_now() -> str:
    """Return the current UTC time as an ISO-8601 string with offset."""
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Public command functions (tests call these directly).
# ---------------------------------------------------------------------------


_VALID_OUTCOMES = ("permit", "deny", "escalate", "halt")


def encode_entry(
    agent: str,
    target: str,
    outcome: str,
    adjudicator: str,
    precedence: int = 0,
    description: str = "",
    scope: dict | None = None,
) -> str:
    """Encode a new case-law row and write it to DynamoDB.

    Returns the newly generated ``entryId`` (uuid4).

    Raises:
        ValueError: when ``outcome`` is not one of the four valid values.
    """
    if outcome not in _VALID_OUTCOMES:
        raise ValueError(
            f"outcome must be one of {_VALID_OUTCOMES!r}, got {outcome!r}"
        )
    entry_id = str(uuid.uuid4())
    item: dict[str, Any] = {
        "entryId": entry_id,
        "pattern": {"agent": agent, "target": target},
        "resolution": outcome,
        "createdAt": _iso_now(),
        "createdBy": adjudicator,
        "scopeOfApplicability": scope or {},
        "precedence": int(precedence),
        "revoked": False,
    }
    if description:
        item["description"] = description
    _get_table().put_item(Item=item)
    return entry_id


def list_entries(include_revoked: bool = False) -> list[dict]:
    """Scan the case-law table and return all rows.

    By default, rows with ``revoked=True`` are filtered out. Pass
    ``include_revoked=True`` to return everything.
    """
    table = _get_table()
    items: list[dict] = []
    kwargs: dict[str, Any] = {}
    while True:
        response = table.scan(**kwargs)
        items.extend(response.get("Items", []))
        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            break
        kwargs["ExclusiveStartKey"] = last_key
    if include_revoked:
        return items
    return [row for row in items if not row.get("revoked", False)]


def verify_entry(entry_id: str) -> dict | None:
    """Return the row for ``entry_id`` if present and not revoked.

    Returns ``None`` when the row is missing or has ``revoked=True``. This
    matches the CLI behaviour (``NOT_FOUND`` vs ``REVOKED`` strings are
    produced by the argparse layer — the function result is simply None
    for both cases so tests have a single "gone" sentinel).
    """
    response = _get_table().get_item(Key={"entryId": entry_id})
    item = response.get("Item")
    if item is None:
        return None
    if item.get("revoked", False):
        return None
    return item


def revoke_entry(entry_id: str) -> bool:
    """Soft-delete a case-law row.

    Sets ``revoked=True`` and ``revokedAt=<iso-now>`` via a conditional
    ``UpdateItem`` that requires the row to exist. Returns ``True`` on
    success, ``False`` when the row does not exist.
    """
    now = _iso_now()
    try:
        _get_table().update_item(
            Key={"entryId": entry_id},
            UpdateExpression="SET revoked = :r, revokedAt = :t",
            ConditionExpression="attribute_exists(entryId)",
            ExpressionAttributeValues={":r": True, ":t": now},
        )
    except ClientError as err:
        code = err.response.get("Error", {}).get("Code")
        if code == "ConditionalCheckFailedException":
            return False
        raise
    return True


# ---------------------------------------------------------------------------
# CLI wrappers.
# ---------------------------------------------------------------------------


def _cmd_encode(args: argparse.Namespace) -> int:
    scope: dict | None = None
    if args.scope_json:
        try:
            scope = json.loads(args.scope_json)
            if not isinstance(scope, dict):
                print(
                    f"--scope-json must decode to a JSON object, got {type(scope).__name__}",
                    file=sys.stderr,
                )
                return 2
        except json.JSONDecodeError as err:
            print(f"--scope-json is not valid JSON: {err}", file=sys.stderr)
            return 2
    entry_id = encode_entry(
        agent=args.agent,
        target=args.target,
        outcome=args.outcome,
        adjudicator=args.adjudicator,
        precedence=args.precedence,
        description=args.description or "",
        scope=scope,
    )
    print(entry_id)
    return 0


def _cmd_list(args: argparse.Namespace) -> int:
    rows = list_entries(include_revoked=args.include_revoked)
    for row in rows:
        pattern = row.get("pattern", {})
        print(
            "{eid} | {res} | {adj} | {at} | {pat}".format(
                eid=row.get("entryId", "?"),
                res=row.get("resolution", "?"),
                adj=row.get("createdBy", "?"),
                at=row.get("createdAt", "?"),
                pat=json.dumps(pattern, sort_keys=True),
            )
        )
    return 0


def _cmd_verify(args: argparse.Namespace) -> int:
    # Distinguish NOT_FOUND vs REVOKED at the CLI layer (both resolve to
    # ``None`` from verify_entry, so we re-check the raw row here).
    response = _get_table().get_item(Key={"entryId": args.entry_id})
    item = response.get("Item")
    if item is None:
        print("NOT_FOUND")
        return 1
    if item.get("revoked", False):
        print("REVOKED")
        return 1
    print(json.dumps(item, sort_keys=True, default=str))
    return 0


def _cmd_revoke(args: argparse.Namespace) -> int:
    ok = revoke_entry(args.entry_id)
    if not ok:
        print("NOT_FOUND")
        return 1
    # Include the timestamp we just wrote by re-reading the row — keeps the
    # CLI output line-parseable ("REVOKED <eid> <ts>") without the caller
    # needing to round-trip.
    response = _get_table().get_item(Key={"entryId": args.entry_id})
    item = response.get("Item", {})
    ts = item.get("revokedAt", "?")
    print(f"REVOKED {args.entry_id} {ts}")
    return 0


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="case_law_admin",
        description="Admin CLI for the Citadel case-law DynamoDB table.",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_encode = sub.add_parser("encode", help="Encode a new case-law entry.")
    p_encode.add_argument("--agent", required=True, help="Requesting agent id.")
    p_encode.add_argument("--target", required=True, help="Target agent id.")
    p_encode.add_argument(
        "--outcome",
        required=True,
        choices=_VALID_OUTCOMES,
        help="Arbitration outcome for the encoded pattern.",
    )
    p_encode.add_argument(
        "--adjudicator",
        required=True,
        help="Identifier of the human adjudicator recording this entry.",
    )
    p_encode.add_argument(
        "--precedence", type=int, default=0,
        help="Higher = evaluated first. Defaults to 0.",
    )
    p_encode.add_argument(
        "--description", default="",
        help="Optional free-text description stored alongside the row.",
    )
    p_encode.add_argument(
        "--scope-json", default="",
        help="Optional JSON object for scopeOfApplicability.",
    )
    p_encode.set_defaults(func=_cmd_encode)

    p_list = sub.add_parser("list", help="List case-law entries.")
    p_list.add_argument(
        "--include-revoked", action="store_true",
        help="Include soft-deleted rows in the listing.",
    )
    p_list.set_defaults(func=_cmd_list)

    p_verify = sub.add_parser("verify", help="Verify a case-law entry by id.")
    p_verify.add_argument("--entry-id", required=True, help="entryId (uuid4).")
    p_verify.set_defaults(func=_cmd_verify)

    p_revoke = sub.add_parser("revoke", help="Soft-delete a case-law entry.")
    p_revoke.add_argument("--entry-id", required=True, help="entryId (uuid4).")
    p_revoke.set_defaults(func=_cmd_revoke)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    # All four subcommands touch DynamoDB, so fail fast once argparse has
    # printed its own help / validated required flags.
    if not os.environ.get("CASE_LAW_TABLE"):
        print(
            "error: CASE_LAW_TABLE environment variable is not set.",
            file=sys.stderr,
        )
        return 1
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
