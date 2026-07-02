"""Pure, I/O-free model resolution.

Resolves the effective model for a requested slot by walking a precedence
chain of configured defaults, validating each candidate against the slot's
requirements, and mapping the chosen catalog entry to a region-appropriate
inference profile. No I/O, no AWS clients, no environment reads, no global
state. The fallback default is supplied by the caller as an argument rather
than hardcoded here, and every cross-region prefix is derived from
``cross_region_prefix``.
"""
from __future__ import annotations

from typing import Mapping, Optional

from region import cross_region_prefix
from model_types import (
    CatalogEntry,
    InvocationMode,
    LocalityMode,
    ModelConfig,
    ProfileScope,
    ResolutionSource,
    ResolvedModel,
    SlotRequirements,
)


def candidate_chain(
    slot: str,
    agent_id: Optional[str],
    config: ModelConfig,
) -> list[tuple[ResolutionSource, str]]:
    """Return ``(source, model_key)`` pairs in precedence order.

    Layers with no configured entry are skipped. The order is: agent
    override (if an agent id is given and present), then org default for the
    slot, then slot default, then the global default.
    """
    chain: list[tuple[ResolutionSource, str]] = []
    if agent_id and agent_id in config.agent_overrides:
        chain.append((ResolutionSource.AGENT, config.agent_overrides[agent_id]))
    if slot in config.org_defaults:
        chain.append((ResolutionSource.ORG, config.org_defaults[slot]))
    if slot in config.slot_defaults:
        chain.append((ResolutionSource.SLOT, config.slot_defaults[slot]))
    if config.global_default_key:
        chain.append((ResolutionSource.GLOBAL, config.global_default_key))
    return chain


def is_valid_for_slot(entry: CatalogEntry, requirements: SlotRequirements) -> bool:
    """True iff the entry is usable and satisfies every slot requirement."""
    if not entry.is_usable():
        return False
    if entry.modality != requirements.modality:
        return False
    if requirements.requires_tools and not entry.supports_tools:
        return False
    if requirements.requires_converse and entry.invocation_mode != InvocationMode.CONVERSE:
        return False
    return True


def resolve_profile(
    entry: CatalogEntry,
    region: str,
    locality_mode: LocalityMode,
) -> tuple[Optional[str], ProfileScope, tuple[str, ...]]:
    """Map an entry to an inference-profile id, its scope, and any warnings.

    Under strict locality only a known regional profile is acceptable;
    otherwise a regional profile is preferred, a global profile is the next
    fallback, and finally an id is constructed from the region prefix and the
    entry's base model id.
    """
    prefix = cross_region_prefix(region)
    regional = entry.region_profiles.get(prefix)
    global_profile = entry.region_profiles.get('global')

    if locality_mode == LocalityMode.STRICT:
        if regional:
            return (regional, ProfileScope.REGIONAL, ())
        return (
            None,
            ProfileScope.NONE,
            (f"no known regional profile for prefix '{prefix}' under strict data locality",),
        )

    if regional:
        return (regional, ProfileScope.REGIONAL, ())
    if global_profile:
        if locality_mode == LocalityMode.OFF:
            warnings: tuple[str, ...] = ()
        else:
            warnings = (f"regional profile for prefix '{prefix}' unavailable; using global",)
        return (global_profile, ProfileScope.GLOBAL, warnings)

    constructed = f"{prefix}.{entry.base_model_id}"
    return (
        constructed,
        ProfileScope.REGIONAL,
        (
            f"inference profile availability unknown for prefix '{prefix}'; "
            "constructed by Bedrock convention",
        ),
    )


def resolve_model(
    slot: str,
    requirements: SlotRequirements,
    config: ModelConfig,
    catalog: Mapping[str, CatalogEntry],
    region: str,
    bootstrap_default_model_id: str,
    agent_id: Optional[str] = None,
) -> ResolvedModel:
    """Resolve the effective model for a slot, always returning a result.

    Walks the precedence chain and returns the first candidate that is
    present in the catalog, valid for the slot, and resolvable to a profile.
    If nothing resolves, returns the caller-supplied bootstrap default. Total
    for valid dataclass inputs: never raises for normal input.
    """
    for source, key in candidate_chain(slot, agent_id, config):
        entry = catalog.get(key)
        if entry is None or not is_valid_for_slot(entry, requirements):
            continue
        profile_id, scope, warnings = resolve_profile(entry, region, config.locality_mode)
        if profile_id is None:
            continue
        return ResolvedModel(
            model_id=profile_id,
            model_key=key,
            source=source,
            profile_scope=scope,
            warnings=warnings,
        )

    return ResolvedModel(
        model_id=bootstrap_default_model_id,
        model_key=None,
        source=ResolutionSource.BOOTSTRAP,
        profile_scope=ProfileScope.NONE,
        warnings=("resolved via bootstrap default; no valid configured model",),
    )
