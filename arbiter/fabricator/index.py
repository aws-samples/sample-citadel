if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()

import json
import logging
from datetime import datetime, timezone
from typing import Any
from strands import Agent, tool, models
import os
from tools_config import (
    load_config_from_dynamodb,
    create_tool_desc,
    FabricationError,
    is_code_generating,
    validate_code_tool_binding,
    assert_spec_approved,
)
from design_assessment_gate import check_design_assessment, DesignAssessmentMissingError
from manifest_proposal import (
    propose_agent_manifest,
    sanitize_text,
)
from transient_retry import (
    call_with_transient_retry,
    user_actionable_failure_message,
)
from deadline import (
    FabricationDeadline,
    FabricationDeadlineExceeded,
    clear_fabrication_deadline,
    registration_checkpoint,
    set_fabrication_deadline,
    timed_out_failure_message,
)
from fabrication_context import (
    fabrication_job_id,
    fabrication_org_id,
    fabrication_tool_keys,
    lookup_tool_key,
    record_tool_key,
)
from registry_recovery import (
    OrphanedRegistryRecordError,
    is_creating_conflict,
    recover_creating_record,
)
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from common.region import cross_region_prefix
from model_config_loader import load_model_id

_REGION = os.environ.get('AWS_REGION', 'us-west-2')
_MODEL_PREFIX = cross_region_prefix(_REGION)
# Configurable model selection: resolve the fabricator's model from the
# platform model-config + catalog tables via the shared pure resolver,
# falling back to the previous default on any miss.
FABRICATOR_MODEL_ID = load_model_id(
    region=_REGION,
    fallback_model_id=f"{_MODEL_PREFIX}.anthropic.claude-sonnet-4-6",
)

# CIT-125 slice B: shared idempotency table (backend-stack.ts:178-ish,
# `citadel-idempotency-${env}`, PK `eventId`, TTL attr `ttl`), referenced by
# NAME (Table.fromTableName in arbiter-stack.ts) — no new table. DEVIATION
# from the design's literal "event.id" framing: the fabricator queue has no
# EventBridge envelope (fabricator-request-resolver.ts / agent-import-
# resolver.ts both SendMessageCommand directly with a hand-built JSON body,
# no `id`/`detail` field). The dedupe key used here is the SQS `messageId`
# instead — stable across at-least-once SQS redelivery and across a DLQ
# redrive, which is the same guarantee the design relies on for the EB id.
IDEMPOTENCY_TABLE = os.environ.get('IDEMPOTENCY_TABLE')
IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60

logger = logging.getLogger(__name__)


_registry_client = None


def _get_registry_client():
    """Lazy boto3 client for agent-registry-control Registry APIs.

    QB-013-1 pattern: construct at first call so module import is cheap.
    """
    global _registry_client
    if _registry_client is None:
        _registry_client = boto3.client('agent-registry-control')
    return _registry_client


def _reset_registry_client_for_test() -> None:
    """Test-only hook — forces the next call to rebuild the cached client."""
    global _registry_client
    _registry_client = None


class _RegistrationRunState:
    """Per-SQS-record registration bookkeeping (kill→poison→kill fix).

    Live evidence 2026-07-23: the fabricator LLM retried a terminally
    failing store_tool_config_registry 92-110× per run (~825-834s of the
    900s budget) and tool.fabrication.failed was published 45-53× per run
    for the SAME failing condition.

    - ``latched`` maps tool_id → terminal message: once a registration
      fails NON-RETRYABLY (orphaned CREATING record), repeat calls for that
      tool_id fail INSTANTLY — no registry API traffic, no fresh events —
      so an uncooperative LLM retry costs microseconds, not minutes.
    - ``published`` dedupes tool.fabrication.failed to ONE event per
      (tool_id, error type) per run — once per tool failure, never once per
      retry iteration.
    - ``succeeded`` is the set of tool_ids that completed registration this
      run — used to distinguish "all failed" from "partial" when the run
      terminates.
    - ``failed`` maps tool_id -> short error string for EVERY registration
      failure this run (a superset of ``latched``, which only tracks the
      NON-RETRYABLE orphaned-record case) — threaded into the job status
      row as the additive ``registrationErrors`` attribute so a run that
      completes with some or all tool registrations failing is never
      reported as a bare, silent COMPLETED.

    Scoped to a run on purpose: process_event begins/ends it around each
    SQS record (Lambda containers are REUSED, so module state must never
    leak between runs), and DIRECT calls outside a run keep the legacy
    publish-every-time behavior.
    """

    def __init__(self):
        self.latched = {}
        self.published = set()
        self.succeeded = set()
        self.failed = {}
        self.pending_approval = set()
        # Maps agent_use_id -> (registry_record_id, registry_name) so the
        # COMPLETED status write can stamp the exact record coordinates onto
        # the job row — postfab resolves by record id (one call, exact)
        # instead of passing the display name through the name filter
        # (which rejects special characters).
        self.agent_record_info: dict[str, tuple[str, str]] = {}


_registration_run_state = None


def _begin_registration_run() -> None:
    """Start fresh per-run registration bookkeeping (one SQS record)."""
    global _registration_run_state
    _registration_run_state = _RegistrationRunState()


def _end_registration_run() -> None:
    """Drop the per-run registration bookkeeping."""
    global _registration_run_state
    _registration_run_state = None


def _find_existing_record_id(
    registry_id: str, agent_id: str, org_id: str = ""
) -> str | None:
    """Return the recordId of an existing Registry record named ``agent_id``.

    Idempotency support for ``store_agent_config_registry``: SQS redeliveries
    and re-triggers must not create duplicate Registry records for the same
    agent name. Mirrors ``resolveRecordId`` / ``listResources`` in
    ``backend/src/services/registry-service.ts`` — list CUSTOM records and
    match on the record name. Uses the server-side ``name`` filter to bound
    the result set, then verifies an EXACT name match (the filter may be a
    prefix / substring match) and paginates via ``nextToken``.

    Org-scoped idempotency (§2.2-C): when ``org_id`` is non-empty, a
    candidate record is only considered a match when its custom_metadata
    ``orgId`` equals ``org_id``.  This allows same-named records across
    different organisations — org-A's "SalesBot" is invisible to org-B's
    idempotency lookup.  If the registry returns multiple same-name records,
    we pick the one whose ``orgId`` matches the caller.

    Returns the matched recordId, or ``None`` when no record with that exact
    name exists. Defensive ``isinstance`` guards keep the loop bounded if the
    API surfaces an unexpected (non-dict) shape so the caller falls back to
    the create path rather than hanging or raising.
    """
    client = _get_registry_client()
    next_token = None
    while True:
        kwargs: dict[str, Any] = {
            "registryId": registry_id,
            "filters": [
                {"name": "recordType", "values": ["CUSTOM"]},
                {"name": "name", "values": [agent_id]},
            ],
            "maxResults": 100,
        }
        if next_token:
            kwargs["nextToken"] = next_token
        response = client.list_registry_records(**kwargs)
        if not isinstance(response, dict):
            return None
        # Live-oracle-verified (2026-08-02): ListRegistryRecords' real
        # top-level key is `registryRecords` (confirmed via a direct live
        # call — the first pass using `records` returned 0 hits over 21
        # pages against a 1,009-record registry). Mirrors
        # service/agent_intake_single/tools/fabricate.py:340's
        # registryRecords-with-records-fallback for defensive parity with
        # older/local stubs that may still use the legacy key.
        summaries = response.get("registryRecords")
        if summaries is None:
            summaries = response.get("records", [])
        for summary in summaries:
            if not isinstance(summary, dict):
                continue
            if summary.get("displayName", summary.get("name")) != agent_id:
                continue
            # Org-scoped idempotency (§2.2-C): read the orgId from the
            # record's custom descriptor metadata and compare with the
            # caller's org. A record belonging to a different org is
            # NOT FOUND from this caller's perspective.
            if org_id:
                record_org = _extract_org_from_summary(summary)
                if record_org != org_id:
                    continue
            return summary.get("recordId")
        next_token = response.get("nextToken")
        if not isinstance(next_token, str) or not next_token:
            break
    return None


def _extract_org_from_summary(summary: dict) -> str:
    """Best-effort extraction of orgId from a registry record summary.

    The orgId lives inside ``descriptors.custom.data`` (a JSON string) under
    the key ``orgId``.  ListRegistryRecords MAY return the descriptors on the
    summary or may not — when absent, return ``""`` (the system/shared
    convention) so the caller degrades gracefully.
    """
    try:
        descriptors = summary.get("descriptors") or {}
        custom = descriptors.get("custom") or {}
        data_str = custom.get("data", "")
        if data_str and isinstance(data_str, str):
            data = json.loads(data_str)
            return data.get("orgId", "")
    except (json.JSONDecodeError, AttributeError, TypeError):
        pass
    return ""


def _write_app_meta_row(
    record_id: str,
    agent_id: str,
    agent_description: str,
    requested_by: str,
    org_id: str,
) -> bool:
    """Write the AppsTable #META row for a freshly-created Registry agent record.

    Mirrors backend/src/utils/apps-table-meta.ts upsertAppMeta. Eventually-consistent:
    failures log and return False. A separate scheduled reconciler
    (backend/scripts/reconcile-apps-meta.ts, run every 6 hours per
    backend-stack.ts) walks the Registry and mirrors any #META row it finds
    missing via the SAME upsertAppMeta helper — but only when it can derive a
    non-empty orgId from the Registry record. It cannot recover THIS
    function's org_id-empty case: orgId is the partition key of AppsTable's
    OrgIndex GSI (backend-stack.ts, `partitionKey: {name: "orgId", ...}`),
    and DynamoDB unconditionally rejects an empty-string value for any GSI
    key attribute with ValidationException — the reconciler's own
    upsertAppMeta call would hit the identical rejection, since its orgId
    projection is read from this same Registry record's stamped orgId
    (custom_metadata['orgId'], also sourced from org_id). So an org_id-empty
    write is skipped explicitly below rather than attempted and swallowed.

    Args:
        record_id: Registry recordId returned by create_registry_record (12-char alphanumeric).
        agent_id: Caller-supplied agent name (used as #META row name field).
        agent_description: Plain-text human description.
        requested_by: AppSync caller identity threaded from the SQS event, or 'fabricator'.
        org_id: Caller's org from the JWT claim, or '' for transition window.

    Returns:
        True on success, False when skipped (APPS_TABLE unset, or org_id
        empty) or on any failure (logged).
    """
    apps_table = os.environ.get('APPS_TABLE')
    if not apps_table:
        logger.warning('_write_app_meta_row: APPS_TABLE env var not set; skipping')
        return False
    if not org_id:
        # Guaranteed ValidationException, not a transient/eventually-
        # consistent failure: orgId is the OrgIndex GSI partition key, and
        # DynamoDB rejects an empty-string value for any GSI key attribute
        # on every attempt — retrying or waiting for the reconciler cannot
        # help (see docstring). Skip explicitly rather than swallow the
        # guaranteed exception. Direct-SQS fabrication requests lack org_id
        # today; the intake product path normally populates it.
        logger.info(
            '_write_app_meta_row: org_id empty for agent_id=%s; skipping '
            '#META write (orgId is the OrgIndex GSI partition key and '
            'cannot be an empty string — not reconciler-recoverable)',
            agent_id,
        )
        return False
    now = datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')
    try:
        boto3.client('dynamodb').update_item(
            TableName=apps_table,
            Key={'appId': {'S': record_id}},
            UpdateExpression=(
                'SET #orgId = :orgId, #name = :name, #description = :description, '
                '#status = :status, #workflowIds = :workflowIds, '
                '#routingConfig = :routingConfig, #createdBy = :createdBy, '
                '#createdAt = :createdAt, #updatedAt = :updatedAt, '
                '#version = :version, #sortId = :sortId'
            ),
            ExpressionAttributeNames={
                '#orgId': 'orgId',
                '#name': 'name',
                '#description': 'description',
                '#status': 'status',
                '#workflowIds': 'workflowIds',
                '#routingConfig': 'routingConfig',
                '#createdBy': 'createdBy',
                '#createdAt': 'createdAt',
                '#updatedAt': 'updatedAt',
                '#version': 'version',
                '#sortId': 'sortId',
            },
            ExpressionAttributeValues={
                ':orgId': {'S': org_id or ''},
                ':name': {'S': agent_id or ''},
                ':description': {'S': agent_description or ''},
                ':status': {'S': 'DRAFT'},
                ':workflowIds': {'L': []},
                ':routingConfig': {'S': ''},
                ':createdBy': {'S': requested_by or 'fabricator'},
                ':createdAt': {'S': now},
                ':updatedAt': {'S': now},
                ':version': {'N': '1'},
                ':sortId': {'S': 'METADATA'},
            },
        )
        return True
    except Exception as e:  # noqa: BLE001 — eventually-consistent: never propagate
        logger.warning(
            f'_write_app_meta_row failed (eventually-consistent, reconciler will recover): {e}'
        )
        return False

# ~7 day TTL (epoch seconds) keeps the fabrication-jobs table self-pruning.
FABRICATION_JOBS_TTL_SECONDS = 7 * 24 * 60 * 60


def _write_fabrication_status(
    orchestration_id: str,
    agent_use_id: str,
    status: str,
    agent_id: str | None = None,
    error_message: str | None = None,
    agent_name: str | None = None,
    registration_errors: list | None = None,
    org_id: str | None = None,
    registry_approval_status: str | None = None,
    registry_record_id: str | None = None,
    registry_name: str | None = None,
) -> bool:
    """Upsert a per-agent fabrication status row in the durable jobs table.

    Mirrors the ingestion jobs-table pattern: the table
    (``citadel-fabrication-jobs-${env}``) is keyed by orchestrationId (PK) /
    agentUseId (SK). process_event calls this at the START (PROCESSING), on
    SUCCESS (COMPLETED + agentId) and on EXCEPTION (FAILED + errorMessage).

    ``org_id`` (Phase 2b / cross-tenant exposure fix, design evidence
    bf4a13f2): the caller's organization, stamped onto the row so the
    org-scoped getFabricatorQueue GSI query can find it. Written with
    ``if_not_exists`` semantics — same rationale as ``agentName`` below — so
    this arbiter write never clobbers an orgId a producer (direct-UI PENDING
    write) already stamped on the row. Omitted entirely when empty/None
    rather than writing a blank string, so an unresolvable org reads as
    absent, not as a false empty-string match against a caller with no org.

    ``registration_errors`` is an ADDITIVE attribute (no new status enum
    value — the 4-value {PENDING, PROCESSING, COMPLETED, FAILED} contract is
    a hard constraint of downstream consumers, see queue resolver / intake
    terminal-status checks): a list of ``{"toolId": ..., "error": ...}``
    dicts describing tool registrations that failed during the run. Written
    whenever a run had any registration failures (partial COMPLETED or
    all-failed FAILED); omitted (never a bare empty list) when there were
    none, so existing bare-COMPLETED consumers see no shape change.

    Backward-compatible and best-effort: when ``FABRICATION_JOBS_TABLE`` is
    unset the write is skipped (logged); any failure is logged and swallowed
    so a status-write error NEVER changes fabrication success/failure
    behavior. Never an empty except.

    Returns True on a successful write, False when skipped or on failure.
    """
    table = os.environ.get("FABRICATION_JOBS_TABLE")
    if not table:
        # orchestration_id/agent_use_id omitted: event-derived identifiers
        # CodeQL taints as secret-conflated. status is a fixed lifecycle label
        # and safe to log.
        logger.info(
            "_write_fabrication_status: FABRICATION_JOBS_TABLE unset; "
            "skipping status=%s (orchestration/agentUse ids redacted)",
            status,
        )
        return False

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    set_parts = ["#status = :status", "#updatedAt = :updatedAt", "#ttl = :ttl"]
    remove_parts: list[str] = []
    names = {"#status": "status", "#updatedAt": "updatedAt", "#ttl": "ttl"}
    import time as _time
    values: dict[str, Any] = {
        ":status": {"S": status},
        ":updatedAt": {"S": now},
        ":ttl": {"N": str(int(_time.time()) + FABRICATION_JOBS_TTL_SECONDS)},
    }
    # submittedAt semantics (kept minimal, no new attribute): if_not_exists
    # means the FIRST write to a row (usually the PENDING/PROCESSING write)
    # stamps the true original submit time, and every later write — including
    # a later attempt's retry after a prior FAILED — preserves it rather than
    # resetting it. That's correct: a retry re-attempts the same submitted
    # request, it isn't a new submission. No separate attemptedAt is added
    # here because no cited reader (fabricate.py's polling/staleness checks,
    # the queue resolver, or postfab.py) distinguishes "first submitted" from
    # "most recently attempted" — updatedAt already serves that purpose.
    set_parts.append("submittedAt = if_not_exists(submittedAt, :submittedAt)")
    values[":submittedAt"] = {"S": now}
    # agentName: thread the human-readable name (== agent_use_id for intake)
    # so the resolver can render it instead of 'Unknown Agent'. if_not_exists
    # never clobbers a producer-set name (the UI-direct path's PENDING row).
    if agent_name is not None:
        set_parts.append("agentName = if_not_exists(agentName, :agentName)")
        values[":agentName"] = {"S": agent_name}
    if agent_id is not None:
        set_parts.append("#agentId = :agentId")
        names["#agentId"] = "agentId"
        values[":agentId"] = {"S": agent_id}
    if org_id:
        # if_not_exists: never clobber a producer-set orgId (e.g. the
        # direct-UI PENDING write) — see docstring.
        set_parts.append("orgId = if_not_exists(orgId, :orgId)")
        values[":orgId"] = {"S": org_id}
    if error_message is not None:
        set_parts.append("#errorMessage = :errorMessage")
        names["#errorMessage"] = "errorMessage"
        values[":errorMessage"] = {"S": error_message[:1000]}
    else:
        # Terminal write with a clean run: this attempt superseded any prior
        # attempt's errorMessage (e.g. a FAILED 08-01 row later completing
        # cleanly on 08-02). REMOVE rather than leave the stale value, or a
        # consumer reading a COMPLETED row can mistake it for a partial
        # failure that happened THIS run. Only meaningful on terminal
        # statuses — remove is a no-op if the attribute was never set.
        if status in ("COMPLETED", "FAILED"):
            names["#errorMessage"] = "errorMessage"
            remove_parts.append("#errorMessage")
    if registration_errors:
        set_parts.append("#registrationErrors = :registrationErrors")
        names["#registrationErrors"] = "registrationErrors"
        values[":registrationErrors"] = {
            "L": [
                {
                    "M": {
                        "toolId": {"S": str(item.get("toolId", ""))},
                        "error": {"S": str(item.get("error", ""))[:500]},
                    }
                }
                for item in registration_errors
            ]
        }
    elif status in ("COMPLETED", "FAILED"):
        # Same rationale as errorMessage above: a terminal write with ZERO
        # registration failures this run must clear any registrationErrors
        # left by an earlier failed/partial attempt, or a bare success can
        # be misread as a partial-failure completion (the ambiguity
        # registrationErrors was added to eliminate).
        names["#registrationErrors"] = "registrationErrors"
        remove_parts.append("#registrationErrors")

    if registry_approval_status:
        set_parts.append("#registryApprovalStatus = :registryApprovalStatus")
        names["#registryApprovalStatus"] = "registryApprovalStatus"
        values[":registryApprovalStatus"] = {"S": registry_approval_status}

    if registry_record_id:
        set_parts.append("#registryRecordId = :registryRecordId")
        names["#registryRecordId"] = "registryRecordId"
        values[":registryRecordId"] = {"S": registry_record_id}

    if registry_name:
        set_parts.append("#registryName = :registryName")
        names["#registryName"] = "registryName"
        values[":registryName"] = {"S": registry_name}

    update_expression = "SET " + ", ".join(set_parts)
    if remove_parts:
        update_expression += " REMOVE " + ", ".join(remove_parts)

    try:
        boto3.client("dynamodb").update_item(
            TableName=table,
            Key={
                "orchestrationId": {"S": orchestration_id},
                "agentUseId": {"S": agent_use_id},
            },
            UpdateExpression=update_expression,
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )
        return True
    except Exception as e:  # noqa: BLE001 — best-effort: never change outcome
        # Redact event-derived ids and the exception message (may echo request
        # values); log the exception class only. status is a fixed label.
        logger.warning(
            "_write_fabrication_status failed (status=%s): %s",
            status, type(e).__name__,
        )
        return False


# Retry configuration for Bedrock API calls — exponential backoff with jitter
BEDROCK_RETRY_CONFIG = Config(
    retries={
        'max_attempts': 3,
        'mode': 'adaptive',  # adaptive mode uses exponential backoff with jitter
    },
    read_timeout=3600,
)

def get_tool_fabricator_prompt():
    """System prompt for the Tool Fabricator agent"""
    TOOL_FABRICATOR_PROMPT = """
    <role>
    You are the Tool Fabricator Agent. Your sole responsibility is to generate custom Python tool functions using the @tool decorator from the Strands SDK and persist them to storage.
    </role>

    <mandatory_tool_structure>
    Every tool you create MUST follow this pattern:

    from strands import tool

    @tool
    def tool_name(param: type) -> return_type:
        \"""Clear description of what the tool does.
        
        Args:
            param: Description of parameter
            
        Returns:
            Description of return value
        \"""
        # Implementation here
        return result

    <rules>
    - Tool function MUST use @tool decorator
    - MUST have clear docstring with Args and Returns sections
    - MUST have type hints
    - NO tests, NO example usage code
    - Keep implementation simple and focused
    - Use standard library when possible
    - NO external API calls unless absolutely necessary
    </rules>
    </mandatory_tool_structure>

    <critical_workflow>
    For EVERY tool request, you MUST execute ALL FOUR steps using your available tools:
    
    STEP 1: Design the tool mentally (determine name, parameters, return type, implementation)
    
    STEP 2: Call write_job_file tool to save it to /tmp/[tool_name].py
    
    STEP 3: Call upload_tool_to_s3 tool with the file path
    
    STEP 4: Call store_tool_config_registry tool with:
       - file_name: "/tmp/[tool_name].py"
       - tool_id: the tool function name (e.g., "calculate_percentage")
       - tool_schema: OpenAPI-compliant JSON schema like:
         {
           "type": "object",
           "properties": {
             "param_name": {
               "type": "string",
               "description": "Parameter description"
             }
           },
           "required": ["param_name"]
         }
       - tool_description: brief one-sentence description
    
    CRITICAL: The tool is NOT registered in AgentCore Registry and CANNOT be used until store_tool_config_registry is called.
    If you skip this step, the tool will be lost and unusable.
    
    YOU MUST ACTUALLY CALL ALL THREE TOOLS (write_job_file, upload_tool_to_s3, store_tool_config_registry) IN SEQUENCE. Do not just describe what you would do.
    After calling each tool, verify it succeeded before moving to the next step.
    </critical_workflow>

    <example_execution>
    User request: "Create a tool that validates email addresses"
    
    Your actions (YOU MUST DO ALL OF THESE IN ORDER):
    
    Step 1 - Design the tool:
    - Tool name: validate_email
    - Parameters: email (string)
    - Returns: boolean
    
    Step 2 - Generate the complete tool code as a string
    
    Step 3 - CALL write_job_file tool (REQUIRED):
    write_job_file(
        file_name="validate_email.py",
        content='''from strands import tool

    @tool
    def validate_email(email: str) -> bool:
        \"""Validate if a string is a valid email address.
        
        Args:
            email: Email address to validate
            
        Returns:
            True if valid email, False otherwise
        \"""
        import re
        pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$'
        return bool(re.match(pattern, email))
    '''
        )
        ✓ Step 3 complete - file written
        
        Step 4 - CALL upload_tool_to_s3 tool (REQUIRED):
        upload_tool_to_s3(file_path="/tmp/validate_email.py")
        ✓ Step 4 complete - file uploaded to S3 (key is recorded automatically for later retrieval)
        
        Step 5 - CALL store_tool_config_registry tool (REQUIRED - MOST CRITICAL STEP):
        store_tool_config_registry(
            file_name="/tmp/validate_email.py",
            tool_id="validate_email",
            tool_schema={
                "type": "object",
                "properties": {
                    "email": {
                        "type": "string",
                        "description": "Email address to validate"
                    }
                },
                "required": ["email"]
            },
            tool_description="Validates if a string is a valid email address"
        )
        ✓ Step 5 complete - tool registered in Registry
        
        Step 6 - Verify all three tools were called:
        ✓ write_job_file - YES
        ✓ upload_tool_to_s3 - YES  
        ✓ store_tool_config_registry - YES
        
        ✅ TOOL CREATION COMPLETE - Tool is now submitted for approval and will appear on the Approvals page.
        New tools follow the registry lifecycle: DRAFT → PENDING_APPROVAL → APPROVED (by review or auto-approval).
        The tool becomes discoverable and usable by other agents once approved.
        
        CRITICAL: You must call ALL THREE tools (write_job_file, upload_tool_to_s3, store_tool_config_registry) for every tool creation request.
        If you skip store_tool_config_registry, the tool will be created but NOT registered, making it invisible to the system.

        FAILURE HANDLING (NON-NEGOTIABLE): if store_tool_config_registry fails
        with a NON-RETRYABLE error (OrphanedRegistryRecordError, or any error
        message containing "NON-RETRYABLE" or "DO NOT retry"), you MUST NOT
        call store_tool_config_registry again for that tool_id — retrying
        cannot succeed and wastes the execution budget. Do not sleep, poll,
        or use http_request delays as backoff. Report the failure text for
        that tool and continue with your remaining work.
        </example_execution>

        <tool_code_example>
        from strands import tool

        @tool
        def calculate_percentage(value: float, total: float) -> float:
            \"""Calculate the percentage of a value relative to a total.
            
            Args:
                value: The value to calculate percentage for
                total: The total value to compare against
                
            Returns:
                The percentage as a float
            \"""
            if total == 0:
                return 0.0
            return (value / total) * 100.0
        </tool_code_example>

        <reminder>
        ⚠️ MANDATORY: You have THREE tools that MUST ALL be called for EVERY tool creation ⚠️
        
        1. write_job_file - Save the tool code to /tmp/[tool_name].py
        2. upload_tool_to_s3 - Upload the file to S3 storage
        3. store_tool_config_registry - Register the tool in AgentCore Registry
        
        ❌ FAILURE MODE: If you only call write_job_file and upload_tool_to_s3 but skip store_tool_config_registry,
        the tool will NOT be registered in the Registry and CANNOT be discovered or used by other agents.
        
        ✅ SUCCESS CRITERIA: The tool creation is ONLY complete when ALL THREE tools have been called successfully.
        The tool is created as a DRAFT and submitted for approval — it becomes usable once the registry approves it
        (automatically if auto-approval is configured, or after manual review).
        
        Do not just return text describing what you did - you must ACTUALLY CALL all three tools.
        After each tool call, verify it succeeded before proceeding to the next step.
        
        VERIFICATION CHECKLIST:
        □ Called write_job_file with tool code
        □ Called upload_tool_to_s3 with file path
        □ Called store_tool_config_registry with tool_id, schema, and description
        
        Only after all three checkboxes are complete is the tool ready for use.
        </reminder>

        <binding_aware_tool_generation>
        When the tool request includes binding metadata (integration or data store bindings),
        you MUST generate code that uses scoped credentials from environment variables.

        For DATA STORE bindings:
        - The tool will run in a subprocess with scoped AWS credentials injected as environment variables.
        - Use the appropriate AWS SDK client for the data store type (e.g., boto3 DynamoDB client for DYNAMODB, S3 client for S3).
        - Do NOT hardcode credentials — use the default boto3 credential chain which picks up the scoped env vars.
        - Implement only the operations specified in the binding (e.g., get_item, query for DYNAMODB).

        For INTEGRATION bindings:
        - The tool will run with scoped credentials that allow access to the integration's secrets.
        - Retrieve integration credentials from AWS Secrets Manager or SSM Parameter Store using the scoped credentials.
        - Implement HTTP calls with proper authentication based on the integration's auth method:
          * API_KEY: Include the key as a header or query parameter
          * OAUTH2: Use Bearer token in Authorization header
          * BASIC_AUTH: Use base64-encoded credentials in Authorization header
          * BEARER_TOKEN: Use token in Authorization header
          * IAM_ROLE: Use SigV4 signing for AWS service calls

        When calling store_tool_config_registry, pass the binding metadata:
        - integration_bindings: list of integration binding dicts from the request
        - datastore_bindings: list of data store binding dicts from the request
        </binding_aware_tool_generation>
    """
    return TOOL_FABRICATOR_PROMPT

def get_agent_fabricator_prompt(org_id: str = ""):
    """System prompt for the Agent Fabricator agent"""
    tool_configs = load_config_from_dynamodb(org_id=org_id)
    worker_tools_list = '\n'.join(create_tool_desc(tool_configs))

    AGENT_FABRICATOR_PROMPT = f"""
    <role>
    You are the Fabricator Agent in a multi-agent system. Your sole responsibility is to generate Python code for new Strands agents that execute tasks defined by a Supervisor Agent. You do not execute tasks—you create the agents that will.
    </role>

    <architecture>
    Supervisor → requests new agent capability
    ↓
    Fabricator (YOU) → generates agent code
    ↓
    Evaluator → validates compliance before deployment
    </architecture>

    <mandatory_code_structure>
    Every agent you create MUST follow the code template.
    the agent will be called by the supervisor by using the "handler" function.
    if you call the main entry point anything other than "handler" it will not execute.

    <code_template>
    from strands import Agent, models

    def handler(input_param):
        \"""Clear docstring: purpose, inputs, outputs, constraints\"""
        bedrock_model = models.BedrockModel(
            model_id=FABRICATOR_MODEL_ID,
            region_name="us-west-2"
        )
        agent = Agent(bedrock_model, tools=[...])
        result = agent("task prompt")
        return result
    </code_template>

    <non_negotiable_rules>
    - Function MUST be named `handler`
    - MUST use `models.BedrockModel` from strands package
    - MUST be a single, importable Python file
    - MUST include module-level docstring
    - NO tests, NO UI, NO user interaction code
    </non_negotiable_rules>
    </mandatory_code_structure>

    <tool_selection_hierarchy>
    Follow this priority when choosing tools:

    <priority_1_strands_builtin_tools>
    Use these first if they meet the requirement:
    - file_read, file_write, editor - File operations
    - shell - OS commands
    - http_request - API calls
    - python_repl - Python code execution
    - calculator - Math operations
    - use_aws - AWS services
    - retrieve - Bedrock Knowledge Base
    - memory, mem0_memory, environment - Persistent storage
    - journal, speak - Logging/output
    - generate_image, image_reader - Image operations
    - think - Complex reasoning
    - current_time, sleep, stop - Utilities
    - swarm, workflow, batch - Orchestration
    - use_llm - customized system prompts for specialized tasks
    </priority_1_strands_builtin_tools>

    <priority_2_worker_tools>
    If no Strands tool fits, check Worker Tools List:
    {worker_tools_list}

    Read the function code and write it into the agent as shown in examples below.
    </priority_2_worker_tools>

    <priority_3_custom_tools>
    Only create custom tools if Priorities 1 and 2 cannot satisfy the requirement.

    IMPORTANT: DO NOT write custom tool code yourself. Instead, use the create_custom_tool function:
    1. Call create_custom_tool with a detailed description of what the tool should do
    2. The Tool Fabricator will generate the tool code for you
    3. Extract the tool function code from the response
    4. Include the tool code directly in your agent file

    Example usage:
    tool_code = create_custom_tool("Create a tool that validates email addresses and returns True if valid, False otherwise")
    # Then include the returned tool code in your agent
    </priority_3_custom_tools>
    </tool_selection_hierarchy>

    <agent_with_custom_tool_pattern>
    When you need a custom tool, request it from the Tool Fabricator and include the generated code:

    <workflow>
    1. Identify that you need a custom tool
    2. Call create_custom_tool("description of what the tool should do")
    3. Parse the tool code from the Tool Fabricator's response
    4. Include the tool code in your agent file
    5. Use the tool in your agent
    </workflow>

    <example>
    from strands import Agent, tool, models

    # Tool code generated by Tool Fabricator (included directly in agent file)
    @tool
    def validate_email(email: str) -> bool:
        \"""Validate if a string is a valid email address.
        
        Args:
            email: Email address to validate
            
        Returns:
            True if valid email, False otherwise
        \"""
        import re
        pattern = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{{2,}}$'
        return bool(re.match(pattern, email))

    def handler(email_address: str) -> str:
        \"""Agent that validates email addresses using custom tool\"""
        bedrock_model = models.BedrockModel(
            model_id=FABRICATOR_MODEL_ID,
            region_name="us-west-2"
        )
        agent = Agent(bedrock_model, tools=[validate_email])
        result = agent(f"Is this a valid email: {{email_address}}?")
        return result
    </example>
    </agent_with_custom_tool_pattern>

    <governance_compliance>
    Your generated agents MUST:
    - Use /tmp/ for all file writes before S3 upload
    - Be deterministic (no random behavior unless explicitly required)
    - Include meaningful logging via journal or speak tools

    Your generated agents MUST NOT:
    - Use unbounded recursion
    - Use unrestricted shell execution
    - Expose credentials in code
    - Use self-modifying code
    </governance_compliance>

    <autonomous_operation>
    - DO NOT ask clarifying questions
    - DO make reasonable assumptions and document them
    - DO infer missing details logically
    - DO include assumptions in your AGENT DESIGN SUMMARY
    </autonomous_operation>

    <persistence_workflow>
    After generating the agent code, you MUST persist the agent by calling these tools in order:

    STEP 1: Call write_job_file to save the agent code to /tmp/[agent_name].py

    STEP 2: Call upload_agent_to_s3 with the file path to upload to S3 storage

    STEP 3: Call store_agent_config_registry with:
       - file_name: "/tmp/[agent_name].py"
       - agent_id: the agent identifier (e.g., "email_validator_agent")
       - llm_tool_schema: OpenAPI-compliant JSON schema describing the handler's input parameters
       - agent_description: brief one-sentence description of what the agent does
       - app_id: (optional) the app identifier if the agent is scoped to a specific app

    CRITICAL: The agent is NOT registered in AgentCore Registry and CANNOT be discovered or
    invoked by the Supervisor until store_agent_config_registry is called. Skipping this
    step means the fabricated agent is lost.

    Fabricated agents are created with initial status DRAFT (mapped to internal state
    "inactive"), which means they require activation before use. Do not attempt to set
    the status yourself — store_agent_config_registry handles this automatically.

    STEP 4: Call complete_task to signal fabrication is done.

    VERIFICATION CHECKLIST:
    □ Called write_job_file with agent code to /tmp/
    □ Called upload_agent_to_s3 with the file path
    □ Called store_agent_config_registry with agent_id, schema, and description
    □ Called complete_task to finalize

    YOU MUST ACTUALLY CALL ALL FOUR TOOLS. Do not just describe what you would do.
    </persistence_workflow>

    <output_format>
    Provide your response in EXACTLY this format:

    <section name="agent_design_summary">
    Purpose: [One sentence describing what the agent does]
    Input: [Type and description of handler parameter]
    Output: [Type and description of return value]
    Tools Required: [List of tools from priority order]
    Assumptions Made: [Any inferences you made from the request]
    Risk Rating: [low/medium/high based on tool permissions needed]
    Policy Considerations: [Any governance flags for Evaluator]
    </section>

    <section name="filename">
    agent_name.py
    </section>

    <section name="code">
    Provide ONLY the Python code. NO backticks, NO markdown formatting.
    the main entry function must be 'def handler'
    </section>

    <section name="metadata">
    {{
    "agent_name": "descriptive_agent_name",
    "purpose": "Brief description",
    "tools_used": ["tool1", "tool2"],
    "custom_tools_defined": ["custom_tool_name"],
    "requires_external_permissions": false,
    "risk_rating": "low",
    "s3_path": "s3://agents/agent_name.py",
    "registry_record": {{
        "agent_id": "agent_name",
        "handler_function": "handler",
        "created_by": "fabricator",
        "version": "1.0"
        }}
    }}
    </section>
    </output_format>

    <examples>
    <example_1 name="Agent Using Strands Built-in Tool">
    from strands import Agent, models
    from strands_tools import calculator

    def handler(x: int) -> str:
        \"""Calculate the square root of a number.
        Args:
            x: Integer to calculate square root of

        Returns:
            String containing the result
        \"""
        bedrock_model = models.BedrockModel(
            model_id=FABRICATOR_MODEL_ID,
            region_name="us-west-2"
        )
        agent = Agent(bedrock_model, tools=[calculator])
        result = agent(f"What is the square root of {{x}}?")
        return result
    </example_1>

    <example_2 name="Agent Using Custom Tool">
    from strands import Agent, tool, models

    @tool
    def word_count(text: str) -> int:
        \"""Count the number of words in provided text.
        Args:
            text: String to count words in

        Returns:
            Integer count of words
        \"""
        return len(text.split())

    def handler(text: str) -> str:
        \"""Count words in the provided text string.
        Args:
            text: Input string to analyze

        Returns:
            Agent response with word count
        \"""
        bedrock_model = models.BedrockModel(
            model_id=FABRICATOR_MODEL_ID,
            region_name="us-west-2"
        )
        agent = Agent(bedrock_model, tools=[word_count])
        result = agent(f"How many words are in this text: '{{text}}'")
        return result
    </example_2>
    </examples>

    <checklist>
    Before submitting, verify:
    - Agent function is named handler
    - Uses models.BedrockModel from strands import
    - Follows tool priority hierarchy
    - Includes complete docstrings
    - No test code included
    - Single file, importable as module
    - Uses /tmp/ for file operations
    - All 4 output sections present
    - Code has NO markdown backticks
    - Metadata JSON is valid
    - Called upload_agent_to_s3 to store the agent file in S3
    - Called store_agent_config_registry to register the agent in AgentCore Registry
    </checklist>

    <reminder>
    You are generating production code. Prioritize clarity, safety, and compliance over cleverness.
    Always make sure the main entry point for the agent is called handler.
    Import statement: from strands import Agent, tool, models

    IMPORTANT: If you need a custom tool, DO NOT create it yourself. Instead, call the create_custom_tool function with a description of what the tool should do. The Tool Fabricator will generate the tool code for you, and you can then include it in your agent code.

    CRITICAL: Every fabricated agent MUST be persisted via store_agent_config_registry (which writes to AgentCore Registry, not DynamoDB). The agent will not be discoverable until this tool is called.
    </reminder>
    """
    return AGENT_FABRICATOR_PROMPT

def publish_fabrication_event(orchestration_id: str, event_type: str, agent_id: str = None, error: str = None, app_id: str = None):
    """Publish fabrication event to EventBridge
    
    Args:
        orchestration_id: The orchestration ID for the fabrication request
        event_type: The type of event ('agent.fabricated' or 'agent.fabrication.failed')
        agent_id: The ID of the created agent (optional, for success events)
        error: Error message (optional, for failure events)
        app_id: The app ID to associate with the event (optional)
    
    Returns:
        The response from EventBridge put_events call
    """
    client = boto3.client('events')
    COMPLETION_BUS_NAME = os.environ.get('COMPLETION_BUS_NAME')
    event_detail = {
        'orchestration_id': orchestration_id,
    }
    
    if agent_id:
        event_detail['agent_use_id'] = agent_id
    
    if app_id:
        event_detail['appId'] = app_id
    
    if error:
        event_detail['error'] = error
    else:
        event_detail['data'] = 'Agent successfully created'
    
    event = {
        'Source': event_type,
        'DetailType': event_type,
        'EventBusName': COMPLETION_BUS_NAME,
        'Detail': json.dumps(event_detail)
    }
    
    response = client.put_events(Entries=[event])
    print(f"Published {event_type} event: {response}")
    return response

def publish_manifest_event(detail_type: str, detail: dict):
    """Publish a Tier-3 agent-import manifest event to the agent event bus.

    Mirrors ``publish_fabrication_event``'s PutEvents pattern exactly — same
    boto3 ``events`` client, same ``COMPLETION_BUS_NAME`` agent bus, and the
    Source==DetailType convention — but carries the B1 agent-import result
    contract detail shape verbatim:

      - 'agent.import.manifest.proposed':
          {requestId, correlationId, importId, proposedManifest, status:'proposed'}
      - 'agent.import.manifest.failed':
          {requestId, correlationId, importId, error, status:'failed'}

    The backend result handler (B1) listens for these detail-types on the
    agent bus and writes the (sanitized) descriptor into
    ``customMetadata.proposedManifest`` for human review (B2).

    Args:
        detail_type: The EventBridge DetailType (and Source) — one of the two
            agent-import manifest detail-types above.
        detail: The fully-formed event detail dict (already secret-free).

    Returns:
        The response from EventBridge ``put_events``.
    """
    client = boto3.client('events')
    bus = os.environ.get('COMPLETION_BUS_NAME')
    event = {
        'Source': detail_type,
        'DetailType': detail_type,
        'EventBusName': bus,
        'Detail': json.dumps(detail, default=str),
    }
    response = client.put_events(Entries=[event])
    print(f"Published {detail_type} event: {response}")
    return response

def _process_manifest_proposal(event):
    """Tier-3 agent-import (ARBITER-A) manifest-proposal branch.

    Parses the B1 request body ``{requestId, correlationId, importId,
    signals}`` and asks the model to PROPOSE an agent capability descriptor
    from the non-secret signals. This path proposes a descriptor only — it
    NEVER generates or executes code, so it deliberately does NOT touch the
    design-assessment / code-fabrication path.

    On success it emits ``agent.import.manifest.proposed``; on ANY failure
    (unparseable/invalid model output, or a model/client error) it emits
    ``agent.import.manifest.failed`` with a short, secret-free error message.
    No exception escapes this function: a poison/failed message must report a
    FAILED event rather than nack-and-retry the SQS message forever.
    """
    base_detail = {
        'requestId': event.get('requestId'),
        'correlationId': event.get('correlationId'),
        'importId': event.get('importId'),
    }
    signals = event.get('signals') or {}
    try:
        proposed_manifest = propose_agent_manifest(signals)
        detail = {
            **base_detail,
            'proposedManifest': proposed_manifest,
            'status': 'proposed',
        }
        publish_manifest_event('agent.import.manifest.proposed', detail)
    except Exception as e:  # noqa: BLE001 — ManifestProposalError + model/client errors; never poison the queue
        short_error = sanitize_text(str(e))[:200]
        # Do not log importId (event-derived) or the error text (may echo
        # request values); log the exception class only. short_error is still
        # shipped in the published FAILED event detail below (unchanged).
        logger.warning(
            "manifest-proposal failed: %s", type(e).__name__,
        )
        detail = {
            **base_detail,
            'error': short_error,
            'status': 'failed',
        }
        publish_manifest_event('agent.import.manifest.failed', detail)

def publish_intake_progress(session_id: str, agent_index: int, total_agents: int, agent_name: str, failed: bool = False):
    """Publish implementation progress back to the intake EventBridge bus."""
    client = boto3.client('events')
    bus = os.environ.get('COMPLETION_BUS_NAME')
    if not bus or not session_id or session_id == '0':
        return
    # Build-segment window: fabrication owns 10-60 of the project header's
    # implementation progress (confirm = 10; post-fabrication milestones own
    # 70-100), so per-agent completion scales within it. A failed agent emits
    # -1 — a failure SIGNAL the backend updater ignores (never regresses).
    pct = (10 + min(int(((agent_index + 1) / total_agents) * 50), 50)) if not failed else -1
    summary = f"{'Failed' if failed else 'Built'}: {agent_name} ({agent_index + 1}/{total_agents})"
    client.put_events(Entries=[{
        'Source': 'agent_intake.implementation',
        'DetailType': 'intake.progress.updated',
        'EventBusName': bus,
        'Detail': json.dumps({
            'sessionId': session_id,
            'phase': 'implementation',
            'completionPercentage': pct,
            'changeSummary': summary,
        }),
    }])
    # summary embeds the event-derived agent name; log only the numeric pct.
    print(f"Published intake progress: {pct}%")

def _validate_basename(basename: str) -> str:
    """Validate and sanitise a filename for use as an S3 key segment.

    Raises ``ValueError`` on traversal attempts, control characters, or
    empty input.  Returns the validated basename.
    """
    import re as _re

    if not basename or not isinstance(basename, str):
        raise ValueError("basename must be a non-empty string")
    if "/" in basename or "\\" in basename:
        raise ValueError(f"basename must not contain path separators: {basename!r}")
    if ".." in basename:
        raise ValueError(f"basename must not contain '..': {basename!r}")
    if _re.search(r"[\x00-\x1f\x7f]", basename):
        raise ValueError(f"basename must not contain control characters: {basename!r}")
    return basename


def upload_to_s3(file_path, folder, record_id=None):
    """Upload a file to S3 under a tenant-scoped key.

    Key layout (CIT-256 C1 / scanner C1):
        ``{folder}/{org_id}/{job_id}/{basename}``   tenant-scoped (preferred)
        ``{folder}/{record_id}/{basename}``         record-scoped fallback
        ``{folder}/{basename}``                     legacy (record_id=None,
                                                    no context)

    Tenant-scoped keys derive ``org_id`` and ``job_id`` from the
    ``fabrication_context`` ContextVars set by ``process_event`` — NEVER from
    LLM-supplied arguments.  This isolates every fabrication run's artefacts
    per-organisation and per-job.

    The upload uses ``put_object`` with ``IfNoneMatch='*'`` so that an
    existing object at the same key is never silently overwritten.  On a
    ``PreconditionFailed`` (412) the existing object is left intact and the
    function raises — the caller retries with a different key or reports the
    collision.

    A SHA-256 digest of the file content is returned alongside the S3 key so
    callers can stamp ``codeSha256`` into custom_metadata for integrity
    verification.

    Returns:
        A ``(code_sha256, s3_key)`` tuple.
    """
    bucket_name = os.environ.get("AGENT_BUCKET_NAME", None)
    if bucket_name is None:
        raise ValueError("AGENT_BUCKET_NAME environment variable is not set")

    s3 = boto3.client('s3')
    print(f"storing {file_path}")

    filename = os.path.basename(file_path)
    basename = _validate_basename(filename)

    # Compute SHA-256 digest of the file content.
    import hashlib
    sha256 = hashlib.sha256()
    with open(file_path, "rb") as fh:
        for chunk in iter(lambda: fh.read(8192), b""):
            sha256.update(chunk)
    code_sha256 = sha256.hexdigest()

    # Key layout: prefer tenant-scoped from ContextVars, then record-scoped,
    # then legacy flat.
    ctx_org = fabrication_org_id.get("")
    ctx_job = fabrication_job_id.get("")
    if ctx_org and ctx_job:
        s3_key = f"{folder}/{ctx_org}/{ctx_job}/{basename}"
    elif record_id:
        s3_key = f"{folder}/{record_id}/{basename}"
    else:
        s3_key = f"{folder}/{basename}"

    # Read the file content for put_object.
    with open(file_path, "rb") as fh:
        body = fh.read()

    s3.put_object(
        Bucket=bucket_name,
        Key=s3_key,
        Body=body,
        IfNoneMatch="*",
    )
    return code_sha256, s3_key

@tool
def upload_agent_to_s3(file_path, record_id=None):
    """Upload a agent file to S3"""
    _sha, _key = upload_to_s3(file_path, "agents", record_id=record_id)
    return _sha

@tool
def upload_tool_to_s3(file_path, record_id=None):
    """Upload a tool file to S3.

    Returns the S3 key the object was stored under.  The key is
    tenant-scoped when a fabrication context is active (see
    ``fabrication_context.py``), record-scoped when ``record_id`` is
    supplied, or flat for legacy callers.

    Side-effect: records the ``{tool_name -> s3_key}`` mapping in the
    per-job ``fabrication_tool_keys`` ContextVar so ``get_worker_tool``
    can resolve the key server-side within the same fabrication run.
    """
    _sha, s3_key = upload_to_s3(file_path, "tools", record_id=record_id)
    # Record in per-job map so get_worker_tool resolves server-side.
    tool_name = os.path.basename(file_path)
    record_tool_key(tool_name, s3_key)
    return s3_key

@tool
def get_worker_tool(tool_name: str) -> str:
    """Get tool code from S3, resolving the key server-side.

    Key resolution order (no LLM-supplied key parameter):
    1. Per-job map — ``fabrication_tool_keys`` ContextVar populated by
       ``upload_tool_to_s3`` during the same fabrication run.
    2. Registry ``codeKey`` — the scoped key persisted in the CUSTOM
       descriptor of the tool's registry record, org-filtered to the
       caller's ``fabrication_org_id``.
    3. Legacy ``tools/{tool_name}`` — ONLY when an org-owned registry
       record exists without a ``codeKey``.  A ``LegacyToolKeyFallback``
       CloudWatch metric is emitted on each hit.
    4. Otherwise — opaque error (no key source available).

    Args:
        tool_name: Name of the tool file (e.g., 'my_tool.py').

    Returns:
        str: The tool code content from S3.

    Raises:
        ValueError: If AGENT_BUCKET_NAME environment variable is not set,
            or no key source is available for this tool.
    """
    bucket_name = os.environ.get("AGENT_BUCKET_NAME", None)
    if bucket_name is None:
        raise ValueError("AGENT_BUCKET_NAME environment variable is not set")

    s3 = boto3.client('s3')

    # --- Source 1: per-job map (same fabrication run) ---
    job_key = lookup_tool_key(tool_name)
    if job_key:
        print(f"Retrieving tool from s3://{bucket_name}/{job_key} (per-job map)")
        response = s3.get_object(Bucket=bucket_name, Key=job_key)
        tool_code = response['Body'].read().decode('utf-8')
        print(f"Successfully retrieved tool via per-job map: {job_key}")
        return tool_code

    # --- Source 2 & 3: registry lookup (org-filtered) ---
    registry_id = os.environ.get("REGISTRY_ID")
    ctx_org = fabrication_org_id.get("")
    if registry_id:
        record_id = _find_existing_record_id(registry_id, tool_name, org_id=ctx_org)
        if record_id:
            # Read full record to extract codeKey from custom metadata.
            try:
                record_resp = _get_registry_client().get_registry_record(
                    registryId=registry_id, recordId=record_id,
                )
                descriptors = (record_resp or {}).get("descriptors") or {}
                custom = descriptors.get("custom") or {}
                data_str = custom.get("data", "")
                code_key = None
                if data_str and isinstance(data_str, str):
                    meta = json.loads(data_str)
                    code_key = meta.get("codeKey") or None
            except Exception as e:  # noqa: BLE001 — best-effort registry read
                logger.warning(
                    "get_worker_tool: registry read for %s failed: %s",
                    tool_name, type(e).__name__,
                )
                code_key = None

            if code_key:
                print(f"Retrieving tool from s3://{bucket_name}/{code_key} (registry codeKey)")
                response = s3.get_object(Bucket=bucket_name, Key=code_key)
                tool_code = response['Body'].read().decode('utf-8')
                print(f"Successfully retrieved tool via registry codeKey: {code_key}")
                return tool_code

            # Source 3: legacy flat key, ONLY with an org-owned record without codeKey.
            flat_key = f"tools/{tool_name}"  # legacy-fallback
            print(f"Retrieving tool from s3://{bucket_name}/{flat_key} (legacy, org-owned record)")
            try:
                response = s3.get_object(Bucket=bucket_name, Key=flat_key)
                tool_code = response['Body'].read().decode('utf-8')
                print(f"Successfully retrieved tool (legacy flat key): {tool_name}")
                # Emit migration-tracking metric (best-effort, never raises).
                try:
                    _cloudwatch().put_metric_data(
                        Namespace="Citadel/Fabricator",
                        MetricData=[{
                            "MetricName": "LegacyToolKeyFallback",
                            "Value": 1,
                            "Unit": "Count",
                            "Dimensions": [{"Name": "Site", "Value": "get_worker_tool"}],
                        }],
                    )
                except Exception:  # noqa: BLE001 — best-effort metric
                    pass
                return tool_code
            except Exception as e:
                print(f"Error retrieving tool {tool_name} (legacy): {str(e)}")
                raise

    # --- No key source available ---
    raise ValueError(
        f"Cannot resolve S3 key for tool '{tool_name}': no per-job map entry, "
        f"no org-owned registry record found."
    )

@tool
def store_agent_config_dynamo(file_name: str, agent_id: str, llm_tool_schema: Any, agent_description: str, app_id: str = None):
    """Store agent configuration in DynamoDB.
    
    Requirements:
    - AGENT_CONFIG_TABLE_NAME environment variable must be set with the DynamoDB table name
    - DynamoDB table must use 'agentId' as the primary key
    
    Args:
        file_name (str): The filename where the agent implementation is stored
        agent_id (str): Unique identifier for the agent (used as primary key in DynamoDB)
        llm_tool_schema (Any): OpenAPI schema structure defining the agents parameters
                               Must follow OpenAPI format with properties, required fields, and types
                               Example: {
                                 "properties": {
                                   "param_name": {
                                     "description": "Parameter description",
                                     "type": "string"
                                   }
                                 },
                                 "required": ["param_name"],
                                 "type": "object"
                               }
        agent_description (str): Human-readable description of what the agent does
        
    Returns:
        bool: True if configuration was successfully stored
        
    Raises:
        ValueError: If AGENT_CONFIG_TABLE_NAME environment variable is not set
    """
    try:
        print(f"[store_agent_config_dynamo] Starting - agent_id: {agent_id}, file_name: {file_name}")
        
        dynamodb = boto3.resource('dynamodb')
        table_name = os.environ.get("AGENT_CONFIG_TABLE", None)
        
        print(f"[store_agent_config_dynamo] AGENT_CONFIG_TABLE env var: {table_name}")
        
        if table_name is None:
            error_msg = "AGENT_CONFIG_TABLE environment variable is not set"
            print(f"[store_agent_config_dynamo] ERROR: {error_msg}")
            raise ValueError(error_msg)

        # if llm_tool_schema is str then json loads it
        if isinstance(llm_tool_schema, str):
            print(f"[store_agent_config_dynamo] Converting llm_tool_schema from string to dict")
            llm_tool_schema = json.loads(llm_tool_schema)
        
        print(f"[store_agent_config_dynamo] llm_tool_schema type: {type(llm_tool_schema)}")
        print(f"[store_agent_config_dynamo] llm_tool_schema content: {json.dumps(llm_tool_schema, indent=2)}")

        table = dynamodb.Table(table_name)
        
        # Auto-generate agent manifest from available information (Req 15.5)
        manifest = {
            'name': agent_id,
            'description': agent_description,
            'version': 1,
            'tools': [],
        }

        item = {
            'agentId': agent_id,
            'config': {
                "name": agent_id,
                "filename": file_name.split('/')[-1],
                "schema": llm_tool_schema,
                "version": 1,
                "description": agent_description,
                "action": {
                    "type": "sqs",
                    "target": os.environ.get("WORKER_QUEUE_URL", "MISSING")
                },
            },
            'state': 'inactive',
            'categories': ['worker'],
            'manifest': manifest,
        }

        if app_id:
            item['appId'] = app_id
        
        print(f"[store_agent_config_dynamo] Attempting to put_item: {json.dumps(item, indent=2, default=str)}")
        
        response = table.put_item(Item=item)
        
        print(f"[store_agent_config_dynamo] SUCCESS - DynamoDB response: {response}")
        return True
        
    except Exception as e:
        print(f"[store_agent_config_dynamo] EXCEPTION: {type(e).__name__}: {str(e)}")
        import traceback
        print(f"[store_agent_config_dynamo] TRACEBACK: {traceback.format_exc()}")
        raise

@tool
def store_tool_config_dynamo(
    file_name: str,
    tool_id: str,
    tool_schema: Any,
    tool_description: str,
    integration_bindings: list | None = None,
    datastore_bindings: list | None = None,
    app_id: str = None,
):
    """Store tool configuration in DynamoDB.
    
    Requirements:
    - TOOL_CONFIG_TABLE_NAME environment variable must be set with the DynamoDB table name
    - DynamoDB table must use 'toolId' as the primary key
    
    Args:
        file_name (str): The filename where the tool implementation is stored
        tool_id (str): Unique identifier for the tool (used as primary key in DynamoDB)
        tool_schema (Any): OpenAPI schema structure defining the tools parameters
                               Must follow OpenAPI format with properties, required fields, and types
                               Example: {
                                 "properties": {
                                   "param_name": {
                                     "description": "Parameter description",
                                     "type": "string"
                                   }
                                 },
                                 "required": ["param_name"],
                                 "type": "object"
                               }
        tool_description (str): Human-readable description of what the tool does
        integration_bindings (list | None): Optional list of integration binding dicts,
            each with integrationId, integrationType, and optional operations
        datastore_bindings (list | None): Optional list of data store binding dicts,
            each with dataStoreId, dataStoreType, and optional operations
        
    Returns:
        bool: True if configuration was successfully stored
        
    Raises:
        ValueError: If TOOL_CONFIG_TABLE_NAME environment variable is not set
    """
    try:
        print(f"[store_tool_config_dynamo] Starting - tool_id: {tool_id}, file_name: {file_name}")
        
        dynamodb = boto3.resource('dynamodb')
        table_name = os.environ.get("TOOL_CONFIG_TABLE", None)
        
        print(f"[store_tool_config_dynamo] TOOL_CONFIG_TABLE env var: {table_name}")
        
        if table_name is None:
            error_msg = "TOOL_CONFIG_TABLE environment variable is not set"
            print(f"[store_tool_config_dynamo] ERROR: {error_msg}")
            raise ValueError(error_msg)

        # if tool_schema is str then json loads it
        if isinstance(tool_schema, str):
            print(f"[store_tool_config_dynamo] Converting tool_schema from string to dict")
            tool_schema = json.loads(tool_schema)
        
        print(f"[store_tool_config_dynamo] tool_schema type: {type(tool_schema)}")
        print(f"[store_tool_config_dynamo] tool_schema content: {json.dumps(tool_schema, indent=2)}")

        table = dynamodb.Table(table_name)
        
        item = {
            'toolId': tool_id,
            'config': {
                "name": tool_id,
                "filename": file_name.split('/')[-1],
                "schema": tool_schema,
                "version": 1,
                "description": tool_description,
            },
            'state': 'active'
        }

        if integration_bindings:
            item['integrationBindings'] = integration_bindings
        if datastore_bindings:
            item['dataStoreBindings'] = datastore_bindings
        if app_id:
            item['appId'] = app_id
        
        print(f"[store_tool_config_dynamo] Attempting to put_item: {json.dumps(item, indent=2, default=str)}")
        
        response = table.put_item(Item=item)
        
        print(f"[store_tool_config_dynamo] SUCCESS - DynamoDB response: {response}")
        return True
        
    except Exception as e:
        print(f"[store_tool_config_dynamo] EXCEPTION: {type(e).__name__}: {str(e)}")
        import traceback
        print(f"[store_tool_config_dynamo] TRACEBACK: {traceback.format_exc()}")
        raise

@tool
def store_agent_config_registry(
    file_name: str,
    agent_id: str,
    llm_tool_schema: Any,
    agent_description: str,
    app_id: str = None,
    requested_by: str = "fabricator",
    org_id: str = "",
    source_project_id: str | None = None,
) -> bool:
    """Store agent configuration in AgentCore Registry.

    Creates a new agent record in the AgentCore Registry via CreateRegistryRecord.
    The human-readable description is stored verbatim in the record's description
    field so the UI can render it as text (QB-013-2). The full executable config,
    manifest, categories, state, the requester user id (as ``createdBy``), and
    the caller's organization id (as ``orgId``, Phase 2b) are serialized as JSON
    and stored in the CUSTOM descriptor's inlineContent.
    After creation the record is left in its post-create DRAFT
    (pending-activation) state so it requires activation before use (DRAFT
    maps to internal state "inactive" for fabricator-created records, per
    Requirement 8.3). The Fabricator does NOT call UpdateRegistryRecordStatus
    to re-assert DRAFT — CreateRegistryRecord already leaves the record in
    DRAFT, and the registry rejects a DRAFT->DRAFT transition with
    ValidationException.

    Requirements:
    - REGISTRY_ID environment variable must be set with the Registry ID.

    Args:
        file_name: The filename where the agent implementation is stored.
        agent_id: Unique identifier for the agent (used as the record name so
            downstream consumers can resolve records by this id).
        llm_tool_schema: OpenAPI schema structure defining the agent's parameters.
            May be a dict or a JSON string.
        agent_description: Human-readable description of what the agent does.
            Written verbatim into the record's description field.
        app_id: Optional app id to associate with the agent.
        requested_by: The requester user id — stamped into the record's custom
            metadata as ``createdBy``. Defaults to ``"fabricator"`` for legacy
            callers that don't thread the value through.
        org_id: The caller's organization id — stamped into custom metadata as
            ``orgId`` (Phase 2b). Defaults to ``""`` to mirror the resolver's
            defensive null fallback; callers should pass the value threaded
            from the SQS event's ``org_id`` field.

    Returns:
        bool: True if configuration was successfully stored.

    Raises:
        ValueError: If REGISTRY_ID environment variable is not set.
        Exception: Re-raises any error from the Registry API after logging and
            publishing an agent.fabrication.failed event to EventBridge.
    """
    try:
        # Watchdog checkpoint (deadline-aware execution): refuse to START the
        # agent registration inside the Lambda's safety margin so
        # process_event can write the terminal 'timed out' status instead of
        # the run being SIGKILLed midway. Entry-only on this path: once the
        # agent record is written, the remaining work (complete_task event
        # publishes) is cheap, so a post-registration trip would fail an
        # essentially finished job for no protective benefit — unlike the
        # tool path, where the next step can be another multi-minute
        # generation.
        registration_checkpoint(f"before agent registration '{agent_id}'")

        print(
            f"[store_agent_config_registry] Starting - agent_id: {agent_id}, "
            f"file_name: {file_name}"
        )

        registry_id = os.environ.get("REGISTRY_ID")
        print(f"[store_agent_config_registry] REGISTRY_ID env var: {registry_id}")

        if not registry_id:
            error_msg = "REGISTRY_ID environment variable is not set"
            print(f"[store_agent_config_registry] ERROR: {error_msg}")
            raise ValueError(error_msg)

        # Normalize the schema — strings arrive from the LLM as JSON text.
        if isinstance(llm_tool_schema, str):
            print(
                "[store_agent_config_registry] Converting llm_tool_schema "
                "from string to dict"
            )
            llm_tool_schema = json.loads(llm_tool_schema)

        print(
            f"[store_agent_config_registry] llm_tool_schema type: "
            f"{type(llm_tool_schema)}"
        )

        # Source-project tagging (identifiability): when a real source project
        # id is supplied, append a ' (Project: <id>)' suffix to the human
        # description so the catalog can attribute the fabricated agent to the
        # intake session it came from, and stash the raw id in custom metadata
        # for grouping. '0'/empty/None are treated as "no project" so legacy
        # / UI-direct fabrications stay unchanged. The suffix is idempotent —
        # never duplicated if the description already carries it.
        base_description = agent_description or ""
        display_description = base_description
        normalized_project_id = (
            source_project_id
            if source_project_id and source_project_id != "0"
            else None
        )
        if normalized_project_id:
            suffix = f" (Project: {normalized_project_id})"
            if not display_description.endswith(suffix):
                display_description = f"{display_description}{suffix}"

        # Executable agent config — stashed under custom metadata so the cache
        # sync / resolvers can parse it verbatim without colliding with the
        # human description.
        config = {
            "name": agent_id,
            "filename": file_name.split('/')[-1],
            "schema": llm_tool_schema,
            "version": 1,
            "description": display_description,
            "action": {
                "type": "sqs",
                "target": os.environ.get("WORKER_QUEUE_URL", "MISSING"),
            },
        }

        # Auto-generate agent manifest.
        manifest = {
            "name": agent_id,
            "description": display_description,
            "version": 1,
            "tools": [],
        }

        # Custom metadata — serialized into the CUSTOM descriptor inlineContent.
        # state is recorded as "inactive" to match Requirement 8.3; the record
        # is left in its post-create DRAFT (pending-activation) state — no
        # UpdateRegistryRecordStatus call is made (a DRAFT->DRAFT transition is
        # rejected by the registry). The full ``config``
        # dict and requester ``createdBy`` are preserved here so that moving
        # the executable config out of the top-level description doesn't lose
        # information (QB-013-2 post-boto3-1.42 refactor). Phase 2b stamps the
        # caller's ``orgId`` so the registry-service mapper can extract it.
        custom_metadata = {
            "categories": ["worker"],
            "icon": "",
            "state": "inactive",
            "manifest": manifest,
            "config": config,
            "createdBy": requested_by,
            "orgId": org_id,
        }
        if app_id:
            custom_metadata["appId"] = app_id
        if normalized_project_id:
            custom_metadata["sourceProjectId"] = normalized_project_id

        print(
            f"[store_agent_config_registry] Creating Registry record for agent: "
            f"{agent_id}"
        )

        # Idempotency guard (pipeline-reliability hardening): SQS redeliveries
        # and re-triggers must NOT create a duplicate Registry record for the
        # same agent name. Look the name up first (mirrors resolveRecordId /
        # listResources in backend/src/services/registry-service.ts). When a
        # record already exists we SKIP CreateRegistryRecord, still refresh the
        # AppsTable #META mirror for that existing record, and return True so
        # the re-trigger is a no-op rather than a duplicate fabrication.
        existing_record_id = _find_existing_record_id(registry_id, agent_id, org_id=org_id)
        if existing_record_id is not None:
            print(
                f"[store_agent_config_registry] Record with name '{agent_id}' "
                f"already exists (recordId={existing_record_id}); skipping "
                f"CreateRegistryRecord to keep fabrication idempotent"
            )
            # Read the reused record's current status and apply the same
            # state table used by the tool path: APPROVED/PENDING_APPROVAL
            # are done; DRAFT needs submission; REJECTED/DEPRECATED are
            # terminal failures; CREATING is left to the caller to handle.
            # A reused record's content is NOT rewritten — content writes
            # demote non-DRAFT records.
            try:
                existing_resp = _get_registry_client().get_registry_record(
                    registryId=registry_id, recordId=existing_record_id,
                )
                existing_status = (existing_resp or {}).get("status")
            except Exception as status_err:  # noqa: BLE001
                logger.warning(
                    "[store_agent_config_registry] Could not read status of "
                    "existing record %s: %s — treating as DRAFT (legacy behavior)",
                    existing_record_id, type(status_err).__name__,
                )
                existing_status = None

            if existing_status in ("REJECTED", "DEPRECATED"):
                raise RuntimeError(
                    f"Reused agent record '{agent_id}' (recordId "
                    f"{existing_record_id}) is in terminal status "
                    f"{existing_status!r} and cannot be approved. "
                    f"Create a new record or ask an operator to update it."
                )

            # Submit DRAFT records for approval so they follow the same
            # lifecycle as freshly-created tool records.
            if existing_status == "DRAFT":
                try:
                    submit_resp = _get_registry_client().submit_registry_record_for_approval(
                        registryId=registry_id,
                        recordId=existing_record_id,
                    )
                    submit_status = (submit_resp or {}).get("status")
                    if submit_status == "PENDING_APPROVAL":
                        print(
                            f"[store_agent_config_registry] Record "
                            f"{existing_record_id} entered manual review "
                            f"(PENDING_APPROVAL)"
                        )
                except Exception as submit_err:  # noqa: BLE001
                    logger.warning(
                        "[store_agent_config_registry] Failed to submit "
                        "existing DRAFT record %s for approval: %s",
                        existing_record_id, type(submit_err).__name__,
                    )

            _write_app_meta_row(
                record_id=existing_record_id,
                agent_id=agent_id,
                agent_description=display_description,
                requested_by=requested_by,
                org_id=org_id,
            )
            # Stash record coordinates so the COMPLETED status write can
            # stamp them onto the job row — postfab resolves by record id
            # (one call, exact) instead of passing the display name through
            # the name filter (which rejects special characters).
            run_state = _registration_run_state
            if run_state is not None:
                run_state.agent_record_info[agent_id] = (
                    existing_record_id, agent_id,
                )
            return True

        # CreateRegistryRecord does NOT accept a recordId — the service generates
        # one. We use the agentId as the record name so records can be located
        # by name in subsequent operations.
        response = _get_registry_client().create_registry_record(
            registryId=registry_id,
            name=agent_id,
            displayName=agent_id,
            description=display_description,
            recordType="CUSTOM",
            descriptors={
                "custom": {
                    "data": json.dumps(custom_metadata, default=str),
                },
            },
        )

        # Extract recordId from the ARN returned by CreateRegistryRecord.
        record_arn = response.get("recordArn", "")
        record_id = record_arn.rsplit("/", 1)[-1] if "/" in record_arn else agent_id

        # Phase 3 Step 2: synchronously mirror the new Registry record into
        # AppsTable as a #META row so listApps (which reads from
        # AppsTable.OrgIndex) sees the agent immediately, without waiting
        # for the reconciler. Eventually-consistent — DDB failures log and
        # are swallowed; the Registry write above is the source of truth.
        _write_app_meta_row(
            record_id=record_id,
            agent_id=agent_id,
            agent_description=display_description,
            requested_by=requested_by,
            org_id=org_id,
        )

        print(
            f"[store_agent_config_registry] Record created (recordId={record_id}); "
            f"leaving record in its post-create DRAFT (pending-activation) state"
        )

        # No status update here: CreateRegistryRecord already leaves the record
        # in DRAFT (the pre-activation state), which is the intended
        # 'requires activation before use' behavior for fabricator-created
        # agents (Requirement 8.3; DRAFT maps to internal state "inactive").
        # The AgentCore registry REJECTS a redundant DRAFT->DRAFT transition
        # with ValidationException ('Invalid target status: DRAFT'), so calling
        # UpdateRegistryRecordStatus(status="DRAFT") here would make this
        # function raise and publish agent.fabrication.failed even though the
        # record was created successfully. The record is therefore left as-is;
        # activation to a usable state happens later via the catalog.

        print(f"[store_agent_config_registry] SUCCESS - Registry response: {response}")
        # Stash record coordinates (same rationale as the reuse path above).
        run_state = _registration_run_state
        if run_state is not None:
            run_state.agent_record_info[agent_id] = (record_id, agent_id)
        return True

    except Exception as e:
        print(
            f"[store_agent_config_registry] EXCEPTION: "
            f"{type(e).__name__}: {str(e)}"
        )
        import traceback
        print(f"[store_agent_config_registry] TRACEBACK: {traceback.format_exc()}")
        # Publish fabrication failure event to EventBridge. Failures here are
        # non-fatal — we still re-raise the original error.
        try:
            publish_fabrication_event(
                orchestration_id="0",
                event_type="agent.fabrication.failed",
                agent_id=agent_id,
                error=str(e),
                app_id=app_id,
            )
        except Exception as pub_err:
            print(
                f"[store_agent_config_registry] Failed to publish failure event: "
                f"{pub_err}"
            )
        raise


@tool
def store_tool_config_registry(
    file_name: str,
    tool_id: str,
    tool_schema: Any,
    tool_description: str,
    integration_bindings: list | None = None,
    datastore_bindings: list | None = None,
    app_id: str = None,
    requested_by: str = "fabricator",
    org_id: str = "",
    spec_id: str | None = None,
) -> bool:
    """Store tool configuration in AgentCore Registry.

    Creates a new tool record in the AgentCore Registry via CreateRegistryRecord.
    The human-readable description is stored verbatim in the record's description
    field so the UI can render it as text (QB-013-2). The full executable config,
    categories, state, integrationBindings, dataStoreBindings, the requester
    user id (as ``createdBy``), and the caller's organization id (as ``orgId``,
    Phase 2b) are serialized as JSON and stored in the CUSTOM descriptor's
    inlineContent. Tool records deliberately do NOT carry a ``manifest`` key —
    that is the agent/tool type discriminator (commit 0a42938) and must be
    preserved. After creation the record is submitted for approval via
    SubmitRegistryRecordForApproval: the registry decides the outcome
    (DRAFT → PENDING_APPROVAL when manual review is enabled, or
    DRAFT → APPROVED when auto-approval is configured).  This function
    NEVER writes status APPROVED directly — that is the registry's
    decision, not the fabricator's.  The service status enum is
    CREATE_FAILED, DRAFT, UPDATING, PENDING_APPROVAL, UPDATE_FAILED,
    DEPRECATED, APPROVED, CREATING, REJECTED (a former "PUBLISHED" value
    raised a live ValidationException here).

    When ``spec_id`` is provided and the tool schema declares code-generating
    outputs, the function enforces the spec-approval gate (CIT-256 H2):
    ``validate_code_tool_binding`` + ``assert_spec_approved`` must both pass
    BEFORE the registry record is created.  Failure is closed — an opaque
    error is raised and a ``Citadel/Fabricator ToolRegistrationDenied``
    CloudWatch metric is emitted.

    Requirements:
    - REGISTRY_ID environment variable must be set with the Registry ID.

    Args:
        file_name: The filename where the tool implementation is stored.
        tool_id: Unique identifier for the tool (used as the record name so
            downstream consumers can resolve records by this id).
        tool_schema: OpenAPI schema structure defining the tool's parameters.
            May be a dict or a JSON string.
        tool_description: Human-readable description of what the tool does.
            Written verbatim into the record's description field.
        integration_bindings: Optional list of integration binding dicts,
            each with integrationId, integrationType, and optional operations.
            Preserved verbatim in custom metadata.
        datastore_bindings: Optional list of data store binding dicts,
            each with dataStoreId, dataStoreType, and optional operations.
            Preserved verbatim in custom metadata.
        app_id: Optional app id to associate with the tool.
        requested_by: The requester user id — stamped into the record's custom
            metadata as ``createdBy``. Defaults to ``"fabricator"`` for legacy
            callers that don't thread the value through.
        org_id: The caller's organization id — stamped into custom metadata as
            ``orgId`` (Phase 2b). Defaults to ``""`` to mirror the resolver's
            defensive null fallback; callers should pass the value threaded
            from the SQS event's ``org_id`` field.
        spec_id: Optional ExecutionSpecification id. When provided and the
            tool schema declares code-generating outputs, the spec-approval
            gate is enforced (CIT-256 H2). ``None`` skips the gate — used
            for non-code-generating tools or legacy callers that predate
            spec threading.

    Returns:
        bool: True if configuration was successfully stored.

    Raises:
        ValueError: If REGISTRY_ID environment variable is not set.
        OrphanedRegistryRecordError: NON-RETRYABLE — the registry record is
            orphaned in CREATING state and the automatic recovery failed.
            DO NOT call this tool again for the same tool_id: it cannot
            succeed until an operator removes the orphaned record. Report
            the failure and move on.
        Exception: Re-raises any error from the Registry API after logging and
            publishing a tool.fabrication.failed event to EventBridge.
        FabricationError: If a code-generating tool fails the spec-approval
            gate (CIT-256 H2) — missing or unapproved spec.
    """
    try:
        # Watchdog checkpoint (deadline-aware execution): refuse to START a
        # registration inside the Lambda's safety margin — the terminal
        # status write must win over more work. Raises a BaseException that
        # bypasses the Strands tool executor's except-Exception handler and
        # reaches process_event as a hard stop.
        registration_checkpoint(f"before tool registration '{tool_id}'")

        run_state = _registration_run_state
        if run_state is not None and tool_id in run_state.latched:
            # This registration already failed NON-RETRYABLY this run
            # (orphaned CREATING record). The fabricator LLM has been
            # observed retrying such a failure 92-110× (~825-834s of the
            # 900s Lambda budget, live 2026-07-23): fail INSTANTLY with the
            # same terminal message — zero registry API traffic.
            raise OrphanedRegistryRecordError(run_state.latched[tool_id])

        print(
            f"[store_tool_config_registry] Starting - tool_id: {tool_id}, "
            f"file_name: {file_name}"
        )

        # CIT-302 fail-closed guard: refuse to register a tool without an
        # organisation WHEN running inside a fabrication job (registration
        # run state is active). An empty org_id means the nested fabrication
        # path failed to bind the org. Writing an org-less record would
        # create a tool invisible to any org's idempotency lookup and
        # unreachable by org-scoped queries. Emit a metric for operator
        # visibility and raise an opaque error.
        # Outside a fabrication run (direct/legacy callers, tests),
        # empty org_id is allowed for backward compatibility — process_event
        # already refuses messages without org_id at the gate.
        if not org_id and _registration_run_state is not None:
            _emit_org_missing_metric("store_tool_config_registry", tool_id)
            raise FabricationError(
                f"tool '{tool_id}' cannot be registered without an "
                "organisation (org_id is required)"
            )

        registry_id = os.environ.get("REGISTRY_ID")
        print(f"[store_tool_config_registry] REGISTRY_ID env var: {registry_id}")

        if not registry_id:
            error_msg = "REGISTRY_ID environment variable is not set"
            print(f"[store_tool_config_registry] ERROR: {error_msg}")
            raise ValueError(error_msg)

        # Normalize the schema — strings arrive from the LLM as JSON text.
        if isinstance(tool_schema, str):
            print(
                "[store_tool_config_registry] Converting tool_schema "
                "from string to dict"
            )
            tool_schema = json.loads(tool_schema)

        print(
            f"[store_tool_config_registry] tool_schema type: "
            f"{type(tool_schema)}"
        )

        # Executable tool config — stashed under custom metadata so the cache
        # sync / resolvers can parse it verbatim without colliding with the
        # human description.
        config = {
            "name": tool_id,
            "filename": file_name.split('/')[-1],
            "schema": tool_schema,
            "version": 1,
            "description": tool_description,
        }

        # Custom metadata — serialized into the CUSTOM descriptor inlineContent.
        # state is recorded as "active" to match Requirement 8.4; status is
        # set to APPROVED below via UpdateRegistryRecordStatus. The full
        # ``config`` dict and requester ``createdBy`` are preserved here so
        # that moving the executable config out of the top-level description
        # doesn't lose information (QB-013-2 post-boto3-1.42 refactor). Note
        # that tool records intentionally do NOT carry a ``manifest`` key —
        # that's the agent/tool type discriminator (commit 0a42938). Phase 2b
        # stamps the caller's ``orgId`` so the registry-service mapper can
        # extract it.
        custom_metadata = {
            "categories": [],
            "icon": "",
            "state": "active",
            "config": config,
            "createdBy": requested_by,
            "orgId": org_id,
        }
        # Persist the scoped S3 key so resolve-tool-config.ts (backend) and
        # get_worker_tool can locate the tool code without LLM-supplied keys.
        # The key is read from the per-job map populated by upload_tool_to_s3.
        scoped_key = lookup_tool_key(file_name.split("/")[-1])
        if scoped_key:
            custom_metadata["codeKey"] = scoped_key
        if integration_bindings:
            custom_metadata["integrationBindings"] = integration_bindings
        if datastore_bindings:
            custom_metadata["dataStoreBindings"] = datastore_bindings
        if app_id:
            custom_metadata["appId"] = app_id

        # --- Registration-time spec-binding gate (CIT-256 H2) ---
        # Mirror the worker's dispatch-time check: code-generating tools MUST
        # be bound to an APPROVED ExecutionSpecification.  Fail closed at
        # registration to prevent catalog pollution with ungoverned tools.
        # The gate runs BEFORE CreateRegistryRecord so no orphaned records
        # are created on denial.
        #
        # When spec_id IS provided: full validation via validate_code_tool_binding
        # + assert_spec_approved (conservative: missing outputs = code-gen).
        # When spec_id is NOT provided: only block if the schema EXPLICITLY
        # declares code outputs (outputs list containing "code").  The
        # conservative missing-outputs rule is intentionally relaxed here
        # for backward compatibility — legacy tool registrations that predate
        # spec threading must not break.  The dispatch-time gate in the worker
        # (workerWrapper/index.py) still enforces the conservative rule.
        tool_manifest = {"name": tool_id}
        if isinstance(tool_schema, dict) and "outputs" in tool_schema:
            tool_manifest["outputs"] = tool_schema["outputs"]
        if spec_id is not None:
            try:
                validate_code_tool_binding(tool_manifest, spec_id)
                assert_spec_approved(spec_id)
            except (FabricationError, ValueError) as gate_err:
                _emit_tool_registration_denied_metric(tool_id)
                print(
                    f"[store_tool_config_registry] Spec-approval gate denied "
                    f"registration of '{tool_id}': {gate_err}"
                )
                raise
        elif (
            isinstance(tool_schema, dict)
            and isinstance(tool_schema.get("outputs"), list)
            and "code" in tool_schema["outputs"]
        ):
            # Explicitly-declared code-generating tool without a spec_id:
            # fail closed.
            _emit_tool_registration_denied_metric(tool_id)
            raise FabricationError(
                f"tool '{tool_id}' is code-generating and must be bound to "
                "an approved ExecutionSpecification at registration time "
                "(spec_id required)"
            )

        print(
            f"[store_tool_config_registry] Creating Registry record for tool: "
            f"{tool_id}"
        )

        # Idempotency guard (tool-registration hardening): SQS redeliveries
        # and re-triggers must NOT create a duplicate Registry record for the
        # same tool name. Mirrors the agent idempotency guard in
        # store_agent_config_registry. When a same-org record exists, SKIP
        # creation and approve in place. When a same-name record belongs to
        # ANOTHER org, the registry's name-uniqueness constraint makes
        # creation impossible — surface a clear error.
        existing_record_id = _find_existing_record_id(
            registry_id, tool_id, org_id=org_id,
        )
        if existing_record_id is not None:
            print(
                f"[store_tool_config_registry] Record with name '{tool_id}' "
                f"already exists for this org (recordId={existing_record_id}); "
                f"skipping CreateRegistryRecord"
            )
            record_id = existing_record_id
        else:
            # Check whether the name exists under a DIFFERENT org — if so,
            # the registry's name-uniqueness constraint blocks creation.
            cross_org_record = _find_existing_record_id(
                registry_id, tool_id, org_id="",
            )
            if cross_org_record is not None:
                raise ValueError(
                    f"Tool name '{tool_id}' is already used by another "
                    f"organisation (recordId={cross_org_record}). Choose a "
                    f"different tool name."
                )

            # CreateRegistryRecord does NOT accept a recordId — the service generates
            # one. We use the toolId as the record name so records can be located
            # by name in subsequent operations.
            create_kwargs = {
                "registryId": registry_id,
                "name": tool_id,
                "displayName": tool_id,
                "description": tool_description or "",
                "recordType": "CUSTOM",
                "descriptors": {
                    "custom": {
                        "data": json.dumps(custom_metadata, default=str),
                    },
                },
            }

            def _record_id_from(create_response) -> str:
                # Extract recordId from the ARN returned by CreateRegistryRecord.
                record_arn = create_response.get("recordArn", "")
                return record_arn.rsplit("/", 1)[-1] if "/" in record_arn else tool_id

            response = _get_registry_client().create_registry_record(**create_kwargs)
            record_id = _record_id_from(response)

        print(
            f"[store_tool_config_registry] Record created (recordId={record_id}), "
            f"submitting for approval"
        )

        # Submit for approval (CIT-256 H2): records are created as DRAFT and
        # submitted via SubmitRegistryRecordForApproval.  The registry decides
        # the outcome: APPROVED (auto-approval) or PENDING_APPROVAL (manual
        # review).  This function NEVER writes APPROVED directly.
        # NOTE: UpdateRegistryRecordStatus validates status against the enum
        # {CREATE_FAILED, DRAFT, UPDATING, PENDING_APPROVAL, UPDATE_FAILED,
        # DEPRECATED, APPROVED, CREATING, REJECTED} — the old "PUBLISHED"
        # value raised a live ValidationException.
        def _approve(rid: str) -> str:
            """Ensure the record reaches an approved or pending-approval state.

            Reads the record's current status first so that reused records
            that are already APPROVED or PENDING_APPROVAL are never
            re-submitted (the registry rejects SubmitRegistryRecordForApproval
            on non-DRAFT records with ValidationException 'Cannot submit the
            record for approval in current status: APPROVED').

            State table:
              APPROVED          → return 'approved' immediately
              PENDING_APPROVAL  → return 'pending_approval' immediately
              DRAFT             → submit for approval, map the result
              CREATING          → caller handles via the CREATING-recovery path
              REJECTED / DEPRECATED → raise (terminal, non-recoverable)
              other             → submit and hope (forward-compatible)

            Returns 'approved' or 'pending_approval'.
            Raises on genuinely stuck CREATING or unexpected terminal states.
            """
            client = _get_registry_client()

            # Read current status before attempting submission.
            current = client.get_registry_record(
                registryId=registry_id, recordId=rid,
            )
            current_status = (current or {}).get("status")

            if current_status == "APPROVED":
                print(
                    f"[store_tool_config_registry] Record {rid} is already "
                    f"APPROVED — skipping submission"
                )
                return "approved"
            if current_status == "PENDING_APPROVAL":
                print(
                    f"[store_tool_config_registry] Record {rid} is already "
                    f"PENDING_APPROVAL — skipping submission"
                )
                return "pending_approval"
            if current_status in ("REJECTED", "DEPRECATED"):
                raise RuntimeError(
                    f"Registry record {rid} is in terminal status "
                    f"{current_status!r} and cannot be approved. "
                    f"Create a new record or ask an operator to update it."
                )

            # DRAFT (or any other submittable status) → submit for approval.
            # Live-oracle-verified transition (2026-08-02 scratch-record probe
            # on bedrock-agentcore-control, us-west-2): the two-step
            # UpdateRegistryRecordStatus(DRAFT->PENDING_APPROVAL->APPROVED)
            # sequence is REJECTED by the live service. The proven legal path
            # is SubmitRegistryRecordForApproval, which returns
            # status=APPROVED synchronously when auto-approval is configured,
            # or PENDING_APPROVAL when manual review is enabled.
            response = client.submit_registry_record_for_approval(
                registryId=registry_id,
                recordId=rid,
            )
            status = (response or {}).get("status")
            if status == "APPROVED":
                return "approved"
            if status == "PENDING_APPROVAL":
                print(
                    f"[store_tool_config_registry] Record {rid} entered "
                    f"manual review (PENDING_APPROVAL) — successful submission"
                )
                return "pending_approval"
            # Neither auto-approved nor pending review — confirm via a fresh
            # read before failing.
            confirm = client.get_registry_record(
                registryId=registry_id, recordId=rid,
            )
            confirmed_status = (confirm or {}).get("status")
            if confirmed_status == "APPROVED":
                return "approved"
            if confirmed_status == "PENDING_APPROVAL":
                print(
                    f"[store_tool_config_registry] Record {rid} confirmed as "
                    f"PENDING_APPROVAL via get_registry_record"
                )
                return "pending_approval"
            raise RuntimeError(
                f"submit_registry_record_for_approval did not reach "
                f"APPROVED or PENDING_APPROVAL for recordId {rid} "
                f"(response status={status!r}, confirmed status="
                f"{confirmed_status!r})"
            )

        approval_status = "approved"  # default for recovery path
        try:
            approval_status = _approve(record_id)
        except Exception as approve_err:  # noqa: BLE001 — classified below
            if not is_creating_conflict(approve_err):
                raise
            # Kill→poison→kill fix (live evidence 2026-07-23): a record stuck
            # in CREATING (orphaned by a prior SIGKILLed run, or an unusually
            # slow asynchronous creation) makes UpdateRegistryRecordStatus
            # raise ConflictException 'Registry record cannot be modified
            # while in CREATING state'. The condition is NOT transient from
            # within this run — the record never leaves CREATING on its own —
            # so it must never be blindly retried (the LLM previously retried
            # it 92-110×, burning ~92% of the 900s Lambda budget). Run the
            # bounded, SDK-documented recovery instead: poll briefly for the
            # record to settle, then approve it IN PLACE, else fail FAST with
            # a terminal, user-actionable error. Recovery never creates or
            # deletes a Registry record — see registry_recovery.py for the
            # full justification (zero-net-new-orphans is structural).
            print(
                f"[store_tool_config_registry] ConflictException on CREATING "
                f"for '{tool_id}' (recordId {record_id}) — entering bounded "
                f"recovery (poll -> approve in place -> fail fast)"
            )
            record_id = recover_creating_record(
                _get_registry_client(),
                registry_id,
                record_id,
                tool_id,
                approve=_approve,
            )

        # Watchdog checkpoint after the registration: if the margin is gone,
        # stop BEFORE the agent loop starts another multi-minute generation —
        # process_event turns this into a terminal 'timed out' FAILED write
        # instead of the run being SIGKILLed later.
        registration_checkpoint(f"after tool registration '{tool_id}'")

        print(f"[store_tool_config_registry] SUCCESS - recordId={record_id}")
        run_state = _registration_run_state
        if run_state is not None:
            run_state.succeeded.add(tool_id)
            # Track approval status so the fabrication-status write can
            # surface 'pending_approval' to the intake conversation.
            if approval_status == "pending_approval":
                run_state.pending_approval.add(tool_id)
        return True

    except Exception as e:
        print(
            f"[store_tool_config_registry] EXCEPTION: "
            f"{type(e).__name__}: {str(e)}"
        )
        import traceback
        print(f"[store_tool_config_registry] TRACEBACK: {traceback.format_exc()}")
        # Publish fabrication failure event to EventBridge. Failures here are
        # non-fatal — we still re-raise the original error. Within a
        # registration run the event is deduped to ONE per (tool_id, error
        # type): live evidence (2026-07-23) showed tool.fabrication.failed
        # published 45-53× per run because the LLM re-called the failing tool
        # on every retry iteration. A terminal orphaned-record failure also
        # LATCHES the tool_id so repeat calls fail instantly (see the latch
        # check at the top). Direct calls outside a run keep the legacy
        # one-event-per-call behavior.
        run_state = _registration_run_state
        if run_state is not None:
            run_state.failed[tool_id] = str(e)[:500]
        if run_state is not None and isinstance(e, OrphanedRegistryRecordError):
            run_state.latched.setdefault(tool_id, str(e))
        publish_key = (tool_id, type(e).__name__)
        if run_state is not None and publish_key in run_state.published:
            print(
                f"[store_tool_config_registry] Failure event for {publish_key} "
                f"already published this run; skipping duplicate"
            )
        else:
            if run_state is not None:
                run_state.published.add(publish_key)
            try:
                publish_fabrication_event(
                    orchestration_id="0",
                    event_type="tool.fabrication.failed",
                    agent_id=tool_id,
                    error=str(e),
                    app_id=app_id,
                )
            except Exception as pub_err:
                print(
                    f"[store_tool_config_registry] Failed to publish failure event: "
                    f"{pub_err}"
                )
        raise


# ---------------------------------------------------------------------------
# Confined file-write tool — replaces raw file_write from strands_tools.
# The fabricator only needs to write generated code to /tmp/ before S3 upload.
# This tool validates paths so the LLM cannot escape /tmp/.
# ---------------------------------------------------------------------------

_JOB_DIR = "/tmp"


@tool
def write_job_file(file_name: str, content: str) -> str:
    """Write generated code to a file inside the job directory (/tmp).

    Args:
        file_name: Basename of the file to create (e.g. "validate_email.py").
                   Must not contain path separators or traversal sequences.
        content:   The file content to write.

    Returns:
        The absolute path of the written file.
    """
    import pathlib

    # Reject absolute paths and any traversal
    if not file_name or not isinstance(file_name, str):
        raise ValueError("file_name must be a non-empty string")
    if file_name.startswith("/") or file_name.startswith("\\"):
        raise ValueError(
            f"Absolute paths are not allowed: {file_name!r}. "
            "Provide a plain filename like 'my_tool.py'."
        )
    if ".." in file_name.split("/") or ".." in file_name.split("\\"):
        raise ValueError(
            f"Path traversal is not allowed: {file_name!r}. "
            "Provide a plain filename like 'my_tool.py'."
        )

    resolved = pathlib.Path(_JOB_DIR, file_name).resolve()
    job_root = pathlib.Path(_JOB_DIR).resolve()
    if not str(resolved).startswith(str(job_root) + "/") and resolved != job_root:
        raise ValueError(
            f"Resolved path {resolved} escapes job directory {job_root}"
        )

    resolved.parent.mkdir(parents=True, exist_ok=True)
    resolved.write_text(content)
    return str(resolved)


def create_tool_fabricator(store_tool_tool=None):
    """Create and return the Tool Fabricator agent.

    Args:
        store_tool_tool: Optional override for the registry storage tool,
            used to bind a ``requested_by`` value via a closure wrapper
            (see ``process_event``). Defaults to the module-level
            ``store_tool_config_registry`` which uses the legacy
            ``"fabricator"`` default.
    """
    if store_tool_tool is None:
        store_tool_tool = store_tool_config_registry

    bedrock_model = models.BedrockModel(
        model_id=FABRICATOR_MODEL_ID,
        max_tokens=32768,
        region_name="us-west-2",
        boto_client_config=BEDROCK_RETRY_CONFIG,
        # The fabricator is headless: per-token chunks are consumed only
        # internally by the Strands loop (user-visible progress is per-agent
        # EventBridge, not per-token). streaming=False routes through the
        # Converse API instead of ConverseStream, so transient model faults
        # (internalServerException, ...) surface PRE-response — inside
        # botocore's retry scope (BEDROCK_RETRY_CONFIG, adaptive) — instead
        # of as mid-stream EventStreamErrors that NO layer retries.
        # BEDROCK_RETRY_CONFIG's read_timeout=3600 accommodates the long
        # non-streaming call at max_tokens=32768.
        streaming=False,
    )
    
    tool_fabricator = Agent(
        bedrock_model,
        tools=[write_job_file, upload_tool_to_s3, store_tool_tool],
        system_prompt=get_tool_fabricator_prompt()
    )
    
    return tool_fabricator

# Tool for Agent Fabricator to request custom tool creation


def _make_create_custom_tool(
    *,
    org_id: str,
    requested_by: str,
    spec_id: str | None,
):
    """Build the ``create_custom_tool`` @tool with the caller's org bound.

    CIT-302 fix: the nested Tool Fabricator MUST register tools under the
    same organisation as the outer Agent Fabricator run.  Previously
    ``create_custom_tool`` called ``create_tool_fabricator()`` with no
    bound store-tool closure, so the inner agent used the module-level
    ``store_tool_config_registry`` whose ``org_id`` parameter defaulted to
    ``""`` — the LLM never supplied it, and the ContextVar is only
    consulted by ``upload_to_s3``, not by the registry function's own
    ``org_id`` parameter.  The tool was therefore registered without an
    org.

    Fix: capture ``org_id``, ``requested_by``, and ``spec_id`` from the
    validated event at tool-creation time (closure, NOT LLM-supplied) and
    thread them into a bound ``store_tool_config_registry`` wrapper, the
    same pattern ``process_event`` already uses for the direct
    tool-creation path.
    """

    @tool
    def create_custom_tool(
        tool_description: str,
        integration_bindings: list | None = None,
        datastore_bindings: list | None = None,
    ) -> str:
        """Request the Tool Fabricator to create a custom tool.

        Args:
            tool_description: Detailed description of what the tool should do
            integration_bindings: Optional list of integration binding dicts
            datastore_bindings: Optional list of data store binding dicts

        Returns:
            The generated tool code as a string
        """
        # Watchdog checkpoint: a nested tool fabrication is a multi-minute
        # operation (a whole inner Strands agent run). Refuse to START one
        # inside the Lambda's safety margin so process_event can write the
        # terminal 'timed out' status instead of the run being SIGKILLed midway.
        registration_checkpoint(
            f"before custom tool fabrication: {tool_description[:80]!r}"
        )
        print(f"Agent Fabricator requesting custom tool: {tool_description}")

        # CIT-302: bind the outer run's org/requester/spec into the nested
        # fabricator so tool records are registered under the correct org.
        @tool
        def store_tool_config_registry_nested(
            file_name: str,
            tool_id: str,
            tool_schema: Any,
            tool_description: str,
            integration_bindings: list | None = None,
            datastore_bindings: list | None = None,
            app_id: str = None,
        ) -> bool:
            """Store tool configuration in AgentCore Registry."""
            return store_tool_config_registry(
                file_name=file_name,
                tool_id=tool_id,
                tool_schema=tool_schema,
                tool_description=tool_description,
                integration_bindings=integration_bindings,
                datastore_bindings=datastore_bindings,
                app_id=app_id,
                requested_by=requested_by,
                org_id=org_id,
                spec_id=spec_id,
            )

        # Create the Tool Fabricator agent with the org-bound store tool
        tool_fabricator = create_tool_fabricator(
            store_tool_tool=store_tool_config_registry_nested,
        )

        # Enrich the description with binding context if provided
        enriched_description = tool_description
        if integration_bindings or datastore_bindings:
            binding_context_parts = []
            if integration_bindings:
                for binding in integration_bindings:
                    parts = [f"Integration type: {binding.get('integrationType', 'unknown')}"]
                    if binding.get('operations'):
                        parts.append(f"Operations: {', '.join(binding['operations'])}")
                    if binding.get('authMethod'):
                        parts.append(f"Auth method: {binding['authMethod']}")
                    binding_context_parts.append('; '.join(parts))
            if datastore_bindings:
                for binding in datastore_bindings:
                    parts = [f"Data store type: {binding.get('dataStoreType', 'unknown')}"]
                    if binding.get('operations'):
                        parts.append(f"Operations: {', '.join(binding['operations'])}")
                    binding_context_parts.append('; '.join(parts))
            binding_context = "\n".join(binding_context_parts)
            enriched_description = (
                f"{tool_description}\n\n"
                f"BINDING CONTEXT (use scoped credentials from environment variables):\n"
                f"{binding_context}\n\n"
                f"When calling store_tool_config_registry, pass these bindings:\n"
                f"integration_bindings={json.dumps(integration_bindings) if integration_bindings else 'None'}\n"
                f"datastore_bindings={json.dumps(datastore_bindings) if datastore_bindings else 'None'}"
            )

        # Call the Tool Fabricator agent
        result = tool_fabricator(f"Create a custom tool with the following requirements: {enriched_description}")

        print(f"Tool Fabricator response: {result}")
        return result

    return create_custom_tool

def create_agent_fabricator(complete_task, store_agent_tool=None, org_id: str = "", create_custom_tool_tool=None):
    """Create and return the Agent Fabricator agent.

    Args:
        complete_task: The per-request completion tool (closure over the
            current orchestration context).
        store_agent_tool: Optional override for the registry storage tool,
            used to bind a ``requested_by`` value via a closure wrapper
            (see ``process_event``). Defaults to the module-level
            ``store_agent_config_registry`` which uses the legacy
            ``"fabricator"`` default.
        org_id: The caller's organisation id, threaded to the prompt builder
            so the tool catalogue is scoped.
        create_custom_tool_tool: Optional org-bound ``create_custom_tool``
            @tool produced by ``_make_create_custom_tool``. When ``None``
            a legacy unbound tool is built that registers tools without an
            org (backward-compat for direct callers outside ``process_event``).
    """
    if store_agent_tool is None:
        store_agent_tool = store_agent_config_registry
    if create_custom_tool_tool is None:
        # Legacy fallback — direct callers outside process_event.
        create_custom_tool_tool = _make_create_custom_tool(
            org_id="", requested_by="fabricator", spec_id=None,
        )

    bedrock_model = models.BedrockModel(
            model_id=FABRICATOR_MODEL_ID,
            max_tokens=32768,
            region_name="us-west-2",
            boto_client_config=BEDROCK_RETRY_CONFIG,
            # Headless fabricator — see create_tool_fabricator: streaming=False
            # converts unretryable mid-stream faults into pre-response faults
            # covered by BEDROCK_RETRY_CONFIG's adaptive retry.
            streaming=False,
    )
    
    agent_fabricator = Agent(
        bedrock_model,
        tools=[write_job_file, get_worker_tool, create_custom_tool_tool,
            upload_agent_to_s3, store_agent_tool, complete_task],
        system_prompt=get_agent_fabricator_prompt(org_id=org_id)
    )
    
    return agent_fabricator

def process_event(event, context, request_type=None):
    # Tier-3 agent-import (ARBITER-A): the 'manifest-proposal' path proposes an
    # agent capability descriptor from non-secret signals. It uses a DIFFERENT
    # event shape ({requestId, correlationId, importId, signals}) and MUST NOT
    # run the taskDetails extraction, the design-assessment gate, or the
    # code-fabrication path — it proposes a descriptor, it never generates or
    # executes code. Handle it first and return.
    if request_type == "manifest-proposal":
        _process_manifest_proposal(event)
        return

    # Poison-queue defence (Tier-3 invariant 5): an UNRECOGNISED requestType is
    # a safe no-op — log and return without publishing an event or raising. A
    # raise here would nack the SQS message and retry the poison forever. The
    # known fabrication request types (legacy/direct=None, "agent-creation",
    # "tool-creation") fall through to the existing code-fabrication path
    # unchanged.
    if request_type not in (None, "", "agent-creation", "tool-creation"):
        logger.warning(
            "process_event: ignoring unrecognised requestType=%r (safe no-op)",
            request_type,
        )
        return

    # Get values with defaults for direct requests
    orchestration_id = event.get("orchestration_id", "0")
    agent_use_id = event.get("agent_use_id", "unknown")
    requested_by = event.get("requested_by") or "fabricator"
    # Tenancy fail-closed (design evidence, section C): org_id is now
    # REQUIRED and must be non-empty for every agent-creation/tool-creation
    # (and legacy direct, request_type=None) message. The TS resolver
    # (fabricator-request-resolver.ts) always stamps a server-derived,
    # non-null org_id via requireOrgId before enqueueing -- a missing/empty
    # org_id here means either a pre-migration message or a bypass of that
    # resolver, and must be refused rather than silently fabricated without
    # tenancy. Refuse = log at ERROR, do NOT process, do NOT create any
    # registry/status records, and do NOT raise (safe no-op, mirrors the
    # unrecognised-requestType poison-queue defence above: a raise would
    # nack the SQS message and retry the poison forever).
    #
    # Two producers stamp this value under DIFFERENT keys and both must be
    # accepted: service/agent_intake_single/tools/fabricate.py's
    # _send_to_fabricator sends snake_case "org_id" (matches this module's
    # own DynamoDB/EventBridge attribute naming), while
    # arbiter/supervisor/index.py's generic worker-dispatch payload (wave 2a)
    # sends camelCase "orgId" (matches the orchestration row's `orgId`
    # attribute it was read from). Reading only one key silently refuses
    # Supervisor-originated fabrication requests, so both are checked here;
    # snake_case is preferred when a message somehow carries both.
    org_id = event.get("org_id") or event.get("orgId") or ""
    if not org_id:
        logger.error(
            "process_event: refusing message with missing/empty org_id "
            "(orchestration_id=%s, agent_use_id=%s, requestType=%r) -- "
            "no organization is provisioned for this request",
            orchestration_id, agent_use_id, request_type,
        )
        return
    request = event.get("agent_input", {})
    agent_name = event.get('node', 'fabricator')
    agent_index = event.get("agent_index", 0)
    total_agents = event.get("total_agents", 1)

    # CIT-250 pattern: bind org + job into ContextVars so upload_to_s3
    # derives tenant-scoped keys from validated event fields, never from
    # LLM-supplied arguments.
    fabrication_org_id.set(org_id)
    fabrication_job_id.set(orchestration_id)

    TASK = request.get("taskDetails", None)
    
    # Extract binding metadata from the fabrication request
    integration_bindings = request.get("integrationBindings", None)
    datastore_bindings = request.get("dataStoreBindings", None)

    # CIT-256 H2: thread the ExecutionSpecification id so the registration-
    # time spec-approval gate can verify the tool is bound to an approved
    # spec.  The field is optional — absent for legacy messages and non-code-
    # generating tool requests.  Both snake_case and camelCase keys are
    # accepted (same convention as org_id above).
    spec_id: str | None = (
        event.get("spec_id")
        or event.get("specId")
        or request.get("spec_id")
        or request.get("specId")
        or None
    )
    if TASK is None:
        # Do not log the full event: agent_input may embed integration/
        # datastore bindings containing credentials. Log only a safe count.
        print(
            "Error: No taskDetails found in agent_input "
            f"(event key count={len(event) if isinstance(event, dict) else 0})"
        )
        raise ValueError("taskDetails is required in agent_input")

    # US-ARB-017 precondition gate. Forward-compatible: no-op when projectId
    # is not present in agent_input (today's reality since Citadel has no
    # Project<->App linkage). When projectId is present, refuse fabrication
    # unless the referenced AgentDesignAssessment row exists and is
    # completed (or grandfathered=True).
    project_id = request.get('projectId') or request.get('project_id')
    # PR 4 fallback: if the TS resolver didn't propagate projectId (older
    # apps, or records created directly against the registry bypassing
    # AgentApp), attempt to resolve it from the registry record's
    # customDescriptorContent via the PR 1 catalog bridge. Graceful degrade
    # if the client is unavailable (keeps fabricator resilient in
    # partial-deploy environments).
    if project_id is None:
        registry_id = os.environ.get('REGISTRY_ID')
        record_id = (
            request.get('agentId')
            or request.get('recordId')
            or request.get('agent_id')
        )
        if registry_id and record_id:
            try:
                from catalog.registry_client import get_source_project_id
                project_id = get_source_project_id(registry_id, record_id)
                if project_id:
                    # projectId/registry_id/record_id omitted (env- and
                    # event-derived, taint-conflated as secret). Log only that
                    # the fallback resolution succeeded.
                    logger.info(
                        'fabricator: resolved projectId from registry record '
                        '(fallback path)'
                    )
            except ImportError:
                # catalog Layer not attached (unexpected post-PR-2 but keep
                # fallback safe).
                logger.warning(
                    'fabricator: catalog.registry_client unavailable; '
                    'skipping projectId fallback'
                )
            except Exception as exc:  # noqa: BLE001 - intentional broad catch
                logger.warning(
                    'fabricator: projectId fallback raised %s; '
                    'continuing with project_id=None',
                    exc,
                )
    grandfathered = bool(request.get('grandfathered', False))
    try:
        check_design_assessment(project_id, grandfathered=grandfathered)
    except DesignAssessmentMissingError as exc:
        # Surface as an explicit error back to the caller. SQS events with
        # no ack will naturally retry -- caller must either supply a valid
        # projectId + completed assessment or set grandfathered=True.
        print(f"fabrication refused: {exc}")
        raise

    # Deadline-aware execution (kill→poison→kill fix, live 2026-07-23): wrap
    # the REAL Lambda remaining-time clock so the registration checkpoints
    # and the transient-retry helper can stop work inside the safety margin
    # and this handler can write the terminal status INSTEAD of being
    # SIGKILLed at the 900s timeout (which skips every except/finally and
    # leaves the row PROCESSING + the SQS message redelivering). Local runs
    # and tests passing {} degrade to an unlimited deadline.
    deadline = FabricationDeadline.from_lambda_context(context)
    set_fabrication_deadline(deadline)
    # Fresh per-run registration bookkeeping (failure-event dedupe + the
    # non-retryable latch) — Lambda containers are reused, so this must be
    # reset for every SQS record.
    _begin_registration_run()
    try:
        # Durable status: mark this agent PROCESSING at the start. Best-effort
        # — a status-write failure never changes fabrication behavior.
        _write_fabrication_status(
            orchestration_id, agent_use_id, "PROCESSING", agent_name=agent_use_id,
            org_id=org_id,
        )

        # since this needs variable injection, keep within handler method scope.
        @tool
        def complete_task():
            """Finally, call this to indicate the task has been completed"""
            client = boto3.client('events')
            COMPLETION_BUS_NAME = os.environ.get('COMPLETION_BUS_NAME')
            
            # Publish intake implementation progress
            publish_intake_progress(orchestration_id, agent_index, total_agents, agent_use_id)
            
            # Publish fabrication success event
            publish_fabrication_event(
                orchestration_id=orchestration_id,
                event_type='agent.fabricated',
                agent_id=agent_use_id
            )
            
            # Check if this is a direct request (orchestration_id == '0') or part of an orchestration
            if orchestration_id == '0':
                # Direct request from UI - send agent.fabricated event
                completion_event = {
                    'Source': 'agent.fabricated',
                    'DetailType': 'agent.fabricated',
                    'EventBusName': COMPLETION_BUS_NAME,
                    'Detail': json.dumps({
                        'orchestration_id': orchestration_id,
                        'data': 'Capability has been created',
                        'agent_use_id': agent_use_id,
                        'node': agent_name
                    })
                }
            else:
                # Part of orchestration - send task.completion event
                completion_event = {
                    'Source': 'task.completion',
                    'DetailType': 'task.completion',
                    'EventBusName': COMPLETION_BUS_NAME,
                    'Detail': json.dumps({
                        'orchestration_id': orchestration_id,
                        'data': 'Capability has been created, try to invoke it again.',
                        'agent_use_id': agent_use_id,
                        'node': agent_name
                    })
                }

            print("Completed")

            response = client.put_events(
                Entries=[
                    completion_event
                ]
            )
            print(f"event posted: {response}")
            return f"event posted: {completion_event}"

        if request_type == "tool-creation":
            # Bind requested_by into a closure-wrapped @tool so the LLM
            # invocation path records the event's requester in custom
            # metadata's createdBy field. org_id (Phase 2b) is bound the same
            # way so the registry record's orgId reflects the caller's org.
            # spec_id (CIT-256 H2) is bound for the registration-time
            # spec-approval gate.
            @tool
            def store_tool_config_registry_bound(
                file_name: str,
                tool_id: str,
                tool_schema: Any,
                tool_description: str,
                integration_bindings: list | None = None,
                datastore_bindings: list | None = None,
                app_id: str = None,
            ) -> bool:
                """Store tool configuration in AgentCore Registry."""
                return store_tool_config_registry(
                    file_name=file_name,
                    tool_id=tool_id,
                    tool_schema=tool_schema,
                    tool_description=tool_description,
                    integration_bindings=integration_bindings,
                    datastore_bindings=datastore_bindings,
                    app_id=app_id,
                    requested_by=requested_by,
                    org_id=org_id,
                    spec_id=spec_id,
                )

            # Create and invoke the Tool Fabricator
            tool_fabricator = create_tool_fabricator(store_tool_tool=store_tool_config_registry_bound)
            # Enrich the task description with binding context for the LLM
            enriched_task = TASK
            if integration_bindings or datastore_bindings:
                binding_context_parts = []
                if integration_bindings:
                    for binding in integration_bindings:
                        parts = [f"Integration type: {binding.get('integrationType', 'unknown')}"]
                        if binding.get('operations'):
                            parts.append(f"Operations: {', '.join(binding['operations'])}")
                        if binding.get('authMethod'):
                            parts.append(f"Auth method: {binding['authMethod']}")
                        binding_context_parts.append('; '.join(parts))
                if datastore_bindings:
                    for binding in datastore_bindings:
                        parts = [f"Data store type: {binding.get('dataStoreType', 'unknown')}"]
                        if binding.get('operations'):
                            parts.append(f"Operations: {', '.join(binding['operations'])}")
                        binding_context_parts.append('; '.join(parts))
                binding_context = "\n".join(binding_context_parts)
                enriched_task = (
                    f"{TASK}\n\n"
                    f"BINDING CONTEXT (use scoped credentials from environment variables):\n"
                    f"{binding_context}\n\n"
                    f"When calling store_tool_config_registry, pass these bindings:\n"
                    f"integration_bindings={json.dumps(integration_bindings) if integration_bindings else 'None'}\n"
                    f"datastore_bindings={json.dumps(datastore_bindings) if datastore_bindings else 'None'}"
                )
            # Bounded transient retry (defence in depth on top of
            # streaming=False + botocore adaptive retries): re-invoke the
            # fabricator ONLY on transient Bedrock faults (internal server /
            # service unavailable / throttling / model stream errors), with
            # exponential backoff + full jitter. Non-transient faults
            # (ValidationException, AccessDenied, ...) fail fast to the
            # except below unchanged. The deadline stops attempts/backoffs
            # that cannot fit before (deadline - safety margin).
            call_with_transient_retry(
                lambda: tool_fabricator(enriched_task), deadline=deadline
            )
        else:
            # Bind requested_by into a closure-wrapped @tool so the LLM
            # invocation path records the event's requester in custom
            # metadata's createdBy field. org_id (Phase 2b) is bound the same
            # way so the registry record's orgId reflects the caller's org.
            @tool
            def store_agent_config_registry_bound(
                file_name: str,
                agent_id: str,
                llm_tool_schema: Any,
                agent_description: str,
                app_id: str = None,
            ) -> bool:
                """Store agent configuration in AgentCore Registry."""
                return store_agent_config_registry(
                    file_name=file_name,
                    agent_id=agent_id,
                    llm_tool_schema=llm_tool_schema,
                    agent_description=agent_description,
                    app_id=app_id,
                    requested_by=requested_by,
                    org_id=org_id,
                    source_project_id=orchestration_id,
                )

            # Create the Agent Fabricator with access to create_custom_tool
            # CIT-302: build an org-bound create_custom_tool so nested tool
            # fabrication registers under the outer run's organisation.
            bound_create_custom_tool = _make_create_custom_tool(
                org_id=org_id,
                requested_by=requested_by,
                spec_id=spec_id,
            )
            agent_fabricator = create_agent_fabricator(
                complete_task,
                store_agent_tool=store_agent_config_registry_bound,
                org_id=org_id,
                create_custom_tool_tool=bound_create_custom_tool,
            )
            # Bounded transient retry — same contract as the tool-creation
            # path above: transient Bedrock faults only, ≤3 total attempts,
            # exponential backoff + full jitter; everything else fails fast.
            # The deadline stops attempts/backoffs that cannot fit before
            # (deadline - safety margin).
            call_with_transient_retry(
                lambda: agent_fabricator(TASK), deadline=deadline
            )

        # Belt-and-braces: if a checkpoint tripped but the BaseException was
        # converted into an LLM-visible tool error somewhere inside the agent
        # loop (instead of propagating), the run is NOT complete — surface it
        # as the timeout it is rather than writing COMPLETED for a job whose
        # registrations were refused.
        if deadline.tripped:
            raise FabricationDeadlineExceeded(
                f"deadline tripped at {deadline.tripped_where!r} during the "
                f"fabrication run"
            )

        # Durable status: fabrication dispatch completed without raising.
        # Branch on this run's registration bookkeeping (ADDITIVE signal
        # only — the {PENDING, PROCESSING, COMPLETED, FAILED} enum contract
        # is unchanged; see _RegistrationRunState / registrationErrors):
        #   - no registration failures         -> bare COMPLETED (unchanged)
        #   - some succeeded, some failed       -> COMPLETED + registrationErrors
        #   - every registration failed         -> FAILED + errorMessage +
        #     registrationErrors, then RETURN CLEANLY (no re-raise) so the
        #     SQS message is consumed rather than redelivered into a run
        #     that will fail identically (mirrors the deadline-guard
        #     philosophy: durable FAILED row + clean return).
        run_state = _registration_run_state
        registration_errors = None
        if run_state is not None and run_state.failed:
            registration_errors = [
                {"toolId": tool_id, "error": err}
                for tool_id, err in run_state.failed.items()
            ]

        if run_state is not None and run_state.failed and not run_state.succeeded:
            all_failed_message = (
                "All tool registrations failed for this agent: "
                + "; ".join(
                    f"{tool_id}: {err}" for tool_id, err in run_state.failed.items()
                )
            )
            print(f"All tool registrations failed: {all_failed_message}")
            _write_fabrication_status(
                orchestration_id, agent_use_id, "FAILED",
                error_message=all_failed_message[:1000],
                agent_name=agent_use_id,
                registration_errors=registration_errors,
                org_id=org_id,
            )
            return

        _write_fabrication_status(
            orchestration_id, agent_use_id, "COMPLETED",
            agent_id=agent_use_id, agent_name=agent_use_id,
            registration_errors=registration_errors,
            org_id=org_id,
            # Always write registryApprovalStatus on COMPLETED jobs so the
            # intake status-check never falls back to a dangerous default.
            # Priority: pending_approval > draft > approved.
            registry_approval_status=(
                "pending_approval"
                if run_state is not None and run_state.pending_approval
                else "approved"
            ),
            # Stamp the registry record id and sanitised registry name onto
            # the job row so postfab can resolve the agent's live registry
            # status by exact record id (one GetRegistryRecord call) instead
            # of passing the display name through the ListRegistryRecords name
            # filter (which rejects names with spaces/special characters).
            registry_record_id=(
                next(iter(run_state.agent_record_info.values()), (None,))[0]
                if run_state is not None and run_state.agent_record_info
                else None
            ),
            registry_name=(
                next(iter(run_state.agent_record_info.values()), (None, None))[1]
                if run_state is not None and run_state.agent_record_info
                else None
            ),
        )

    except FabricationDeadlineExceeded as deadline_exc:
        # Time exhaustion (kill→poison→kill fix): the watchdog stopped work
        # inside the safety margin. Write the job's terminal FAILED status
        # with a 'timed out' actionable message and RETURN CLEANLY — this is
        # the whole point of the guard: the terminal write happens INSTEAD
        # of the SIGKILL. Deliberately no re-raise: re-raising would nack
        # the SQS message and redeliver it into another 900s run that hits
        # the same wall (the observed kill→redeliver→kill ×3 → DLQ loop,
        # rows stuck PROCESSING). Returning deletes the message; the durable
        # outcome is the FAILED row, and the user re-queues via the
        # conversational retry tool.
        print(f"Fabrication stopped by deadline guard: {deadline_exc}")
        timeout_message = timed_out_failure_message(agent_use_id, deadline)
        _write_fabrication_status(
            orchestration_id, agent_use_id, "FAILED",
            error_message=timeout_message,
            agent_name=agent_use_id,
            org_id=org_id,
        )
        # Best-effort failure signals: the CLEAN RETURN is the loop-breaker,
        # so a failing EventBridge publish must never turn this path back
        # into a raise (which would nack + redeliver the message).
        try:
            # Publish intake progress failure
            publish_intake_progress(orchestration_id, agent_index, total_agents, agent_use_id, failed=True)
            # Publish fabrication failure event
            publish_fabrication_event(
                orchestration_id=orchestration_id,
                event_type='agent.fabrication.failed',
                error=timeout_message
            )
        except Exception as pub_err:  # noqa: BLE001 — best-effort by design
            print(
                f"Failed to publish deadline-failure signals (non-fatal): "
                f"{pub_err}"
            )
        return

    except Exception as e:
        print(f"Fabrication failed: {str(e)}")
        # Durable status: mark FAILED + errorMessage before re-raising. The
        # retry wrapper above guarantees transient Bedrock faults reach here
        # only AFTER the retry budget is exhausted, so FAILED is written once,
        # at the end — never mid-retry. The status write is best-effort and
        # must not mask the original error. user_actionable_failure_message
        # keeps the raw Bedrock detail while telling the operator what to do
        # next (non-transient errors pass through unchanged).
        _write_fabrication_status(
            orchestration_id, agent_use_id, "FAILED",
            error_message=user_actionable_failure_message(e),
            agent_name=agent_use_id,
            org_id=org_id,
        )
        # Publish intake progress failure
        publish_intake_progress(orchestration_id, agent_index, total_agents, agent_use_id, failed=True)
        # Publish fabrication failure event
        publish_fabrication_event(
            orchestration_id=orchestration_id,
            event_type='agent.fabrication.failed',
            error=str(e)
        )
        raise
    finally:
        # Lambda containers are reused: never leak this run's deadline or
        # registration bookkeeping into the next invocation. Runs on the
        # success path, the clean deadline return, and every re-raise.
        clear_fabrication_deadline()
        _end_registration_run()
        # Reset tenant-scoped ContextVars so a reused Lambda container
        # never leaks one run's org/job into the next.
        fabrication_org_id.set("")
        fabrication_job_id.set("")
        fabrication_tool_keys.set(None)

    # Fallback: ensure progress is published even if the LLM didn't call complete_task
    publish_intake_progress(orchestration_id, agent_index, total_agents, agent_use_id)


def _idempotency_table():
    """Return the shared idempotency table resource (CIT-125 slice B).

    Lazily resolved on each call so tests can patch it without needing
    IDEMPOTENCY_TABLE bound at import time — mirrors the existing lazy
    `boto3.resource('dynamodb')` call sites already in this module (e.g.
    store_agent_config_dynamo).
    """
    import boto3 as _boto3
    return _boto3.resource('dynamodb').Table(IDEMPOTENCY_TABLE)


def _claim_message_id(message_id: str) -> str:
    """Two-phase claim on the SQS `messageId` (design B.1, fabricator side).

    A bare single-claim guard (like the supervisor's) is not enough here:
    fabrication is long-running and partially side-effecting (registers
    agents/tools, creates roles), so a redelivery arriving WHILE the first
    attempt is still in flight must be distinguished from a redelivery
    AFTER it already completed.

    Returns one of:
      - "CLAIMED": first sight — PENDING record written, proceed with
        fabrication.
      - "ALREADY_PENDING": an earlier attempt's PENDING record still
        exists — do NOT re-enter the fabrication body; route to reconcile
        (a poisoned-then-fixed message may have partially fabricated).
      - "ALREADY_DONE": a prior attempt already completed — no-op.

    Any ClientError other than the conditional-check failure on the initial
    claim PutItem is rethrown so the message is redelivered/DLQ'd rather
    than silently swallowed.
    """
    import time as _time
    now = int(_time.time())
    table = _idempotency_table()
    try:
        table.put_item(
            Item={
                "eventId": message_id,
                "ttl": now + IDEMPOTENCY_TTL_SECONDS,
                "consumer": "fabricator",
                "status": "PENDING",
                "claimedAt": now,
            },
            ConditionExpression="attribute_not_exists(eventId)",
        )
        return "CLAIMED"
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
        existing = table.get_item(Key={"eventId": message_id}).get("Item") or {}
        if existing.get("status") == "DONE":
            return "ALREADY_DONE"
        # PENDING (or a legacy/unknown status) — treat as in-flight/for-
        # reconcile rather than assuming DONE, per design B.1.
        return "ALREADY_PENDING"


def _complete_message_id(message_id: str) -> None:
    """Promote a claimed message id to DONE after successful fabrication."""
    _idempotency_table().update_item(
        Key={"eventId": message_id},
        UpdateExpression="SET #status = :done",
        ExpressionAttributeNames={"#status": "status"},
        ExpressionAttributeValues={":done": "DONE"},
    )


# Board 2b52a985 (slice-B checker advisory): metric namespace/name/dimension
# for the ALREADY_PENDING poison-ack, pinned here as constants so the
# CloudWatch alarm math in backend/lib/arbiter-stack.ts is oracle-validatable
# against the exact literal values this module emits — no hand-retyping the
# strings at the alarm call site.
STALE_PENDING_METRIC_NAMESPACE = "CitadelArbiter"
STALE_PENDING_METRIC_NAME = "FabricatorStalePendingClaim"

_cw_client = None


def _cloudwatch():
    """Lazy boto3 CloudWatch client (module-level cache, first-call
    construction) — same convention as ``_get_registry_client`` above and
    ``arbiter/workerWrapper/tools/escalate.py``'s ``_cloudwatch()``.
    """
    global _cw_client
    if _cw_client is None:
        _cw_client = boto3.client("cloudwatch")
    return _cw_client


def _reset_cloudwatch_client_for_test() -> None:
    """Test-only hook — forces the next call to rebuild the cached client."""
    global _cw_client
    _cw_client = None


def _emit_tool_registration_denied_metric(tool_id: str) -> None:
    """Emit ``Citadel/Fabricator ToolRegistrationDenied`` (CIT-256 H2).

    Best-effort — a CloudWatch outage must never change the gate's
    fail-closed behavior.  The ``ToolId`` dimension is the registry record
    name (non-sensitive, bounded cardinality per org).
    """
    try:
        _cloudwatch().put_metric_data(
            Namespace="Citadel/Fabricator",
            MetricData=[
                {
                    "MetricName": "ToolRegistrationDenied",
                    "Value": 1,
                    "Unit": "Count",
                    "Dimensions": [
                        {"Name": "ToolId", "Value": tool_id},
                    ],
                }
            ],
        )
    except Exception as e:  # noqa: BLE001 — best-effort metric
        logger.warning(
            "Failed to emit ToolRegistrationDenied metric for tool_id=%s "
            "(non-fatal): %s",
            tool_id, type(e).__name__,
        )


def _emit_org_missing_metric(site: str, record_id: str) -> None:
    """Emit ``Citadel/Fabricator OrgMissing`` when a registration is refused
    because ``org_id`` is empty (CIT-302 fail-closed guard).

    Best-effort — a CloudWatch outage must never change the guard's
    fail-closed behavior.
    """
    try:
        _cloudwatch().put_metric_data(
            Namespace="Citadel/Fabricator",
            MetricData=[
                {
                    "MetricName": "OrgMissing",
                    "Value": 1,
                    "Unit": "Count",
                    "Dimensions": [
                        {"Name": "Site", "Value": site},
                    ],
                }
            ],
        )
    except Exception as e:  # noqa: BLE001 — best-effort metric
        logger.warning(
            "Failed to emit OrgMissing metric for %s/%s (non-fatal): %s",
            site, record_id, type(e).__name__,
        )


def _route_to_reconcile(message_id: str) -> None:
    """Log-and-route hook for a redelivery seen while PENDING (design B.1 /
    docs/runbooks/DLQ_REDRIVE.md slice C): the runbook, not this handler,
    owns the manual reconcile procedure. This is deliberately a no-op
    beyond logging and metric emission — it exists as a named seam so a
    future automated reconcile step has a single call site to extend, and
    so tests can assert the routing decision independently of that future
    behavior.

    Board 2b52a985: this is the ONLY place a poison/wedged fabrication is
    currently observable — `lambda_handler` acks the SQS message on every
    ALREADY_PENDING receipt (see its docstring), so the message never
    accrues the redrive policy's maxReceiveCount and never reaches
    `citadel-fabricator-dlq-${ENV}`. Emitting a CloudWatch metric here,
    at the exact moment of poison-consumption, is the cheapest available
    signal — no new Lambda, no new polling, no new IAM beyond
    `cloudwatch:PutMetricData` (already used by the worker's `escalate`
    tool; see that module for the identical put_metric_data shape this
    mirrors). A stale-PENDING age-scan alarm was the other option
    considered (a) doesn't require a redelivery to ever occur, so it also
    catches a crashed fabrication with NO further redelivery — a gap this
    emit-on-ack metric cannot cover. That is deliberately left to the
    runbook's existing manual scan for this change: it would need a new
    scheduled Lambda (extra cost/IAM surface) and is not required to close
    the specific "poison acks silently" gap this task targets. Additive
    only — this does not change the ack/no-raise behavior above; a
    CloudWatch outage must not turn this fail-open path into a failure.
    """
    logger.warning(
        "Fabricator message id=%s redelivered while a prior attempt is "
        "still PENDING; skipping re-fabrication and routing to manual "
        "reconcile (see docs/runbooks/DLQ_REDRIVE.md)",
        message_id,
    )
    try:
        _cloudwatch().put_metric_data(
            Namespace=STALE_PENDING_METRIC_NAMESPACE,
            MetricData=[
                {
                    "MetricName": STALE_PENDING_METRIC_NAME,
                    "Value": 1,
                    "Unit": "Count",
                    # No per-messageId dimension — unbounded cardinality;
                    # mirrors the low-cardinality-dimension rule in
                    # arbiter/common/metrics_constants.py.
                    "Dimensions": [{"Name": "Consumer", "Value": "fabricator"}],
                }
            ],
        )
    except Exception as e:  # noqa: BLE001 — best-effort: never change ack behavior
        logger.warning(
            "Failed to emit %s metric for message id=%s (non-fatal): %s",
            STALE_PENDING_METRIC_NAME, message_id, type(e).__name__,
        )


def lambda_handler(event, context):
    print(f"processing event {event}")
    for record in event['Records']:
        message_id = record.get('messageId')
        message_body = json.loads(record['body'])
        # print(f"Parsed message body: {json.dumps(message_body, indent=2)}")
        
        # Extract request type from SQS messageAttributes
        request_type = None
        if 'messageAttributes' in record and 'requestType' in record['messageAttributes']:
            request_type = record['messageAttributes']['requestType'].get('stringValue')
            print(f"Request type from messageAttributes: {request_type}")

        # CIT-125 slice B: two-phase dedupe on the SQS messageId (see
        # IDEMPOTENCY_TABLE comment above for why messageId, not event.id).
        # Records without a messageId (defensive: should not occur on the
        # real SQS path) are NOT deduped — fail open rather than silently
        # dropping work.
        if message_id:
            claim = _claim_message_id(message_id)
            if claim == "ALREADY_PENDING":
                _route_to_reconcile(message_id)
                continue
            if claim == "ALREADY_DONE":
                print(f"Message id={message_id} already fabricated (DONE); skipping")
                continue

        process_event(message_body, context, request_type=request_type)

        if message_id:
            _complete_message_id(message_id)

if __name__ == "__main__":
    # Grab a record from your lambda and invoke, configuration will vary drastically
    process_event(
        {'agent_input': {'taskDetails': 'Create a capability to prepare and serve cheesecake dessert items'}, 'orchestration_id': 'ed3b70b6-37c6-47fa-8f50-4eac0908345e',
            'agent_use_id': 'tooluse_L9uWo8_KR4mT70-876lzSA', 'node': 'fabricator'}, {}
    )