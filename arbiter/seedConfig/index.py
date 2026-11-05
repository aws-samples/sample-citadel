import json
import logging
import os
import time
import boto3
import cfnresponse
from botocore.exceptions import ClientError

logger = logging.getLogger(__name__)

# US-ARB-011: governance table env vars. Read at module scope so the
# handler stays a pure dispatch on event['RequestType']. Both are optional
# — if unset (e.g. a partial stack deploy where the governance tables
# haven't landed yet), the seed logs a warning and skips that section
# rather than failing the whole custom resource and rolling back the stack.
AUTHORITY_UNITS_TABLE = os.environ.get('AUTHORITY_UNITS_TABLE')
CONSTITUTIONAL_LAYERS_TABLE = os.environ.get('CONSTITUTIONAL_LAYERS_TABLE')

# Deterministic identity for the runnable demo agent. The config's ``filename``
# is the key the worker resolves the module from (it downloads
# ``agents/<filename>`` from the agent code bucket into /tmp). The module of the
# same basename is bundled alongside this handler and uploaded at seed time.
DEMO_ECHO_AGENT_ID = 'demo-echo-agent'
DEMO_ECHO_MODULE_FILENAME = 'demo_echo_agent.py'
DEMO_ECHO_DESCRIPTION = 'Demo agent that echoes its input back as output.'

# Routing demo agent — returns {"route": "<branch>"} for the Conditional
# Router blueprint's conditional edges. Defaults to "branch-a".
DEMO_ROUTER_AGENT_ID = 'demo-router-agent'
DEMO_ROUTER_MODULE_FILENAME = 'demo_router_agent.py'
DEMO_ROUTER_DESCRIPTION = (
    'Demo agent that returns a routing decision. '
    'Input {"route": "branch-b"} selects branch-b; default is branch-a.'
)

# Fabricator agent — creates capabilities that may be missing.
FABRICATOR_AGENT_ID = 'fabricator'
FABRICATOR_DESCRIPTION = (
    'Creates a capability that may be missing from the set of available tools.'
)

# ---------------------------------------------------------------------------
# Idempotency-seam smoke agent — DIAGNOSTIC FIXTURE, never a product agent.
#
# Seeded ONLY when SMOKE_FIXTURES_ENABLED is set (CDK sets this exclusively
# in non-production environments — see backend/lib/arbiter-stack.ts). A
# production deploy leaves this env var unset, so this whole block is a
# no-op there: no agent config row, no registry record, no module upload.
# See _seed_smoke_idempotency_agent below.
# ---------------------------------------------------------------------------
SMOKE_IDEMPOTENCY_AGENT_ID = 'smoke-idempotency-agent'
SMOKE_IDEMPOTENCY_MODULE_FILENAME = 'smoke_idempotency_agent.py'
SMOKE_IDEMPOTENCY_DESCRIPTION = (
    'DIAGNOSTIC FIXTURE — exercises the tool-call idempotency seam via one '
    'harmless side-effecting tool call. Non-prod only. Not a product agent.'
)
SMOKE_FIXTURES_ENABLED = bool(os.environ.get('SMOKE_FIXTURES_ENABLED'))


# ---------------------------------------------------------------------------
# Org sentinel and projection-version constants
# ---------------------------------------------------------------------------
# The org sentinel for system/platform-shared agents (TENANCY.md §"All
# Organizations"). Replaces the legacy empty-string convention, which
# tenant_guard still accepts for backward compat but should no longer be
# written by new code paths.
ALL_ORGS = 'All Organizations'

# Must match the PROJECTION_VERSION constant in
# backend/src/lambda/registry-sync.ts so canonical rows are
# indistinguishable from projection rows on the read path.
SEEDER_PROJECTION_VERSION = 1


# ---------------------------------------------------------------------------
# Registry settle + approve constants
# ---------------------------------------------------------------------------
# System agents that must be dispatchable (approval-gate readiness) are
# auto-submitted for approval after create. The smoke fixture is
# intentionally excluded — it stays DRAFT.
SYSTEM_AGENTS = frozenset({FABRICATOR_AGENT_ID, DEMO_ECHO_AGENT_ID, DEMO_ROUTER_AGENT_ID})

# Settle poll: wait for create_registry_record's async transition out of
# CREATING/UPDATING.  Patchable in tests via ``index._SETTLE_SLEEP``.
_SETTLE_MAX_ATTEMPTS = 10
_SETTLE_SLEEP = 1  # seconds between polls
_UNSETTLED_STATUSES = frozenset({'CREATING', 'UPDATING'})


def _resolve_settled_record(registry_id, agent_id, list_agent_records):
    """Poll ``list_agent_records`` until the record for *agent_id* has left
    the CREATING/UPDATING transient states **and** carries a ``recordId``.

    Returns the settled record dict, or ``None`` if the record did not
    settle within ``_SETTLE_MAX_ATTEMPTS`` polls.
    """
    for attempt in range(1, _SETTLE_MAX_ATTEMPTS + 1):
        for rec in list_agent_records(registry_id):
            if isinstance(rec, dict) and rec.get('name') == agent_id:
                status = rec.get('status')
                record_id = rec.get('recordId')
                if status not in _UNSETTLED_STATUSES and record_id:
                    return rec
        if attempt < _SETTLE_MAX_ATTEMPTS:
            time.sleep(_SETTLE_SLEEP)
    return None


def _write_canonical_and_pointer(
    table,
    agent_id: str,
    record_info: dict | None,
    config: dict,
    *,
    description: str,
    categories: list,
    state: str = 'active',
):
    """Write a canonical recordId-keyed row + thin name-keyed pointer.

    The canonical row carries the FULL config (filename, schema, action) plus
    projection fields (citadelKind, projectionVersion) so both the worker
    dispatch and the frontend projection scan find a complete row.

    The thin pointer (agentId = friendly name) carries only linkage +
    state — no config. The worker resolves through it via
    ``_canonicalRecordId``.

    Idempotent: plain ``put_item`` overwrites with identical data on re-run.
    When *record_info* is None (registry unavailable), falls back to the
    legacy name-keyed full-config row (the pre-canonical-row path).
    """
    from datetime import datetime, timezone

    if record_info is None or record_info.get('recordId') is None:
        # Registry unavailable — fall back to legacy name-keyed row with
        # full config (same shape as before this change). No canonical row.
        legacy_item = {
            'agentId': agent_id,
            'config': config,
            'state': state,
            'categories': categories,
            'orgId': ALL_ORGS,
        }
        table.put_item(Item=legacy_item)
        return

    record_id = record_info['recordId']
    status = record_info.get('status')
    created_at = record_info.get('createdAt')
    now = datetime.now(timezone.utc).isoformat()

    manifest = {
        'name': agent_id,
        'description': description,
        'version': 1,
        'tools': [],
    }

    # --- Canonical row (agentId = recordId) ---
    canonical = {
        'agentId': record_id,
        'name': agent_id,
        'config': config,
        'state': state,
        'categories': categories,
        'citadelKind': 'agent',
        'projectionVersion': SEEDER_PROJECTION_VERSION,
        'projectedAt': now,
        'orgId': ALL_ORGS,
        'manifest': manifest,
        'createdBy': 'seedConfig',
        'icon': '',
        'description': description,
    }
    if status is not None:
        canonical['registryStatus'] = status
    canonical['registryRecordId'] = record_id
    if created_at is not None:
        canonical['createdAt'] = created_at

    table.put_item(Item=canonical)
    print(
        f"Wrote canonical row agentId={record_id} for {agent_id} "
        f"(orgId={ALL_ORGS}, projVer={SEEDER_PROJECTION_VERSION})"
    )

    # --- Thin pointer (agentId = friendly name) ---
    pointer = {
        'agentId': agent_id,
        '_canonicalRecordId': record_id,
        'state': state,
        'orgId': ALL_ORGS,
    }
    if status is not None:
        pointer['registryStatus'] = status
    pointer['registryRecordId'] = record_id

    table.put_item(Item=pointer)
    print(f"Wrote thin pointer agentId={agent_id} → {record_id}")


def _copy_s3_to_scoped_key(s3_client, bucket, module_filename, record_id):
    """Ensure agents/{recordId}/{basename} exists in S3.

    Copies from the legacy flat key ``agents/{basename}`` if the scoped
    key does not exist yet (CopyObject from same bucket). Idempotent:
    put_object with the same body is a no-op in effect.
    """
    basename = os.path.basename(module_filename)
    scoped_key = f'agents/{record_id}/{basename}'
    legacy_key = f'agents/{basename}'
    try:
        s3_client.head_object(Bucket=bucket, Key=scoped_key)
        print(f"Scoped key {scoped_key} already exists — skipping copy")
    except ClientError as exc:
        error_code = exc.response.get('Error', {}).get('Code', '')
        if error_code in ('404', 'NoSuchKey'):
            try:
                s3_client.copy_object(
                    Bucket=bucket,
                    CopySource={'Bucket': bucket, 'Key': legacy_key},
                    Key=scoped_key,
                )
                print(f"Copied {legacy_key} → {scoped_key}")
            except ClientError as copy_exc:
                print(
                    f"WARNING: copy_object {legacy_key} → {scoped_key} "
                    f"failed: {copy_exc} — scoped key not available"
                )
        else:
            print(
                f"WARNING: head_object {scoped_key} failed with "
                f"{error_code} — skipping scoped-key check"
            )


def _seed_agent_registry_record(agent_id, description, module_filename, worker_queue_url):
    """Create an agent's AgentCore Registry record (dual-store seam).

    Generalized from the original demo-echo-only helper so the same
    dual-store contract (DDB row for worker dispatch + AgentCore Registry
    record for the app-publish readiness gate) can be reused for any
    seeded worker agent — currently ``demo-echo-agent``, ``fabricator``,
    and the diagnostic ``smoke-idempotency-agent`` fixture.

    The DDB AGENT_CONFIG_TABLE row alone is not enough for the dispatch
    approval gate: the gate evaluates ``registryStatus``,
    ``registryRecordId``, and ``createdAt`` fields on the agent item.
    This helper resolves (lookup-by-name or create) the registry record
    and returns enough info for the caller to stamp those linkage fields
    on the DDB item.

    Guards:
      - No-op (with a log) when REGISTRY_ID/REGISTRY_ENABLED are unset —
        registry-less environments still seed DDB only.
      - No-op (with a log) when ``catalog.registry_client`` is not
        importable — the shared catalog Lambda layer is required for the
        idempotency lookup; DDB-only envs must keep seeding.
      - IDEMPOTENT: mirrors the fabricator's lookup-first behavior — when a
        record with this name already exists, CreateRegistryRecord is
        skipped so CFN re-runs never create duplicates.
      - NON-FATAL: any botocore ClientError raised by CreateRegistryRecord
        (e.g. AccessDeniedException, ResourceNotFoundException) is caught,
        logged as a WARNING with the operation and error code, and treated
        as "not seeded" rather than propagating. The DynamoDB/S3 seeding
        this handler performs elsewhere stays authoritative and unaffected.

    Returns:
        A dict ``{'recordId': str, 'status': str, 'createdAt': str|None}``
        when a record was created or already existed, or ``None`` if the
        seed was skipped or denied for any reason.
    """
    registry_id = os.environ.get('REGISTRY_ID')
    registry_enabled = os.environ.get('REGISTRY_ENABLED')
    if not registry_id or not registry_enabled:
        print(
            'Registry not configured (REGISTRY_ID/REGISTRY_ENABLED unset) — '
            f'skipping {agent_id} registry record seed'
        )
        return None

    try:
        # Shared client from the arbiter catalog layer (same import pattern
        # as the fabricator's catalog bridge). Defensive: environments where
        # the layer is not attached must still seed the DDB rows.
        from catalog.registry_client import list_agent_records
    except ImportError:
        print(
            'WARNING: catalog.registry_client unavailable (catalog layer '
            f'not attached?) — skipping {agent_id} registry record seed'
        )
        return None

    # Idempotency lookup first (mirrors the fabricator's
    # _find_existing_record_id): exact name match on the record name.
    # list_agent_records already swallows ClientError internally and
    # returns [] on failure, so a denied/unavailable list is treated the
    # same as "no existing record" and falls through to attempt create.
    for record in list_agent_records(registry_id):
        if isinstance(record, dict) and record.get('name') == agent_id:
            print(
                f"Registry record '{agent_id}' already exists "
                f"(recordId={record.get('recordId')}); skipping create"
            )
            existing = {
                'recordId': record.get('recordId'),
                'status': record.get('status'),
                'createdAt': record.get('createdAt'),
            }
            # Pre-existing DRAFT system agents still need approval
            if agent_id in SYSTEM_AGENTS and existing.get('status') == 'DRAFT':
                client = boto3.client('agent-registry-control')
                try:
                    approve_resp = client.submit_registry_record_for_approval(
                        registryId=registry_id,
                        recordId=existing['recordId'],
                    )
                    print(
                        f"Submitted pre-existing {agent_id} for approval "
                        f"(status={approve_resp.get('status')})"
                    )
                    refreshed = _resolve_settled_record(
                        registry_id, agent_id, list_agent_records,
                    )
                    if refreshed is not None:
                        existing = {
                            'recordId': refreshed.get('recordId'),
                            'status': refreshed.get('status'),
                            'createdAt': refreshed.get('createdAt'),
                        }
                except ClientError as exc:
                    error_code = exc.response.get('Error', {}).get('Code', 'Unknown')
                    print(
                        f"WARNING: submit_registry_record_for_approval failed "
                        f"for pre-existing {agent_id} (errorCode={error_code}) "
                        "— stamping from pre-approval state"
                    )
            return existing

    # Fabricator-shaped executable config + manifest + custom metadata
    # (see store_agent_config_registry in arbiter/fabricator/index.py).
    config = {
        'name': agent_id,
        'filename': module_filename,
        'schema': {
            'type': 'object',
            'properties': {
                'message': {
                    'type': 'string',
                    'description': 'Arbitrary payload returned unchanged.'
                }
            },
            'required': []
        },
        'version': 1,
        'description': description,
        'action': {
            'type': 'sqs',
            'target': worker_queue_url,
        },
    }
    manifest = {
        'name': agent_id,
        'description': description,
        'version': 1,
        'tools': [],
    }
    custom_metadata = {
        'categories': ['built-in', 'worker', 'demo'],
        'icon': '',
        'state': 'active',
        'manifest': manifest,
        'config': config,
        'createdBy': 'seedConfig',
        'orgId': 'All Organizations',
    }

    client = boto3.client('agent-registry-control')
    try:
        response = client.create_registry_record(
            registryId=registry_id,
            name=agent_id,
            displayName=agent_id,
            description=description,
            recordType='CUSTOM',
            descriptors={
                'custom': {
                    'data': json.dumps(custom_metadata, default=str),
                },
            },
        )
    except ClientError as exc:
        error_code = exc.response.get('Error', {}).get('Code', 'Unknown')
        logger.warning(
            "Registry create_registry_record failed for %s "
            "(errorCode=%s): %s", agent_id, error_code, exc,
        )
        print(
            f"WARNING: create_registry_record denied/unavailable for "
            f"{agent_id} (errorCode={error_code}) — continuing without a "
            "registry record; DynamoDB/S3 seeding is unaffected"
        )
        return None
    print(
        f"Created registry record for {agent_id} "
        f"(status={response.get('status')})"
    )

    # ---- Settle: wait for the record to leave CREATING/UPDATING ----
    raw_status = response.get('status')
    raw_record_id = response.get('recordId')
    if raw_status in _UNSETTLED_STATUSES or not raw_record_id:
        print(
            f"Registry record for {agent_id} returned transient "
            f"status={raw_status} — polling until settled"
        )
        settled = _resolve_settled_record(
            registry_id, agent_id, list_agent_records,
        )
        if settled is None:
            print(
                f"WARNING: registry record for {agent_id} did not settle "
                f"after {_SETTLE_MAX_ATTEMPTS} attempts — linkage fields "
                "will be absent"
            )
            return None
    else:
        settled = {
            'recordId': raw_record_id,
            'status': raw_status,
            'createdAt': response.get('createdAt'),
        }

    # ---- Auto-approve system agents that must be dispatchable ----
    if agent_id in SYSTEM_AGENTS and settled.get('status') == 'DRAFT':
        try:
            approve_resp = client.submit_registry_record_for_approval(
                registryId=registry_id,
                recordId=settled['recordId'],
            )
            print(
                f"Submitted {agent_id} for approval "
                f"(status={approve_resp.get('status')})"
            )
            # Re-fetch to get the canonical post-approval state
            refreshed = _resolve_settled_record(
                registry_id, agent_id, list_agent_records,
            )
            if refreshed is not None:
                settled = refreshed
        except ClientError as exc:
            error_code = exc.response.get('Error', {}).get('Code', 'Unknown')
            print(
                f"WARNING: submit_registry_record_for_approval failed for "
                f"{agent_id} (errorCode={error_code}) — stamping from "
                "pre-approval state"
            )

    return {
        'recordId': settled.get('recordId'),
        'status': settled.get('status'),
        'createdAt': settled.get('createdAt'),
    }


def _seed_demo_agent_registry_record(worker_queue_url):
    """Backward-compatible wrapper around the generalized registry seeder,
    kept so the demo-echo-agent call site (and its existing tests) do not
    need to change shape.

    Returns the underlying seeder's record-info dict (or None)."""
    return _seed_agent_registry_record(
        DEMO_ECHO_AGENT_ID, DEMO_ECHO_DESCRIPTION, DEMO_ECHO_MODULE_FILENAME,
        worker_queue_url,
    )


def _stamp_registry_linkage(item, record_info):
    """Stamp registry linkage fields on a DynamoDB agent item dict.

    When *record_info* is a dict (registry resolved successfully), adds:
      - ``registryStatus``   — the raw record status (e.g. 'DRAFT', 'APPROVED')
      - ``registryRecordId`` — the record id
      - ``createdAt``        — the record's createdAt ISO timestamp, but ONLY
        when the item does not already carry a ``createdAt`` value

    When *record_info* is None (registry unavailable/denied), OR when the
    record's status is transient (CREATING/UPDATING), the three fields are
    left **absent** — never stamp an unsettled status.

    Mutates *item* in place and returns it for convenience.
    """
    if record_info is None:
        return item
    status = record_info.get('status')
    if status in _UNSETTLED_STATUSES:
        print(
            f"WARNING: not stamping linkage for {item.get('agentId', '?')} "
            f"— record status is transient ({status})"
        )
        return item
    if status is not None:
        item['registryStatus'] = status
    if record_info.get('recordId') is not None:
        item['registryRecordId'] = record_info['recordId']
    if 'createdAt' not in item and record_info.get('createdAt') is not None:
        item['createdAt'] = record_info['createdAt']
    return item


def _seed_smoke_idempotency_agent(table, worker_queue_url, agent_bucket):
    """Seed the diagnostic smoke-idempotency agent (DDB row + module upload
    + registry record) — a NON-PROD-ONLY fixture, gated on
    ``SMOKE_FIXTURES_ENABLED``.

    Mirrors the demo-echo-agent seeding block exactly (same dual-store
    contract, same idempotent plain-``put_item``/``put_object`` semantics),
    parameterized so it can be called only when smoke fixtures are enabled.
    Never called at all in a production deploy — see ``SMOKE_FIXTURES_ENABLED``
    and ``backend/lib/arbiter-stack.ts`` for how CDK withholds the env var
    (and therefore the table/grant this agent's tool needs) in prod.

    Returns the registry seed's success flag (see
    ``_seed_agent_registry_record``); the DDB row and module upload are
    unaffected by registry outcomes and always attempted.
    """
    smoke_agent = {
        'agentId': SMOKE_IDEMPOTENCY_AGENT_ID,
        'config': {
            'name': SMOKE_IDEMPOTENCY_AGENT_ID,
            'filename': SMOKE_IDEMPOTENCY_MODULE_FILENAME,
            'description': SMOKE_IDEMPOTENCY_DESCRIPTION,
            'schema': {
                'type': 'object',
                'properties': {
                    'note': {
                        'type': 'string',
                        'description': (
                            'Optional free-text note echoed into the '
                            'written smoke row.'
                        ),
                    }
                },
                'required': []
            },
            'version': '1',
            'action': {
                'type': 'sqs',
                'target': worker_queue_url,
            },
        },
        'state': 'active',
        'categories': ['built-in', 'worker', 'smoke', 'diagnostic'],
    }

    # Registry record first (same dual-store contract as echo/fabricator),
    # then stamp linkage, then write the DDB row with linkage included.
    smoke_record = _seed_agent_registry_record(
        SMOKE_IDEMPOTENCY_AGENT_ID, SMOKE_IDEMPOTENCY_DESCRIPTION,
        SMOKE_IDEMPOTENCY_MODULE_FILENAME, worker_queue_url,
    )

    # Canonical recordId-keyed row + thin name-keyed pointer.
    _write_canonical_and_pointer(
        table, SMOKE_IDEMPOTENCY_AGENT_ID, smoke_record,
        smoke_agent['config'],
        description=SMOKE_IDEMPOTENCY_DESCRIPTION,
        categories=smoke_agent['categories'],
    )
    print(
        f"Seeded agent: {SMOKE_IDEMPOTENCY_AGENT_ID} (smoke fixture) with "
        f"queue: {worker_queue_url}"
    )

    if agent_bucket:
        module_path = os.path.join(
            os.path.dirname(__file__), SMOKE_IDEMPOTENCY_MODULE_FILENAME
        )
        with open(module_path, 'rb') as module_file:
            module_body = module_file.read()
        s3 = boto3.client('s3')
        s3.put_object(
            Bucket=agent_bucket,
            Key=f'agents/{SMOKE_IDEMPOTENCY_MODULE_FILENAME}',
            Body=module_body,
        )
        print(
            f"Uploaded smoke-idempotency module to "
            f"s3://{agent_bucket}/agents/{SMOKE_IDEMPOTENCY_MODULE_FILENAME}"
        )
        # Copy to scoped key agents/{recordId}/{basename} for canonical dispatch.
        if smoke_record and smoke_record.get('recordId'):
            _copy_s3_to_scoped_key(
                s3, agent_bucket, SMOKE_IDEMPOTENCY_MODULE_FILENAME,
                smoke_record['recordId'],
            )
    else:
        print(
            "WARNING: AGENT_BUCKET_NAME not set — skipping smoke-idempotency "
            "module upload (partial deploy?). Agent config still seeded."
        )

    return smoke_record


def _registry_seeded(record_info):
    """Return True if *record_info* represents a resolved registry record."""
    return record_info is not None


def handler(event, context):
    print('Event:', json.dumps(event))
    
    if event['RequestType'] == 'Delete':
        cfnresponse.send(event, context, cfnresponse.SUCCESS, {})
        return
    
    try:
        dynamodb = boto3.resource('dynamodb')
        table_name = os.environ['AGENT_CONFIG_TABLE']
        worker_queue_url = os.environ['WORKER_QUEUE_URL']
        fabricator_queue_url = os.environ['FABRICATOR_QUEUE_URL']
        
        table = dynamodb.Table(table_name)
        
        # Seed fabricator agent
        fabricator_agent = {
            'agentId': 'fabricator',
            'config': {
                'name': 'fabricator',
                'description': 'Creates a capability that may be missing from the set of available tools.',
                'schema': {
                    'type': 'object',
                    'properties': {
                        'taskDetails': {
                            'type': 'string',
                            'description': 'A detailed task description for what the task should entail'
                        }
                    },
                    'required': ['taskDetails']
                },
                'version': '1',
                'action': {
                    'type': 'sqs',
                    'target': fabricator_queue_url
                }
            },
            'state': 'active',
            'categories': ['built-in', 'developer']
        }

        # Registry record for fabricator (same create-if-missing + submit
        # treatment as demo-echo-agent). Uses fabricator_queue_url as the
        # action target; module_filename is empty — fabricator is not a
        # file-backed worker module.
        fabricator_record = _seed_agent_registry_record(
            FABRICATOR_AGENT_ID, FABRICATOR_DESCRIPTION, '',
            fabricator_queue_url,
        )

        # Canonical recordId-keyed row + thin name-keyed pointer.
        _write_canonical_and_pointer(
            table, FABRICATOR_AGENT_ID, fabricator_record,
            fabricator_agent['config'],
            description=FABRICATOR_DESCRIPTION,
            categories=fabricator_agent['categories'],
        )
        print(f"Seeded agent: fabricator with queue: {fabricator_queue_url}")

        # ------------------------------------------------------------------
        # Runnable demo echo agent
        # ------------------------------------------------------------------
        # A minimal, active worker agent that returns its input as output. It
        # carries every field the worker reads at dispatch — most importantly
        # ``config.filename``, the S3 module key — and is seeded 'active' so it
        # is immediately runnable (unlike fabricator-created agents, which land
        # DRAFT/inactive and require activation). Plain put_item keeps re-runs
        # idempotent: overwriting with the same payload is a no-op in effect.
        echo_agent = {
            'agentId': DEMO_ECHO_AGENT_ID,
            'config': {
                'name': DEMO_ECHO_AGENT_ID,
                'filename': DEMO_ECHO_MODULE_FILENAME,
                'description': DEMO_ECHO_DESCRIPTION,
                'schema': {
                    'type': 'object',
                    'properties': {
                        'message': {
                            'type': 'string',
                            'description': 'Arbitrary payload returned unchanged.'
                        }
                    },
                    'required': []
                },
                'version': '1',
                'action': {
                    'type': 'sqs',
                    'target': worker_queue_url
                }
            },
            'state': 'active',
            'categories': ['built-in', 'worker', 'demo'],
        }

        # Dual-store seam: resolve the AgentCore Registry record (lookup or
        # create) BEFORE writing the DDB row so the linkage fields land in a
        # single put_item. Non-fatal: any denial or unavailability is caught
        # inside the helper and only lowers registry_seeded.
        echo_record = _seed_demo_agent_registry_record(worker_queue_url)

        # Canonical recordId-keyed row + thin name-keyed pointer.
        _write_canonical_and_pointer(
            table, DEMO_ECHO_AGENT_ID, echo_record,
            echo_agent['config'],
            description=DEMO_ECHO_DESCRIPTION,
            categories=echo_agent['categories'],
        )
        print(f"Seeded agent: {DEMO_ECHO_AGENT_ID} with queue: {worker_queue_url}")

        registry_seeded = _registry_seeded(echo_record)

        # Upload the echo module so the config's ``filename`` is genuinely
        # reachable. The module is bundled next to this handler in the Lambda
        # asset. Guarded on AGENT_BUCKET_NAME: an unset bucket (e.g. a partial
        # deploy where the code bucket grant/env hasn't landed) logs a warning
        # and skips the upload rather than failing the whole custom resource —
        # the agent record is still seeded. put_object is idempotent: the same
        # key + body simply overwrites.
        agent_bucket = os.environ.get('AGENT_BUCKET_NAME')
        if agent_bucket:
            module_path = os.path.join(
                os.path.dirname(__file__), DEMO_ECHO_MODULE_FILENAME
            )
            with open(module_path, 'rb') as module_file:
                module_body = module_file.read()
            s3 = boto3.client('s3')
            s3.put_object(
                Bucket=agent_bucket,
                Key=f'agents/{DEMO_ECHO_MODULE_FILENAME}',
                Body=module_body,
            )
            print(
                f"Uploaded echo module to "
                f"s3://{agent_bucket}/agents/{DEMO_ECHO_MODULE_FILENAME}"
            )
            # Copy to scoped key agents/{recordId}/{basename} for the
            # canonical-row dispatch path.
            if echo_record and echo_record.get('recordId'):
                _copy_s3_to_scoped_key(
                    s3, agent_bucket, DEMO_ECHO_MODULE_FILENAME,
                    echo_record['recordId'],
                )
        else:
            print(
                "WARNING: AGENT_BUCKET_NAME not set — skipping echo module "
                "upload (partial deploy?). Agent config still seeded."
            )

        # ------------------------------------------------------------------
        # Routing demo agent — drives the Conditional Router blueprint
        # ------------------------------------------------------------------
        # Returns {"route": "<branch>"} so the conditional edges fire.
        # Same dual-store + S3 upload pattern as the echo agent above.
        router_agent = {
            'agentId': DEMO_ROUTER_AGENT_ID,
            'config': {
                'name': DEMO_ROUTER_AGENT_ID,
                'filename': DEMO_ROUTER_MODULE_FILENAME,
                'description': DEMO_ROUTER_DESCRIPTION,
                'schema': {
                    'type': 'object',
                    'properties': {
                        'route': {
                            'type': 'string',
                            'description': (
                                'Target branch: "branch-a" or "branch-b". '
                                'Defaults to "branch-a" when omitted.'
                            ),
                        }
                    },
                    'required': []
                },
                'version': '1',
                'action': {
                    'type': 'sqs',
                    'target': worker_queue_url
                }
            },
            'state': 'active',
            'categories': ['built-in', 'worker', 'demo'],
        }

        router_record = _seed_agent_registry_record(
            DEMO_ROUTER_AGENT_ID, DEMO_ROUTER_DESCRIPTION,
            DEMO_ROUTER_MODULE_FILENAME, worker_queue_url,
        )

        _write_canonical_and_pointer(
            table, DEMO_ROUTER_AGENT_ID, router_record,
            router_agent['config'],
            description=DEMO_ROUTER_DESCRIPTION,
            categories=router_agent['categories'],
        )
        print(f"Seeded agent: {DEMO_ROUTER_AGENT_ID} with queue: {worker_queue_url}")

        if agent_bucket:
            router_module_path = os.path.join(
                os.path.dirname(__file__), DEMO_ROUTER_MODULE_FILENAME
            )
            with open(router_module_path, 'rb') as module_file:
                router_module_body = module_file.read()
            s3.put_object(
                Bucket=agent_bucket,
                Key=f'agents/{DEMO_ROUTER_MODULE_FILENAME}',
                Body=router_module_body,
            )
            print(
                f"Uploaded router module to "
                f"s3://{agent_bucket}/agents/{DEMO_ROUTER_MODULE_FILENAME}"
            )
            if router_record and router_record.get('recordId'):
                _copy_s3_to_scoped_key(
                    s3, agent_bucket, DEMO_ROUTER_MODULE_FILENAME,
                    router_record['recordId'],
                )
        else:
            print(
                "WARNING: AGENT_BUCKET_NAME not set — skipping router module "
                "upload (partial deploy?). Agent config still seeded."
            )

        # ------------------------------------------------------------------
        # Idempotency-seam smoke agent — DIAGNOSTIC FIXTURE, non-prod only.
        # ------------------------------------------------------------------
        # Gated on SMOKE_FIXTURES_ENABLED, which CDK sets exclusively for
        # non-production stacks (backend/lib/arbiter-stack.ts). A production
        # deploy never sets this var, so this whole block — and the smoke
        # table/grant it depends on — simply do not exist there. Idempotent
        # by the same plain-put_item/put_object semantics as the echo agent.
        if SMOKE_FIXTURES_ENABLED:
            smoke_registry_seeded = _seed_smoke_idempotency_agent(
                table, worker_queue_url, agent_bucket
            )
            registry_seeded = registry_seeded and _registry_seeded(smoke_registry_seeded)
        else:
            print(
                "SMOKE_FIXTURES_ENABLED unset — skipping smoke-idempotency "
                "agent seed (expected in production)"
            )

        # ------------------------------------------------------------------
        # US-ARB-011: seed governance corpus
        # ------------------------------------------------------------------
        # Authority units — 3 global rows (per D2/D3). The fabricator
        # authority unit is deliberately omitted from the global seed;
        # per-app fabricator units are seeded by US-ARB-014.
        #
        # Plain put_item (no ConditionExpression) so every CFN Update is
        # idempotent — overwriting with the same payload is a no-op in
        # effect, and lets us evolve the seed without an out-of-band
        # cleanup step.
        if AUTHORITY_UNITS_TABLE:
            authority_units_table = dynamodb.Table(AUTHORITY_UNITS_TABLE)
            authority_units = [
                {
                    'unitId': 'arbiter-invoke-all',
                    'agentId': 'arbiter',
                    'registryId': '*GLOBAL*',
                    'scope': {
                        'decision_type': 'invoke_agent',
                        'domain': '*',
                        'conditions': {},
                        'limits': {},
                    },
                    'riskRating': 'low',
                    'revoked': False,
                },
                {
                    'unitId': 'escalate-invoke-all',
                    'agentId': 'arbiter',
                    'registryId': '*GLOBAL*',
                    'scope': {
                        'decision_type': 'invoke_tool',
                        'domain': 'escalate',
                        'conditions': {},
                        'limits': {},
                    },
                    'riskRating': 'low',
                    'revoked': False,
                },
            ]
            for unit in authority_units:
                authority_units_table.put_item(Item=unit)
                print(f"Seeded authority unit: {unit['unitId']}")
        else:
            print(
                "WARNING: AUTHORITY_UNITS_TABLE not set — "
                "skipping authority unit seed (partial deploy?)"
            )

        # Constitutional layers — 1 global row. The two rules map directly
        # onto the deterministic operator set implemented by
        # GovernanceEngine._constitutional_review (US-ARB-007 AC 5).
        if CONSTITUTIONAL_LAYERS_TABLE:
            constitutional_layers_table = dynamodb.Table(CONSTITUTIONAL_LAYERS_TABLE)
            global_constitution = {
                'layerId': 'global-constitution',
                'layerType': 'global',
                'appliesTo': [],
                'rules': [
                    {
                        'field': 'audit.record_produced',
                        'operator': 'eq',
                        'value': True,
                        'description': 'no_irreversible_action_without_audit_trail',
                    },
                    {
                        'field': 'scope.expansion_under_unconfirmed_state',
                        'operator': 'eq',
                        'value': False,
                        'description': 'no_scope_expansion_under_unconfirmed_state',
                    },
                ],
            }
            constitutional_layers_table.put_item(Item=global_constitution)
            print(f"Seeded constitutional layer: {global_constitution['layerId']}")
        else:
            print(
                "WARNING: CONSTITUTIONAL_LAYERS_TABLE not set — "
                "skipping constitutional layer seed (partial deploy?)"
            )

        cfnresponse.send(event, context, cfnresponse.SUCCESS, {
            'Message': 'Agent config seeded successfully',
            'registrySeeded': registry_seeded,
        })
    except Exception as e:
        print(f"Error seeding data: {str(e)}")
        cfnresponse.send(event, context, cfnresponse.FAILED, {
            'Message': str(e)
        })
