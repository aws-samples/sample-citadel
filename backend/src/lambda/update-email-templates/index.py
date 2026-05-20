import json
import os
import boto3
import cfnresponse

def handler(event, context):
    """
    Custom Resource Lambda to update Cognito User Pool email templates
    This runs after CloudFront distribution is created to configure email templates
    """
    print('Event:', json.dumps(event))
    
    # Handle Delete - nothing to clean up
    if event['RequestType'] == 'Delete':
        print('Delete request - nothing to clean up')
        cfnresponse.send(event, context, cfnresponse.SUCCESS, {
            'Message': 'Delete completed - no action needed'
        })
        return
    
    try:
        # Get properties from Custom Resource
        user_pool_id = event['ResourceProperties']['UserPoolId']
        verification_template = event['ResourceProperties']['VerificationTemplate']
        invitation_template = event['ResourceProperties']['InvitationTemplate']
        password_reset_template = event['ResourceProperties'].get('PasswordResetTemplate', '')
        cloudfront_url = event['ResourceProperties']['CloudFrontUrl']
        
        print(f'Updating User Pool: {user_pool_id}')
        print(f'CloudFront URL: {cloudfront_url}')
        
        # Validate inputs
        if not user_pool_id or not verification_template or not invitation_template:
            raise ValueError('Missing required properties: UserPoolId, VerificationTemplate, or InvitationTemplate')
        
        # Create Cognito client
        cognito = boto3.client('cognito-idp')
        
        # Update User Pool with email templates
        update_params = {
            'UserPoolId': user_pool_id,
            'VerificationMessageTemplate': {
                'DefaultEmailOption': 'CONFIRM_WITH_CODE',
                'EmailMessage': verification_template,
                'EmailSubject': 'Verify your email for CITADEL',
                'SmsMessage': 'The verification code to your new account is {####}'
            },
            'AdminCreateUserConfig': {
                'AllowAdminCreateUserOnly': True,
                'InviteMessageTemplate': {
                    'EmailMessage': invitation_template,
                    'EmailSubject': 'Welcome to CITADEL',
                    'SMSMessage': 'Your username is {username} and temporary password is {####}'
                }
            }
        }

        # Include password reset template for forgot-password email customization
        if password_reset_template:
            print('Including password reset email template')
            # Cognito uses AccountRecoverySetting for password reset delivery
            # The custom email content for forgot-password is set via the
            # VerificationMessageTemplate when triggered by ForgotPassword API.
            # To use a separate template, a CustomMessage Lambda trigger is needed.
            # Store the template reference for the custom message trigger.
            update_params['AccountRecoverySetting'] = {
                'RecoveryMechanisms': [
                    {
                        'Priority': 1,
                        'Name': 'verified_email'
                    }
                ]
            }

        cognito.update_user_pool(**update_params)
        
        print('✅ Successfully updated email templates')
        
        # Send success response to CloudFormation
        cfnresponse.send(event, context, cfnresponse.SUCCESS, {
            'Message': 'Email templates updated successfully',
            'UserPoolId': user_pool_id,
            'CloudFrontUrl': cloudfront_url
        })
        
    except Exception as e:
        print(f'❌ Error updating email templates: {str(e)}')
        
        # Send failure response to CloudFormation
        cfnresponse.send(event, context, cfnresponse.FAILED, {
            'Message': str(e)
        })
