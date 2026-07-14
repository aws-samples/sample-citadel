import boto3
import os
from strands.models import BedrockModel
from botocore.config import Config
from region import cross_region_prefix
from model_config_loader import load_intake_model_id

# Force redeploy: model region fix 2026-06-09
AWS_REGION = os.getenv('AWS_REGION', 'ap-southeast-2')
SESSION_BUCKET = os.getenv('SESSION_BUCKET', '')
KNOWLEDGE_BASE_ID = os.getenv('KNOWLEDGE_BASE_ID', '')

_BASE_MODEL = os.getenv('AGENT_MODEL_BASE', 'anthropic.claude-sonnet-4-6')
_FALLBACK_MODEL_ID = os.getenv('AGENT_MODEL') or f'{cross_region_prefix(AWS_REGION)}.{_BASE_MODEL}'
AGENT_MODEL_ID = load_intake_model_id(region=AWS_REGION, fallback_model_id=_FALLBACK_MODEL_ID)

AGENT_MODEL = BedrockModel(
    model_id=AGENT_MODEL_ID,
    region_name=AWS_REGION,
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
# Force redeploy Wed Jun 10 18:10:00 AEST 2026
