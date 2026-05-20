"""
Emailer Agent - Sends emails to specified recipients using SMTP.

Environment Variables Required:
    SMTP_SERVER: SMTP server hostname
    SMTP_PORT: SMTP server port
    SMTP_USERNAME: SMTP authentication username
    SMTP_PASSWORD: SMTP authentication password
    FROM_EMAIL: Sender email address
"""

from strands import Agent, tool, models
import os
import smtplib
from email.message import EmailMessage
from typing import Dict, Any

@tool
def send_email(recipient_email: str, message_content: str) -> Dict[str, str]:
    """
    Send an email using SMTP.
    
    Args:
        recipient_email: Email address of the recipient
        message_content: Content of the email message
        
    Returns:
        Dict containing status ('success' or 'error') and result message
    """
    required_vars = ['SMTP_SERVER', 'SMTP_PORT', 'SMTP_USERNAME', 
                    'SMTP_PASSWORD', 'FROM_EMAIL']
    
    # Check for required environment variables
    for var in required_vars:
        if not os.getenv(var):
            return {
                'status': 'error',
                'message': f'Missing required environment variable: {var}'
            }
    
    try:
        # Create email message
        msg = EmailMessage()
        msg.set_content(message_content)
        msg['Subject'] = 'New Message'
        msg['From'] = os.getenv('FROM_EMAIL')
        msg['To'] = recipient_email
        
        # Connect to SMTP server and send
        with smtplib.SMTP(os.getenv('SMTP_SERVER'), 
                         int(os.getenv('SMTP_PORT'))) as server:
            server.starttls()
            server.login(os.getenv('SMTP_USERNAME'), 
                        os.getenv('SMTP_PASSWORD'))
            server.send_message(msg)
            
        return {
            'status': 'success',
            'message': f'Email sent successfully to {recipient_email}'
        }
        
    except Exception as e:
        return {
            'status': 'error',
            'message': f'Failed to send email: {str(e)}'
        }

def handler(input_data: Dict[str, str]) -> str:
    """
    Send an email to the specified recipient with the given message.
    
    Args:
        input_data: Dictionary containing:
            - to_address: Email address of the recipient
            - message: Content of the email to send
            
    Returns:
        String describing the result of the email sending attempt
    """
    if not isinstance(input_data, dict):
        return "Error: Input must be a dictionary"
        
    if 'to_address' not in input_data or 'message' not in input_data:
        return "Error: Input must contain 'to_address' and 'message' keys"
        
    bedrock_model = models.BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-6",
        region_name="us-west-2"
    )
    
    agent = Agent(bedrock_model, tools=[send_email])
    result = agent(
        f"""Send an email to {input_data['to_address']} with the following message:
        
        {input_data['message']}
        
        Please use the send_email tool to accomplish this task and tell me the result."""
    )
    
    return result