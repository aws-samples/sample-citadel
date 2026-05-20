import json
import boto3

cognito = boto3.client('cognito-idp')
secretsmanager = boto3.client('secretsmanager')

def handler(event, context):
    try:
        # Get properties from event
        props = event.get('ResourceProperties', {})
        user_pool_id = props['UserPoolId']
        client_id = props['ClientId']
        secret_arn = props['SecretArn']
        token_url = props['TokenUrl']
        confluence_domain = props['ConfluenceDomain']
        
        # Get client secret from Cognito
        response = cognito.describe_user_pool_client(
            UserPoolId=user_pool_id,
            ClientId=client_id
        )
        
        client_secret = response['UserPoolClient']['ClientSecret']
        
        # Update Secrets Manager with real client secret
        secret_value = {
            'client_id': client_id,
            'client_secret': client_secret,
            'token_url': token_url,
            'confluence_domain': confluence_domain
        }
        
        secretsmanager.put_secret_value(
            SecretId=secret_arn,
            SecretString=json.dumps(secret_value)
        )
        
        return {
            'statusCode': 200,
            'body': json.dumps({
                'SecretArn': secret_arn,
                'Status': 'SUCCESS'
            })
        }
        
    except Exception as e:
        print(f"Error: {str(e)}")
        raise
