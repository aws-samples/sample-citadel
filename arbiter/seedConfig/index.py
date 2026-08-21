import json
import os
import boto3
import cfnresponse

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


def _seed_agent_registry_record(agent_id, description, module_filename, worker_queue_url):
    """Create an agent's AgentCore Registry record (dual-store seam).

    Generalized from the original demo-echo-only helper so the same
    dual-store contract (DDB row for worker dispatch + AgentCore Registry
    record for the app-publish readiness gate) can be reused for any
    seeded worker agent — currently ``demo-echo-agent`` and the
    diagnostic ``smoke-idempotency-agent`` fixture.

    The DDB AGENT_CONFIG_TABLE row alone is not enough for the out-of-box
    demo flow: app publish gates on the agent BINDING flipping DESIGN→READY,
    and updateAgentBinding (backend/src/lambda/registry-agent-record-
    resolver.ts) resolves the target agent BY NAME in the AgentCore Registry
    and requires the record descriptor's ``state`` to be 'active'. This
    helper mirrors the fabricator's ``store_agent_config_registry`` payload
    (arbiter/fabricator/index.py): a CUSTOM-descriptor record whose
    inlineContent carries categories/icon/state/manifest/config/createdBy/
    orgId. Deliberate deviation: ``state`` is 'active' (these agents are
    seeded immediately runnable, matching their DDB rows) where fabricated
    agents land 'inactive' pending activation. Like the fabricator, the
    record is left in its post-create DRAFT status — no
    UpdateRegistryRecordStatus/Submit call (the registry rejects a
    DRAFT→DRAFT transition, and the READY gate reads descriptor state, not
    record status).

    Guards:
      - No-op (with a log) when REGISTRY_ID/REGISTRY_ENABLED are unset —
        registry-less environments still seed DDB only.
      - No-op (with a log) when ``catalog.registry_client`` is not
        importable — the shared catalog Lambda layer is required for the
        idempotency lookup; DDB-only envs must keep seeding.
      - IDEMPOTENT: mirrors the fabricator's lookup-first behavior — when a
        record with this name already exists, CreateRegistryRecord is
        skipped so CFN re-runs never create duplicates.
    """
    registry_id = os.environ.get('REGISTRY_ID')
    registry_enabled = os.environ.get('REGISTRY_ENABLED')
    if not registry_id or not registry_enabled:
        print(
            'Registry not configured (REGISTRY_ID/REGISTRY_ENABLED unset) — '
            f'skipping {agent_id} registry record seed'
        )
        return

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
        return

    # Idempotency lookup first (mirrors the fabricator's
    # _find_existing_record_id): exact name match on the record name.
    for record in list_agent_records(registry_id):
        if isinstance(record, dict) and record.get('name') == agent_id:
            print(
                f"Registry record '{agent_id}' already exists "
                f"(recordId={record.get('recordId')}); skipping create"
            )
            return

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
        'orgId': '',
    }

    client = boto3.client('bedrock-agentcore-control')
    response = client.create_registry_record(
        registryId=registry_id,
        name=agent_id,
        description=description,
        descriptorType='CUSTOM',
        descriptors={
            'custom': {
                'inlineContent': json.dumps(custom_metadata, default=str),
            },
        },
    )
    print(
        f"Created registry record for {agent_id} "
        f"(status={response.get('status')}); leaving it in its post-create "
        'DRAFT status like fabricator-created records'
    )


def _seed_demo_agent_registry_record(worker_queue_url):
    """Backward-compatible wrapper around the generalized registry seeder,
    kept so the demo-echo-agent call site (and its existing tests) do not
    need to change shape."""
    _seed_agent_registry_record(
        DEMO_ECHO_AGENT_ID, DEMO_ECHO_DESCRIPTION, DEMO_ECHO_MODULE_FILENAME,
        worker_queue_url,
    )


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
    table.put_item(Item=smoke_agent)
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
    else:
        print(
            "WARNING: AGENT_BUCKET_NAME not set — skipping smoke-idempotency "
            "module upload (partial deploy?). Agent config still seeded."
        )

    _seed_agent_registry_record(
        SMOKE_IDEMPOTENCY_AGENT_ID, SMOKE_IDEMPOTENCY_DESCRIPTION,
        SMOKE_IDEMPOTENCY_MODULE_FILENAME, worker_queue_url,
    )


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
        
        table.put_item(Item=fabricator_agent)
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
        table.put_item(Item=echo_agent)
        print(f"Seeded agent: {DEMO_ECHO_AGENT_ID} with queue: {worker_queue_url}")

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
        else:
            print(
                "WARNING: AGENT_BUCKET_NAME not set — skipping echo module "
                "upload (partial deploy?). Agent config still seeded."
            )

        # Dual-store seam: the DDB row above serves worker dispatch; the
        # AgentCore Registry record below is what the app-publish readiness
        # gate (agent binding DESIGN→READY) resolves by name. Guarded +
        # idempotent — see the helper docstring.
        _seed_demo_agent_registry_record(worker_queue_url)

        # ------------------------------------------------------------------
        # Idempotency-seam smoke agent — DIAGNOSTIC FIXTURE, non-prod only.
        # ------------------------------------------------------------------
        # Gated on SMOKE_FIXTURES_ENABLED, which CDK sets exclusively for
        # non-production stacks (backend/lib/arbiter-stack.ts). A production
        # deploy never sets this var, so this whole block — and the smoke
        # table/grant it depends on — simply do not exist there. Idempotent
        # by the same plain-put_item/put_object semantics as the echo agent.
        if SMOKE_FIXTURES_ENABLED:
            _seed_smoke_idempotency_agent(table, worker_queue_url, agent_bucket)
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
            'Message': 'Agent config seeded successfully'
        })
    except Exception as e:
        print(f"Error seeding data: {str(e)}")
        cfnresponse.send(event, context, cfnresponse.FAILED, {
            'Message': str(e)
        })
