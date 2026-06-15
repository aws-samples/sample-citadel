"""Fabricator design-assessment precondition (US-ARB-017).

Refuse fabrication when the target projectId has no completed
AgentDesignAssessment row (gov writes these rows). Composes
with US-ARB-010 quarantine: BOTH gates must pass before an agent is
fabricated — this gate runs FIRST, quarantine runs at store-time.

Forward-compatible design: when projectId is None (today's reality
since Citadel has no Project↔App linkage), the gate is a no-op. When
projectId is present (future), it queries the assessments table and
either permits or raises DesignAssessmentMissingError.

Grandfathering bypass: when grandfathered=True, the gate is skipped
regardless of assessment status. The caller is responsible for
resolving grandfathering upstream (it's a TypeScript helper — see
backend/src/utils/is-grandfathered.ts). Fabricator does NOT compute
grandfathering locally.

Spec: arbiter-governance-engine/requirements.md ARB-017 enrichment
(QE-1 resolution + gov-track coordination).
Plan: US-ARB-017 Δ7. PR label: needs-arbiter-review per QT4-10.
"""

from __future__ import annotations

import logging
import os

import boto3

logger = logging.getLogger(__name__)

class DesignAssessmentMissingError(Exception):
    """Raised when fabrication is attempted for a projectId that has no
    completed AgentDesignAssessment row. HTTP 412 Precondition Failed
    semantics when surfaced through an HTTP resolver.
    """

_dynamodb = None

def _get_table():
    global _dynamodb
    # Check env var FIRST so env-unset is a pure no-op with zero AWS
    # calls (QB-013-1). Constructing boto3.resource('dynamodb') triggers
    # credential resolution, which fails in credential-less test envs.
    table_name = os.environ.get('AGENT_DESIGN_ASSESSMENTS_TABLE')
    if not table_name:
        return None # env unset; caller decides fallback behaviour
    if _dynamodb is None:
        _dynamodb = boto3.resource('dynamodb')
    return _dynamodb.Table(table_name)

def __reset_clients_for_test():
    """Reset cached boto3 clients. Test-only helper (QB-013-1)."""
    global _dynamodb
    _dynamodb = None

def check_design_assessment(
    project_id: str | None,
    *,
    grandfathered: bool = False,
) -> None:
    """Precondition check. Returns None on pass; raises on fail.

    No-op cases (returns None silently):
      - project_id is None or empty string (today's path; no Project↔App
        linkage exists so fabricator events don't carry projectId)
      - grandfathered is True (upstream resolved the bypass)
      - AGENT_DESIGN_ASSESSMENTS_TABLE env var is unset (table not
        provisioned; degraded-mode fallback)

    Fail case (raises DesignAssessmentMissingError):
      - project_id is present AND not grandfathered AND the DDB row is
        missing OR row.completedAt is falsy
    """
    if not project_id:
        logger.debug('design-assessment gate: no project_id provided, skipping')
        return
    if grandfathered:
        logger.info(
            'design-assessment gate: bypassed for project_id=%s (grandfathered)',
            project_id,
        )
        return

    table = _get_table()
    if table is None:
        logger.warning(
            'design-assessment gate: AGENT_DESIGN_ASSESSMENTS_TABLE unset; '
            'skipping gate for project_id=%s',
            project_id,
        )
        return

    response = table.get_item(Key={'projectId': project_id})
    item = response.get('Item')
    if not item:
        raise DesignAssessmentMissingError(
            f'No AgentDesignAssessment row found for projectId={project_id!r}. '
            f'Fabrication requires a completed design assessment (gov).'
        )
    if not item.get('completedAt'):
        raise DesignAssessmentMissingError(
            f'AgentDesignAssessment for projectId={project_id!r} exists but is '
            f'not marked completed. Fabrication requires completedAt to be set.'
        )
    logger.info(
        'design-assessment gate: passed for project_id=%s (completed_at=%s)',
        project_id, item.get('completedAt'),
    )
