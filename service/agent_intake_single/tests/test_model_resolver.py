"""Smoke test for the service-side copy of the pure model resolver.

Runs from the service test root and imports the mirrored ``model_resolver`` /
``model_types`` modules directly (the same layout the Docker build sees). The
parity contract test lives in the arbiter layer; this file only checks the
copy is wired up and behaves. Model ids are generic placeholders.
"""
import os, sys

import pytest
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import model_resolver as mr  # noqa: E402
import model_types as mt      # noqa: E402


def test_precedence_pick_returns_expected_enabled_model_key():
    catalog = {
        'm-agent': mt.CatalogEntry(
            model_key='m-agent', provider='provider', base_model_id='provider.m-agent',
            status=mt.ModelStatus.ENABLED, region_profiles={'us': 'us.provider.m-agent'}),
        'm-global': mt.CatalogEntry(
            model_key='m-global', provider='provider', base_model_id='provider.m-global',
            status=mt.ModelStatus.ENABLED, region_profiles={'us': 'us.provider.m-global'}),
    }
    config = mt.ModelConfig(
        global_default_key='m-global',
        agent_overrides={'agent-1': 'm-agent'})
    resolved = mr.resolve_model(
        'chat', mt.SlotRequirements(), config, catalog, 'us-east-1',
        'provider.bootstrap', agent_id='agent-1')
    assert resolved.model_key == 'm-agent'
    assert resolved.source == mt.ResolutionSource.AGENT


def test_empty_catalog_falls_back_to_bootstrap():
    bootstrap = 'provider.bootstrap-model'
    resolved = mr.resolve_model(
        'chat', mt.SlotRequirements(),
        mt.ModelConfig(global_default_key='m-global'), {}, 'us-east-1', bootstrap)
    assert resolved.source == mt.ResolutionSource.BOOTSTRAP
    assert resolved.model_id == bootstrap
