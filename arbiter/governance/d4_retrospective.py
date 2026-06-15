"""D4 defense-in-depth retrospective script (US-ARB-020).

Query the governance ledger for findings at scope_evaluated in
{'worker-pre-filter', 'worker-tool-handler'} over a configurable time
window (default 30 days), compute overlap, and write a markdown
report with a keep-both / re-debate recommendation.

Usage:
    python -m arbiter.governance.d4_retrospective \\
        --window-days 30 \\
        --output reports/d4-defense-in-depth-$(date +%F).md

Env:
    GOVERNANCE_LEDGER_TABLE  required
    AWS_DEFAULT_REGION        required

Outcome-gated: meaningful output requires >=30 days of post-wave-4
ledger telemetry. If the ledger has < 1 worker-tool-handler finding in
the last 60 days, the script writes a 'Status: deferred-90d' stub
report and exits 0 -- retrospective cannot be produced until enough
data accumulates.

Spec: arbiter-governance-engine/requirements.md Requirement 9.8 (QD-5
distinct-scope invariant audit).
Plan: US-ARB-020 Delta16 retrospective.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta
from pathlib import Path

import boto3

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

SCOPE_WORKER_PRE_FILTER = "worker-pre-filter"
SCOPE_WORKER_TOOL_HANDLER = "worker-tool-handler"
RECOMMENDATION_THRESHOLD_HIGH = 0.90
RECOMMENDATION_THRESHOLD_LOW = 0.20
INSUFFICIENT_EVIDENCE_DAYS = 60

_dynamodb = None


def _get_table():
    """Return a DynamoDB Table handle for the governance ledger.

    The boto3 resource is constructed lazily so tests can patch
    ``_get_table`` (or the module-level ``_dynamodb``) before the first
    call and import-time AWS credential discovery is avoided.
    """
    global _dynamodb
    if _dynamodb is None:
        _dynamodb = boto3.resource("dynamodb")
    table_name = os.environ.get("GOVERNANCE_LEDGER_TABLE")
    if not table_name:
        raise RuntimeError("GOVERNANCE_LEDGER_TABLE env var not set")
    return _dynamodb.Table(table_name)


def __reset_clients_for_test() -> None:
    """Clear the cached boto3 resource (test-only helper)."""
    global _dynamodb
    _dynamodb = None


@dataclass
class RetrospectiveData:
    """Aggregated DENY counts at the two worker scopes.

    ``distinct_pre_filter`` / ``distinct_tool_handler`` hold the set of
    ``"{workflow_id}|{reason}"`` tuple keys observed at each scope
    within the time window. ``overlap`` is the set intersection.
    """

    pre_filter_count: int = 0
    tool_handler_count: int = 0
    distinct_pre_filter: set[str] = field(default_factory=set)
    distinct_tool_handler: set[str] = field(default_factory=set)
    overlap: set[str] = field(default_factory=set)
    window_start: str = ""
    window_end: str = ""

    @property
    def overlap_ratio(self) -> float:
        """Overlap cardinality divided by max distinct-set size.

        ``max(..., 1)`` guards divide-by-zero when both sets are empty.
        The denominator is the larger of the two distinct-tuple sets so
        the ratio answers "what fraction of the bigger layer is also
        caught by the smaller one?".
        """
        denom = max(
            len(self.distinct_pre_filter),
            len(self.distinct_tool_handler),
            1,
        )
        return len(self.overlap) / denom

    @property
    def insufficient_evidence(self) -> bool:
        """True when fewer than 1 tool-handler DENY is in the window.

        Per US-ARB-020, a retrospective cannot be produced without
        measurable tool-handler telemetry. The caller short-circuits to
        a 'deferred-90d' recommendation in that case.
        """
        return self.tool_handler_count < 1


def scan_findings(window_days: int = 30) -> RetrospectiveData:
    """Scan the governance ledger for DENY findings at both worker scopes.

    Walks ``table.scan`` with ``ExclusiveStartKey`` pagination so
    result sets larger than the 1 MB DDB scan page are handled. Only
    items whose ``decision == 'deny'`` and whose ``timestamp`` falls
    inside the ``[now - window_days, now]`` window are considered.

    ``timestamp`` is treated as a float epoch-seconds value per
    US-ARB-004 ``ledger.py`` serialisation.
    """
    now = datetime.now(timezone.utc)
    window_start = now - timedelta(days=window_days)
    window_start_epoch = window_start.timestamp()

    table = _get_table()
    pre_filter: set[str] = set()
    tool_handler: set[str] = set()
    pf_count = 0
    th_count = 0

    paginator_key = None
    while True:
        scan_kwargs: dict = {}
        if paginator_key:
            scan_kwargs["ExclusiveStartKey"] = paginator_key
        response = table.scan(**scan_kwargs)
        for item in response.get("Items", []):
            if item.get("decision") != "deny":
                continue
            ts = float(item.get("timestamp", 0))
            if ts < window_start_epoch:
                continue
            scope = item.get("scope_evaluated", "")
            key = f"{item.get('workflow_id', '')}|{item.get('reason', '')}"
            if scope == SCOPE_WORKER_PRE_FILTER:
                pre_filter.add(key)
                pf_count += 1
            elif scope == SCOPE_WORKER_TOOL_HANDLER:
                tool_handler.add(key)
                th_count += 1
        paginator_key = response.get("LastEvaluatedKey")
        if not paginator_key:
            break

    return RetrospectiveData(
        pre_filter_count=pf_count,
        tool_handler_count=th_count,
        distinct_pre_filter=pre_filter,
        distinct_tool_handler=tool_handler,
        overlap=pre_filter & tool_handler,
        window_start=window_start.isoformat(),
        window_end=now.isoformat(),
    )


def build_recommendation(data: RetrospectiveData) -> str:
    """Map a ``RetrospectiveData`` to one of four recommendation strings.

    Branches (precedence order matters):

    * ``deferred-90d`` -- insufficient tool-handler evidence.
    * ``re-debate`` -- overlap ratio strictly greater than 90%.
    * ``keep-both-strong-evidence`` -- overlap ratio strictly less than 20%.
    * ``keep-both`` -- everything in between.
    """
    if data.insufficient_evidence:
        return "deferred-90d"
    if data.overlap_ratio > RECOMMENDATION_THRESHOLD_HIGH:
        return "re-debate"
    if data.overlap_ratio < RECOMMENDATION_THRESHOLD_LOW:
        return "keep-both-strong-evidence"
    return "keep-both"


def write_report(data: RetrospectiveData, output_path: Path) -> None:
    """Render a markdown report at ``output_path``.

    Creates parent directories if absent. The rendered document always
    contains the same H2 sections (Status, Layer counts, Overlap,
    Interpretation, Data sources) so automated consumers can locate
    them reliably; only the Interpretation prose varies by
    recommendation branch.
    """
    recommendation = build_recommendation(data)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    lines = [
        f"# D4 Defense-in-Depth Retrospective -- {today}",
        "",
        "## Status",
        "",
        f"- Recommendation: **{recommendation}**",
        f"- Window: {data.window_start} -> {data.window_end}",
        f"- Insufficient evidence: {data.insufficient_evidence}",
        "",
        "## Layer counts",
        "",
        "| Scope | Total DENY findings | Distinct (workflow_id, reason) tuples |",
        "|---|---|---|",
        (
            f"| worker-pre-filter (US-ARB-015) | {data.pre_filter_count} | "
            f"{len(data.distinct_pre_filter)} |"
        ),
        (
            f"| worker-tool-handler (US-ARB-012) | {data.tool_handler_count} | "
            f"{len(data.distinct_tool_handler)} |"
        ),
        "",
        "## Overlap",
        "",
        f"- Overlap count: {len(data.overlap)}",
        f"- Overlap ratio (overlap / max(distinct)): {data.overlap_ratio:.2%}",
        "",
        "## Interpretation",
        "",
    ]

    if recommendation == "deferred-90d":
        lines.append(
            "Fewer than 1 worker-tool-handler finding observed in the last "
            f"{INSUFFICIENT_EVIDENCE_DAYS} days. Defer retrospective to day 90 -- "
            "the tool-handler layer may not yet be wired into dispatch, or "
            "traffic is too low to draw conclusions."
        )
    elif recommendation == "re-debate":
        lines.append(
            f"Overlap is {data.overlap_ratio:.2%} (> 90%). The two layers are "
            "catching substantially the same (workflow_id, reason) tuples. "
            "Open a re-debate ticket to decide whether one layer can be retired "
            "without loss of defense."
        )
    elif recommendation == "keep-both-strong-evidence":
        lines.append(
            f"Overlap is {data.overlap_ratio:.2%} (< 20%). Strong evidence the "
            "two layers catch DISTINCT classes of violations. QD-5 invariant "
            "validated; keep both."
        )
    else:
        lines.append(
            f"Overlap is {data.overlap_ratio:.2%} (between 20%-90%). The two "
            "layers catch overlapping but not redundant sets. Keep both."
        )

    lines.extend(
        [
            "",
            "## Data sources",
            "",
            "- Governance ledger table: GOVERNANCE_LEDGER_TABLE env var",
            "- Scope filter: scope_evaluated in {worker-pre-filter, worker-tool-handler}",
            "- Decision filter: decision == \"deny\"",
            "",
            "---",
            "",
            f"Generated {today} by arbiter/governance/d4_retrospective.py",
        ]
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(lines))


def main(argv: list[str] | None = None) -> int:
    """CLI entry point.

    Returns a POSIX-style exit code (0 on success, non-zero on argparse
    failure). Even the ``deferred-90d`` branch exits 0 -- insufficient
    evidence is an expected outcome-gated state, not an error.
    """
    parser = argparse.ArgumentParser(prog="d4-retrospective")
    parser.add_argument("--window-days", type=int, default=30)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)

    data = scan_findings(window_days=args.window_days)
    write_report(data, args.output)
    recommendation = build_recommendation(data)
    print(
        json.dumps(
            {
                "status": "ok",
                "recommendation": recommendation,
                "output_path": str(args.output),
                "overlap_ratio": data.overlap_ratio,
                "pre_filter_count": data.pre_filter_count,
                "tool_handler_count": data.tool_handler_count,
            }
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
