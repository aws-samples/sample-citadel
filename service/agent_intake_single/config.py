import boto3
import os
from strands.models import BedrockModel
from botocore.config import Config

AWS_REGION = os.getenv('AWS_REGION', 'ap-southeast-2')
SESSION_BUCKET = os.getenv('SESSION_BUCKET', '')
KNOWLEDGE_BASE_ID = os.getenv('KNOWLEDGE_BASE_ID', '')

AGENT_MODEL_ID = os.getenv('AGENT_MODEL', 'au.anthropic.claude-sonnet-4-6')

AGENT_MODEL = BedrockModel(
    model_id=AGENT_MODEL_ID,
    region_name=AWS_REGION,
    temperature=0.5,
    max_tokens=8192,
)

# Raw boto3 client for converse() calls inside tools
bedrock = boto3.client(
    'bedrock-runtime',
    region_name=AWS_REGION,
    config=Config(read_timeout=300, connect_timeout=60),
)

s3 = boto3.client('s3', region_name=AWS_REGION)
bedrock_agent = boto3.client('bedrock-agent-runtime', region_name=AWS_REGION)
