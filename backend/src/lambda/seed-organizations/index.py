import json
import os
import boto3
import cfnresponse
from datetime import datetime

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
        
        # Define organizations to seed
        organizations = [
            {
                'orgId': 'org-000',
                'name': 'Default',
                'description': 'Default organisation',
                'createdAt': current_time
            },
            {
                'orgId': 'org-001',
                'name': 'Engineering',
                'description': 'Engineering and Development Team',
                'createdAt': current_time
            },
            {
                'orgId': 'org-002',
                'name': 'Product',
                'description': 'Product Management Team',
                'createdAt': current_time
            },
            {
                'orgId': 'org-003',
                'name': 'Operations',
                'description': 'Operations and Infrastructure Team',
                'createdAt': current_time
            }
        ]
        
        # Seed all organizations
        for org in organizations:
            try:
                table.put_item(Item=org)
                print(f"✓ Created organization: {org['name']}")
            except Exception as e:
                print(f"Warning creating organization {org['name']}: {str(e)}")
                # Continue even if one fails (might already exist)
        
        cfnresponse.send(event, context, cfnresponse.SUCCESS, {
            'Message': 'Organizations seeded successfully',
            'Count': len(organizations)
        })
    except Exception as e:
        print(f"Error seeding organizations: {str(e)}")
        cfnresponse.send(event, context, cfnresponse.FAILED, {
            'Message': str(e)
        })
