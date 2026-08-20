"""Tests for the PR2 client-token passthrough (server-side, post-canonicalization).

A target that supports an end-to-end idempotency token gets one injected
SERVER-SIDE by the idempotency hook, AFTER the args hash is computed (so the
token never perturbs the ledger key) and OVERWRITING any model-supplied value
(so the model cannot impersonate another org's idempotency namespace). Wiring
is gated by a per-tool ``clientTokenParam`` config.

Inventory note (grounded, not guessed): no existing adapter — neither the
agent-source import adapters (``backend/src/adapters/agent-source/*``) nor the
integration adapters — reads a client/idempotency token today. The single
server-controlled chokepoint that sees BOTH the derived key and the tool input
is this hook, so injection lives here; the per-tool ``clientTokenParam`` is the
forwarding contract for a tool/target that supports it.
"""
from __future__ import annotations

import os
import sys

import pytest

_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from arbiter.workerWrapper import tool_idempotency_hook as hook_mod  # noqa: E402
from arbiter.workerWrapper.tool_idempotency_hook import (  # noqa: E402
    IdempotencyToolHook,
    _IdempotentToolWrapper,
)
from arbiter.workerWrapper.tool_idempotency import (  # noqa: E402
    build_client_token,
    build_key,
)


class _FakeEvent:
    def __init__(self, name, tool_input):
        self.tool_use = {"name": name, "input": tool_input, "toolUseId": "tu-1"}
        self.selected_tool = object()  # a stand-in inner tool


def _hook(**kw):
    return IdempotencyToolHook(
        org_id="orgA", execution_id="exec1", node_id="node1", **kw
    )


class TestClientTokenDerivation:
    def test_token_is_deterministic_and_org_scoped(self):
        pk_a, sk = build_key("orgA", "exec1", "node1", 0, "createTicket", {"s": 1})
        pk_b, _ = build_key("orgB", "exec1", "node1", 0, "createTicket", {"s": 1})
        # Deterministic: same key -> same token (so a retry dedupes end-to-end).
        assert build_client_token(pk_a, sk) == build_client_token(pk_a, sk)
        # Org-scoped: a different org's PK -> a different token (no cross-org
        # impersonation of another org's idempotency namespace).
        assert build_client_token(pk_a, sk) != build_client_token(pk_b, sk)


class TestClientTokenInjection:
    def test_token_injected_and_absent_from_args_hash(self):
        tool_input = {"subject": "hi"}
        event = _FakeEvent("createTicket", tool_input)
        hook = _hook(client_token_param_resolver=lambda _n: "Idempotency-Key")
        hook._on_before_tool_call(event)

        wrapper = event.selected_tool
        assert isinstance(wrapper, _IdempotentToolWrapper)
        # The token was injected into the tool input the inner tool will see.
        assert tool_input["Idempotency-Key"] == build_client_token(wrapper._pk, wrapper._sk)
        # The ledger key was derived from the ORIGINAL input (no token): the
        # wrapper's sk equals build_key on the token-free input, and DIFFERS
        # from a key that hashed the token — proving the token is not in the hash.
        _, sk_no_token = build_key("orgA", "exec1", "node1", 0, "createTicket", {"subject": "hi"})
        _, sk_with_token = build_key(
            "orgA", "exec1", "node1", 0, "createTicket",
            {"subject": "hi", "Idempotency-Key": tool_input["Idempotency-Key"]},
        )
        assert wrapper._sk == sk_no_token
        assert wrapper._sk != sk_with_token

    def test_model_supplied_token_is_overwritten(self):
        tool_input = {"subject": "hi", "Idempotency-Key": "MODEL-EVIL-cross-org"}
        event = _FakeEvent("createTicket", tool_input)
        hook = _hook(client_token_param_resolver=lambda _n: "Idempotency-Key")
        hook._on_before_tool_call(event)
        wrapper = event.selected_tool
        # The model's value is overwritten by the server-derived token.
        assert tool_input["Idempotency-Key"] != "MODEL-EVIL-cross-org"
        assert tool_input["Idempotency-Key"] == build_client_token(wrapper._pk, wrapper._sk)

    def test_no_injection_when_no_param_configured(self):
        tool_input = {"subject": "hi"}
        event = _FakeEvent("createTicket", tool_input)
        hook = _hook()  # no client_token_param_resolver -> passthrough disabled
        hook._on_before_tool_call(event)
        assert "Idempotency-Key" not in tool_input

    def test_per_tool_passthrough_only_for_configured_tools(self):
        # Adapter/tool 'httpCreate' supports a token; 'mcpCall' does not.
        supported = {"httpCreate": "Idempotency-Key"}
        hook = _hook(client_token_param_resolver=lambda name: supported.get(name))

        ev_http = _FakeEvent("httpCreate", {"a": 1})
        hook._on_before_tool_call(ev_http)
        assert "Idempotency-Key" in ev_http.tool_use["input"]

        ev_mcp = _FakeEvent("mcpCall", {"a": 1})
        hook._on_before_tool_call(ev_mcp)
        assert "Idempotency-Key" not in ev_mcp.tool_use["input"]

    def test_resolver_failure_fails_safe_no_injection(self):
        def boom(_name):
            raise RuntimeError("config lookup failed")

        tool_input = {"subject": "hi"}
        event = _FakeEvent("createTicket", tool_input)
        hook = _hook(client_token_param_resolver=boom)
        hook._on_before_tool_call(event)
        # A resolver failure must not inject a token and must not break the call.
        assert "Idempotency-Key" not in tool_input
        assert isinstance(event.selected_tool, _IdempotentToolWrapper)
