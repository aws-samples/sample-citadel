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

# QW-B: the model id used to be resolved right here at MODULE IMPORT — a
# DynamoDB get_item on the model-config table plus a FULL Scan of the model
# catalog table on every container cold start. Resolution is now deferred to
# first use and cached for the process lifetime. The resolution inputs
# (region + env-derived fallback) are identical, so the resolved id — and
# the safe fallback when the tables are unreachable — are unchanged.
_MODEL_ID_UNSET = object()
_agent_model_id = _MODEL_ID_UNSET
_agent_model = None


def get_agent_model_id() -> str:
    """Resolve the intake model id on first use; cached in-process."""
    global _agent_model_id
    if _agent_model_id is _MODEL_ID_UNSET:
        _agent_model_id = load_intake_model_id(
            region=AWS_REGION, fallback_model_id=_FALLBACK_MODEL_ID,
        )
    return _agent_model_id


def get_agent_model():
    """Build the intake BedrockModel on first use; cached in-process."""
    global _agent_model
    if _agent_model is None:
        _agent_model = BedrockModel(
            model_id=get_agent_model_id(),
            region_name=AWS_REGION,
            max_tokens=8192,
        )
    return _agent_model


def __getattr__(name):
    """Lazy module attributes (PEP 562): ``config.AGENT_MODEL_ID`` and
    ``config.AGENT_MODEL`` keep working, resolved on first access instead of
    at import."""
    if name == 'AGENT_MODEL_ID':
        return get_agent_model_id()
    if name == 'AGENT_MODEL':
        return get_agent_model()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


# Raw boto3 client for converse() calls inside tools
bedrock = boto3.client(
    'bedrock-runtime',
    region_name=AWS_REGION,
    config=Config(read_timeout=300, connect_timeout=60),
)

s3 = boto3.client('s3', region_name=AWS_REGION)
bedrock_agent = boto3.client('bedrock-agent-runtime', region_name=AWS_REGION)
# Force redeploy Wed Jun 10 18:10:00 AEST 2026
