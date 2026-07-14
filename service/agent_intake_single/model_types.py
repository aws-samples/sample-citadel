"""Pure shared value types for model selection.

Dependency-free dataclasses and enumerations that describe model catalog
entries, per-slot requirements, configured defaults, and the outcome of
resolving a concrete model. These are plain value objects: no I/O, no AWS
clients, no environment reads, no global state. They can be imported from any
layer without side effects.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class InvocationMode(str, Enum):
    """How a model is invoked."""

    CONVERSE = 'converse'
    INVOKE = 'invoke_model'


class Modality(str, Enum):
    """The primary input/output modality a model serves."""

    TEXT = 'text'
    EMBEDDING = 'embedding'
    IMAGE = 'image'
    OTHER = 'other'


class ModelStatus(str, Enum):
    """Lifecycle status of a catalog entry."""

    ENABLED = 'enabled'
    DISABLED = 'disabled'
    DEPRECATED = 'deprecated'
    DISCOVERED = 'discovered'


class LocalityMode(str, Enum):
    """How strictly regional data locality is enforced during resolution."""

    OFF = 'off'
    REGIONAL_PREFERRED = 'regional_preferred'
    STRICT = 'strict'


class ProfileScope(str, Enum):
    """Geographic scope of the inference profile that was selected."""

    REGIONAL = 'regional'
    GLOBAL = 'global'
    NONE = 'none'


class ResolutionSource(str, Enum):
    """Which configuration layer supplied the chosen model."""

    AGENT = 'agent'
    ORG = 'org'
    SLOT = 'slot'
    GLOBAL = 'global'
    BOOTSTRAP = 'bootstrap'


@dataclass
class CatalogEntry:
    """A single known model and its capabilities.

    ``region_profiles`` maps a cross-region prefix (for example ``'us'``,
    ``'eu'`` or ``'global'``) to a concrete inference-profile id.
    """

    model_key: str
    provider: str
    base_model_id: str
    status: ModelStatus = ModelStatus.DISABLED
    modality: Modality = Modality.TEXT
    invocation_mode: InvocationMode = InvocationMode.CONVERSE
    supports_tools: bool = False
    supports_system_prompt: bool = True
    supports_streaming: bool = True
    region_profiles: dict[str, str] = field(default_factory=dict)

    def is_usable(self) -> bool:
        return self.status == ModelStatus.ENABLED


@dataclass
class SlotRequirements:
    """Constraints a candidate model must satisfy to serve a slot."""

    requires_tools: bool = False
    modality: Modality = Modality.TEXT
    requires_converse: bool = False


@dataclass
class ModelConfig:
    """Configured defaults across precedence layers.

    ``slot_defaults`` and ``org_defaults`` map a slot to a model key.
    ``agent_overrides`` maps an agent id to a model key.
    """

    global_default_key: Optional[str] = None
    slot_defaults: dict[str, str] = field(default_factory=dict)
    org_defaults: dict[str, str] = field(default_factory=dict)
    agent_overrides: dict[str, str] = field(default_factory=dict)
    locality_mode: LocalityMode = LocalityMode.OFF


@dataclass
class ResolvedModel:
    """The result of resolving a model for a slot."""

    model_id: str
    model_key: Optional[str]
    source: ResolutionSource
    profile_scope: ProfileScope
    warnings: tuple[str, ...] = ()
