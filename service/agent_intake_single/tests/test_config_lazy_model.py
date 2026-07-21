"""QW-B: intake model resolution must be lazy (first use), cached, fallback-safe.

The model id used to be resolved at config MODULE IMPORT — a DynamoDB
get_item on the model-config table plus a FULL catalog-table Scan on every
container cold start. Resolution now happens on first use, is cached
in-process, and preserves the exact same resolution inputs (region + env
fallback) and the safe fallback when tables are unreachable.

Run with:
    PYTHONPATH=. pytest tests/test_config_lazy_model.py -q
from the service/agent_intake_single directory.
"""
import importlib
import os
import sys
from unittest import mock

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


@pytest.fixture(autouse=True)
def _restore_config_module():
    """Each test re-imports a fresh ``config``; put the original back so the
    rest of the suite (tools.* hold references to it) is unaffected."""
    original = sys.modules.get("config")
    yield
    if original is not None:
        sys.modules["config"] = original
    else:
        sys.modules.pop("config", None)


def _fresh_config(monkeypatch, **env):
    """Import a fresh config module with a controlled environment."""
    for key in ("MODEL_CONFIG_TABLE", "MODEL_CATALOG_TABLE", "AGENT_MODEL"):
        monkeypatch.delenv(key, raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    sys.modules.pop("config", None)
    return importlib.import_module("config")


def test_import_of_config_does_not_touch_dynamodb(monkeypatch):
    """Even with the model tables configured, importing config must not
    construct a DynamoDB resource (no get_item, no catalog Scan)."""
    monkeypatch.setenv("MODEL_CONFIG_TABLE", "cfg-t")
    monkeypatch.setenv("MODEL_CATALOG_TABLE", "cat-t")
    import boto3
    resource_spy = mock.MagicMock(name="boto3.resource")
    monkeypatch.setattr(boto3, "resource", resource_spy)

    sys.modules.pop("config", None)
    importlib.import_module("config")

    resource_spy.assert_not_called()


def test_first_use_resolves_once_and_caches(monkeypatch):
    cfg = _fresh_config(monkeypatch)
    calls = []

    def fake_loader(*, region, fallback_model_id):
        calls.append((region, fallback_model_id))
        return "resolved-model-id"

    monkeypatch.setattr(cfg, "load_intake_model_id", fake_loader)

    assert cfg.get_agent_model_id() == "resolved-model-id"
    assert cfg.get_agent_model_id() == "resolved-model-id"
    # Module attribute access keeps working, served from the same cache.
    assert cfg.AGENT_MODEL_ID == "resolved-model-id"
    assert len(calls) == 1


def test_resolution_inputs_are_unchanged(monkeypatch):
    """The lazy path must hand the loader the exact same inputs the eager
    path did: the runtime region and the env-derived fallback id."""
    cfg = _fresh_config(monkeypatch, AGENT_MODEL="env-forced-model-id")
    seen = {}

    def fake_loader(*, region, fallback_model_id):
        seen["region"] = region
        seen["fallback"] = fallback_model_id
        return fallback_model_id

    monkeypatch.setattr(cfg, "load_intake_model_id", fake_loader)

    assert cfg.get_agent_model_id() == "env-forced-model-id"
    assert seen["region"] == cfg.AWS_REGION
    assert seen["fallback"] == "env-forced-model-id"


def test_agent_model_is_lazy_and_cached(monkeypatch):
    cfg = _fresh_config(monkeypatch)
    monkeypatch.setattr(
        cfg, "load_intake_model_id",
        lambda *, region, fallback_model_id: "resolved-model-id",
    )
    fake_model_cls = mock.MagicMock(name="BedrockModel")
    monkeypatch.setattr(cfg, "BedrockModel", fake_model_cls)

    first = cfg.get_agent_model()
    second = cfg.AGENT_MODEL

    assert first is second
    fake_model_cls.assert_called_once_with(
        model_id="resolved-model-id",
        region_name=cfg.AWS_REGION,
        max_tokens=8192,
    )


def test_fallback_intact_when_tables_unreachable(monkeypatch):
    """Real loader path: tables configured but DynamoDB unreachable — the
    resolution must degrade to the env fallback, exactly as before."""
    monkeypatch.setenv("MODEL_CONFIG_TABLE", "cfg-t")
    monkeypatch.setenv("MODEL_CATALOG_TABLE", "cat-t")
    monkeypatch.setenv("AGENT_MODEL", "env-forced-model-id")
    import boto3
    monkeypatch.setattr(
        boto3, "resource",
        mock.MagicMock(side_effect=RuntimeError("dynamodb unreachable")),
    )

    sys.modules.pop("config", None)
    cfg = importlib.import_module("config")

    assert cfg.get_agent_model_id() == "env-forced-model-id"


def test_unknown_attribute_still_raises(monkeypatch):
    cfg = _fresh_config(monkeypatch)
    with pytest.raises(AttributeError):
        _ = cfg.NOT_A_REAL_CONFIG_ATTRIBUTE
