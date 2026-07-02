"""Fabricator model-selection I/O layer.

Resolves the fabricator's effective model from the platform configuration and
model catalog DynamoDB tables, delegating all item->dataclass mapping and the
resolution walk to the shared pure kernel
(``common.model_mapping.resolve_model_id_from_items``), with a bulletproof
fallback to the previously-used default supplied by the caller.

Unlike ``common/`` this module is intentionally NOT pure: it reads environment
variables and DynamoDB. It lives under ``fabricator/`` because the read is a
per-unit concern. Every failure mode — a missing env var, a missing config
item, a malformed catalog item, or any other exception — returns the
caller-supplied fallback and logs a warning. It never raises and never crashes
module import.

The read is a cold-start read (one config get + one catalog scan per Lambda
container). TTL caching can be layered on later without changing the contract.
"""
import logging
import os

from common.model_mapping import resolve_model_id_from_items
from common.model_types import Modality, SlotRequirements

logger = logging.getLogger(__name__)

_SLOT = 'fabricator'
_REQUIREMENTS = SlotRequirements(
    requires_tools=True,
    modality=Modality.TEXT,
    requires_converse=True,
)


def load_model_id(*, region, fallback_model_id, dynamodb_resource=None):
    """Resolve the fabricator model id, falling back on any failure.

    Returns the resolved inference-profile id when the config and catalog
    tables yield a valid model for the fabricator slot; otherwise returns
    ``fallback_model_id``. Any exception is swallowed (logged as a warning) so
    this never raises.
    """
    try:
        config_table = os.environ.get('MODEL_CONFIG_TABLE')
        catalog_table = os.environ.get('MODEL_CATALOG_TABLE')
        if not config_table or not catalog_table:
            return fallback_model_id
        import boto3
        resource = dynamodb_resource or boto3.resource('dynamodb')
        config_item = resource.Table(config_table).get_item(Key={'scope': 'platform'}).get('Item')
        catalog_items = resource.Table(catalog_table).scan().get('Items', [])
        return resolve_model_id_from_items(
            slot=_SLOT,
            requirements=_REQUIREMENTS,
            config_item=config_item,
            catalog_items=catalog_items,
            region=region,
            fallback_model_id=fallback_model_id,
        )
    except Exception as exc:
        logger.warning('fabricator model resolution failed; using fallback: %s', exc)
        return fallback_model_id
