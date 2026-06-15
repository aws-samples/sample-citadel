import json
import boto3
import cfnresponse


def handler(event, context):
    print('Event:', json.dumps(event))

    # Delete must always succeed without touching downstream resources.
    # CloudFormation tears the secret/user pool client down separately, and
    # we must never read non-required ResourceProperties on a delete.
    if event.get('RequestType') == 'Delete':
        cfnresponse.send(event, context, cfnresponse.SUCCESS, {})
        return

    secret_arn = None
    try:
        cognito = boto3.client('cognito-idp')
        secretsmanager = boto3.client('secretsmanager')

        props = event.get('ResourceProperties', {})
        user_pool_id = props['UserPoolId']
        client_id = props['ClientId']
        secret_arn = props['SecretArn']
        token_url = props['TokenUrl']
        confluence_domain = props['ConfluenceDomain']

        # Fetch the real OAuth client secret from Cognito.
        response = cognito.describe_user_pool_client(
            UserPoolId=user_pool_id,
            ClientId=client_id,
        )
        client_secret = response['UserPoolClient']['ClientSecret']

        # Update Secrets Manager with the real client secret + connector config.
        secret_value = {
            'client_id': client_id,
            'client_secret': client_secret,
            'token_url': token_url,
            'confluence_domain': confluence_domain,
        }
        secretsmanager.put_secret_value(
            SecretId=secret_arn,
            SecretString=json.dumps(secret_value),
        )

        cfnresponse.send(
            event,
            context,
            cfnresponse.SUCCESS,
            {'SecretArn': secret_arn},
        )

    except Exception as e:
        # Core fix: notify CloudFormation BEFORE re-raising so the stack
        # does not hang to its custom-resource timeout (default 1 hour).
        # Re-raise afterwards so Lambda metrics still record the error.
        print(f'Error: {str(e)}')
        cfnresponse.send(
            event,
            context,
            cfnresponse.FAILED,
            {'Message': str(e)},
        )
        raise
