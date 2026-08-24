"""Proves the marshal_ddb_item import boundary in tool_execution_ledger.py
fails LOUD, not soft.

A prior version silently degraded to an identity no-op on ImportError,
defeating the "a float can never silently reach DynamoDB" guarantee. This
test reloads the module with ``common.ddb_marshalling`` import blocked and
asserts the ImportError propagates out of module import — there must be no
fallback shim left standing that would let module load (and therefore
``marshal_ddb_item``) silently succeed with a pass-through implementation.
"""
from __future__ import annotations

import builtins
import importlib
import os
import sys

import pytest

_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "..")
)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

MODULE_NAME = "arbiter.governance.tool_execution_ledger"


def test_blocked_marshalling_import_raises_not_silently_noops(monkeypatch):
    """With common.ddb_marshalling unimportable, importing
    tool_execution_ledger must raise ImportError — it must NOT load
    successfully with marshal_ddb_item silently downgraded to an identity
    pass-through."""
    real_import = builtins.__import__

    def _blocking_import(name, *args, **kwargs):
        if name == "common.ddb_marshalling" or name.startswith("common.ddb_marshalling."):
            raise ImportError("simulated: marshalling boundary unavailable")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", _blocking_import)

    sys.modules.pop(MODULE_NAME, None)
    try:
        with pytest.raises(ImportError, match="simulated: marshalling boundary unavailable"):
            importlib.import_module(MODULE_NAME)
    finally:
        # Restore the real __import__ BEFORE reloading — monkeypatch's own
        # teardown runs after this function returns, so without this the
        # reload below would still be blocked and clobber module state.
        monkeypatch.setattr(builtins, "__import__", real_import)
        sys.modules.pop(MODULE_NAME, None)
        importlib.import_module(MODULE_NAME)


def test_marshal_ddb_item_is_the_real_helper_not_an_identity_stub():
    """Sanity check on the happy path: the imported symbol is the real
    common.ddb_marshalling.marshal_ddb_item (which rejects non-dict input),
    not a permissive identity no-op that would accept anything unchanged."""
    sys.modules.pop(MODULE_NAME, None)
    ledger = importlib.import_module(MODULE_NAME)

    with pytest.raises(TypeError):
        ledger.marshal_ddb_item("not-a-dict")  # identity stub would return this unchanged
