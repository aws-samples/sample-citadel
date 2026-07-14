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
                'description': 'Demo agent that echoes its input back as output.',
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
