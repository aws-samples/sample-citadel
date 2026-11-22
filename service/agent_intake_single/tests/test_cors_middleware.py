"""Tests for CORS middleware configuration on the intake runtime.

The runtime is invoked server-to-server by agent-message-handler using
SigV4 — there is no browser client in production. The default app must
therefore carry NO CORS middleware. A gated, explicit dev-only env flag
(CITADEL_DEV_CORS_ORIGINS) may enable CORS for a comma-separated allowlist
of origins, but credentials must never be combined with that allowlist.

Some sibling test modules in this package (test_agent_cache.py,
test_agent_emf_path.py, ...) install a stub ``bedrock_agentcore`` module
into ``sys.modules`` so ``agent.py`` can be imported outside the AgentCore
runtime image. That stub's ``_StubApp.add_middleware`` is a no-op, which
would make every assertion here vacuously true regardless of what
agent.py actually does. These tests exercise the *real* CORSMiddleware
behavior, so they force the genuine ``bedrock_agentcore`` package back
into ``sys.modules`` before (re)importing agent.py, and restore whatever
was there afterward so later tests in the same session aren't affected.
"""
import importlib
import os
import sys

import pytest

from starlette.middleware.cors import CORSMiddleware


def _reload_agent_module():
    """Import (or re-import) agent.py fresh so module-level app
    construction re-runs under the current environment variables,
    using the real bedrock_agentcore package (not a sibling test's stub)."""
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

    saved_stub = sys.modules.pop("bedrock_agentcore", None)
    try:
        real_bedrock_agentcore = importlib.import_module("bedrock_agentcore")
    finally:
        pass
    sys.modules["bedrock_agentcore"] = real_bedrock_agentcore

    if "agent" in sys.modules:
        module = importlib.reload(sys.modules["agent"])
    else:
        module = importlib.import_module("agent")

    if saved_stub is not None:
        sys.modules["bedrock_agentcore"] = saved_stub
    return module


def _cors_entries(app):
    return [m for m in app.user_middleware if m.cls is CORSMiddleware]


@pytest.fixture(autouse=True)
def _clean_cors_env(monkeypatch):
    monkeypatch.delenv("CITADEL_DEV_CORS_ORIGINS", raising=False)
    yield


def test_default_app_has_no_cors_middleware(monkeypatch):
    monkeypatch.delenv("CITADEL_DEV_CORS_ORIGINS", raising=False)
    agent = _reload_agent_module()

    assert _cors_entries(agent.app) == [], (
        "intake runtime is invoked server-to-server via SigV4 only; "
        "no CORS middleware should be installed by default"
    )


def test_dev_env_flag_enables_scoped_cors_without_credentials(monkeypatch):
    monkeypatch.setenv(
        "CITADEL_DEV_CORS_ORIGINS", "http://localhost:5173"
    )
    agent = _reload_agent_module()

    entries = _cors_entries(agent.app)
    assert len(entries) == 1, "expected exactly one CORS middleware entry when dev flag is set"

    kwargs = entries[0].kwargs
    assert kwargs.get("allow_origins") == ["http://localhost:5173"]
    assert kwargs.get("allow_credentials") is False, (
        "dev CORS path must never combine allow_credentials=True with an origin allowlist"
    )


def test_dev_env_flag_supports_multiple_comma_separated_origins(monkeypatch):
    monkeypatch.setenv(
        "CITADEL_DEV_CORS_ORIGINS",
        "http://localhost:5173,http://localhost:3000",
    )
    agent = _reload_agent_module()

    entries = _cors_entries(agent.app)
    assert len(entries) == 1
    kwargs = entries[0].kwargs
    assert kwargs.get("allow_origins") == [
        "http://localhost:5173",
        "http://localhost:3000",
    ]
    assert kwargs.get("allow_credentials") is False
