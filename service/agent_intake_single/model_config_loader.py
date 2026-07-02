import logging, os
from model_mapping import resolve_model_id_from_items
from model_types import SlotRequirements, Modality
logger = logging.getLogger(__name__)
_INTAKE_REQ = SlotRequirements(requires_tools=True, modality=Modality.TEXT, requires_converse=True)
_EXTRACTION_REQ = SlotRequirements(requires_tools=False, modality=Modality.TEXT, requires_converse=True)

def _load(slot, requirements, region, fallback_model_id, dynamodb_resource=None):
    try:
        config_table = os.environ.get('MODEL_CONFIG_TABLE'); catalog_table = os.environ.get('MODEL_CATALOG_TABLE')
        if not config_table or not catalog_table:
            return fallback_model_id
        import boto3
        resource = dynamodb_resource or boto3.resource('dynamodb')
        config_item = resource.Table(config_table).get_item(Key={'scope': 'platform'}).get('Item')
        catalog_items = resource.Table(catalog_table).scan().get('Items', [])
        return resolve_model_id_from_items(slot=slot, requirements=requirements, config_item=config_item, catalog_items=catalog_items, region=region, fallback_model_id=fallback_model_id)
    except Exception as exc:
        logger.warning('model resolution failed for slot %s; using fallback: %s', slot, exc)
        return fallback_model_id

def load_intake_model_id(*, region, fallback_model_id, dynamodb_resource=None):
    return _load('intake_agent', _INTAKE_REQ, region, fallback_model_id, dynamodb_resource)

def load_extraction_model_id(*, region, fallback_model_id, dynamodb_resource=None):
    return _load('extraction', _EXTRACTION_REQ, region, fallback_model_id, dynamodb_resource)
