"""Supervisor model-selection I/O layer.

Resolves the supervisor's effective model from the platform configuration and
model catalog DynamoDB tables via the shared pure resolver
(``common.model_resolver.resolve_model``), with a bulletproof fallback to the
previously-used default supplied by the caller.

Unlike ``common/`` this module is intentionally NOT pure: it reads environment
variables and DynamoDB. It lives under ``supervisor/`` because the read is a
per-unit concern. Every failure mode — a missing env var, a missing config
item, a malformed catalog item, or any other exception — returns the
caller-supplied fallback and logs a warning. It never raises and never crashes
module import.

The read is a cold-start read (one config get + one catalog scan per Lambda
container). TTL caching can be layered on later without changing the contract.
"""
import logging
import os

from common.model_resolver import resolve_model
from common.model_types import (
    CatalogEntry,
    InvocationMode,
    LocalityMode,
    Modality,
    ModelConfig,
    ModelStatus,
    SlotRequirements,
)

logger = logging.getLogger(__name__)

_SLOT = 'supervisor'
_REQUIREMENTS = SlotRequirements(
    requires_tools=True,
    modality=Modality.TEXT,
    requires_converse=True,
)


def _catalog_from_items(items):
    """Map raw DynamoDB catalog items to a ``{model_key: CatalogEntry}`` map.

    The resolver expects a mapping keyed by model key, so the entries are
    collected into a dict. Enum-valued fields are coerced through their enum
    constructors; absent enum fields default to the safe values
    (``disabled`` / ``text`` / ``converse``).
    """
    catalog = {}
    for item in items:
        entry = CatalogEntry(
            model_key=item['modelKey'],
            provider=item.get('provider', ''),
            base_model_id=item.get('baseModelId', ''),
            status=ModelStatus(item.get('status') or 'disabled'),
            modality=Modality(item.get('modality') or 'text'),
            invocation_mode=InvocationMode(item.get('invocationMode') or 'converse'),
            supports_tools=bool(item.get('supportsTools', False)),
            supports_system_prompt=bool(item.get('supportsSystemPrompt', True)),
            supports_streaming=bool(item.get('supportsStreaming', True)),
            region_profiles=item.get('regionProfiles') or {},
        )
        catalog[entry.model_key] = entry
    return catalog


def _config_from_item(item):
    """Map a raw DynamoDB config item to a ``ModelConfig``.

    Absent maps default to ``{}`` and an absent (or empty) ``localityMode``
    defaults to ``off``.
    """
    return ModelConfig(
        global_default_key=item.get('globalDefaultKey'),
        slot_defaults=item.get('slotDefaults') or {},
        org_defaults=item.get('orgDefaults') or {},
        agent_overrides=item.get('agentOverrides') or {},
        locality_mode=LocalityMode(item.get('localityMode') or 'off'),
    )


def load_model_id(*, region, fallback_model_id, dynamodb_resource=None):
    """Resolve the supervisor model id, falling back on any failure.

    Returns the resolved inference-profile id when the config and catalog
    tables yield a valid model for the supervisor slot; otherwise returns
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
        cfg_item = resource.Table(config_table).get_item(Key={'scope': 'platform'}).get('Item')
        if not cfg_item:
            return fallback_model_id
        catalog_items = resource.Table(catalog_table).scan().get('Items', [])
        resolved = resolve_model(
            _SLOT,
            _REQUIREMENTS,
            _config_from_item(cfg_item),
            _catalog_from_items(catalog_items),
            region,
            fallback_model_id,
        )
        return resolved.model_id
    except Exception as exc:
        logger.warning('supervisor model resolution failed; using fallback: %s', exc)
        return fallback_model_id
