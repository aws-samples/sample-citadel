import json
import os
import boto3
import cfnresponse
from datetime import datetime

# Single source of truth for every seeded organisation. Both the org row
# AND its NAME# reservation row (below) are derived from this SAME list, so
# the two can never drift apart (finding 003a9234, mechanism 1). Do not add
# an organisation anywhere else — add it here only.
ORGANIZATIONS = [
    {
        'orgId': 'org-000',
        'name': 'Default',
        'description': 'Default organisation',
    },
    {
        'orgId': 'org-001',
        'name': 'Engineering',
        'description': 'Engineering and Development Team',
    },
    {
        'orgId': 'org-002',
        'name': 'Product',
        'description': 'Product Management Team',
    },
    {
        'orgId': 'org-003',
        'name': 'Operations',
        'description': 'Operations and Infrastructure Team',
    },
]


def name_reservation_key(name):
    """Mirrors nameReservationKey() in organization-resolver.ts — the
    NAME#<name> row is the atomic uniqueness authority createOrganization
    checks via a conditional put. Must stay byte-identical to the
    TypeScript implementation."""
    return 'NAME#{}'.format(name)


def handler(event, context):
    print('Event:', json.dumps(event))

    if event['RequestType'] == 'Delete':
        cfnresponse.send(event, context, cfnresponse.SUCCESS, {})
        return

    try:
        dynamodb = boto3.resource('dynamodb')
        table_name = os.environ['ORGANISATION_TABLE']

        table = dynamodb.Table(table_name)

        # Get current timestamp in ISO 8601 format (without microseconds for AppSync compatibility)
        current_time = datetime.utcnow().replace(microsecond=0).isoformat() + 'Z'

        # Seed all organisations AND, for each one, the NAME# reservation row
        # that createOrganization's atomic conditional put relies on as its
        # uniqueness authority (finding 003a9234, mechanism 1). Without this,
        # a fresh deployment's seeded names (e.g. "Default") could be
        # duplicated by a later createOrganization call, because no
        # reservation row would exist yet to trip attribute_not_exists.
        #
        # Reservation row shape matches organization-resolver.ts's
        # NameReservationItem exactly: { orgId: 'NAME#<name>', itemType:
        # 'name_reservation', name, reservedOrgId, createdAt }.
        for org in ORGANIZATIONS:
            org_item = {
                'orgId': org['orgId'],
                'name': org['name'],
                'description': org['description'],
                'createdAt': current_time,
            }
            try:
                table.put_item(Item=org_item)
                print("Created organization: {}".format(org['name']))
            except Exception as e:
                print("Warning creating organization {}: {}".format(org['name'], str(e)))
                # Continue even if one fails (might already exist)

            reservation_item = {
                'orgId': name_reservation_key(org['name']),
                'itemType': 'name_reservation',
                'name': org['name'],
                'reservedOrgId': org['orgId'],
                'createdAt': current_time,
            }
            try:
                # Conditional put mirrors createOrganization's own
                # attribute_not_exists guard, so re-running this seeder
                # (idempotent Custom Resource semantics) never clobbers a
                # reservation that already exists — e.g. one created since by
                # a real createOrganization call, or a tombstone written by
                # deleteOrganization.
                table.put_item(
                    Item=reservation_item,
                    ConditionExpression='attribute_not_exists(orgId)',
                )
                print("Reserved organization name: {}".format(org['name']))
            except Exception as e:
                print(
                    "Warning reserving organization name {}: {}".format(
                        org['name'], str(e)
                    )
                )
                # Continue — a pre-existing reservation (or tombstone) row is
                # expected on re-run and is not an error.

        cfnresponse.send(event, context, cfnresponse.SUCCESS, {
            'Message': 'Organizations seeded successfully',
            'Count': len(ORGANIZATIONS)
        })
    except Exception as e:
        print(f"Error seeding organizations: {str(e)}")
        cfnresponse.send(event, context, cfnresponse.FAILED, {
            'Message': str(e)
        })
