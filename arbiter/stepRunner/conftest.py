"""stepRunner-local pytest fixtures.

Problem this file solves
-------------------------

``executor._check_approval_gate`` calls
``executor._load_approval_governance_state()`` unconditionally on every
``invoke_node``. With the root ``arbiter/conftest.py``'s MagicMock boto3
stub in place and ``AUTHORITY_UNITS_TABLE`` leaked into the environment by
an unrelated test module (``seedConfig/__tests__/*`` sets it at collection
time via ``os.environ.setdefault`` and never tears it down), a real
governance-state read is triggered: ``hierarchy.load_governance_state`` ->
``_load_authority_units`` -> ``_scan_all`` against a MagicMock table whose
``LastEvaluatedKey`` is truthy forever. ``hierarchy._scan_all`` now has its
own defensive termination (see ``arbiter/governance/hierarchy.py``), but
every stepRunner test that doesn't care about governance state should
never reach that scan at all — it should get a cheap, deterministic
default.

Fix: autouse fixture that patches ``executor.load_governance_state`` to
return a shadow-mode state with ``effective_at=None`` by default (the
approval-gate wrapper, ``executor._load_approval_governance_state``, calls
this name internally). Tests that need specific enforcement semantics
(``test_approval_gate.py``) patch ``executor.load_governance_state``
themselves inside their own test body — that inner patch simply nests
inside this fixture's outer one and wins while active, so those tests
still exercise strict/shadow decisions exactly as authored.
"""
from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


@pytest.fixture(autouse=True)
def _default_approval_governance_state():
    """Patch ``executor.load_governance_state`` to a cheap shadow-mode
    default for every stepRunner test.

    ``executor._load_approval_governance_state()`` (the seam
    ``_check_approval_gate`` actually calls) is a thin wrapper whose body
    is exactly ``return load_governance_state()`` — patching the
    dependency here, not the wrapper, means any test that installs its
    OWN ``patch.object(executor, 'load_governance_state', ...)`` (e.g.
    ``test_approval_gate.py``) transparently overrides this default for
    the duration of its own ``with``/decorator scope: ``unittest.mock.patch``
    context managers nest, so the innermost (test-level) patch of the same
    attribute wins while active, and this fixture's patch resumes once the
    test's own context manager exits. A test that never touches
    ``load_governance_state`` (the overwhelming majority of stepRunner
    tests, which predate the approval gate) gets this fixture's cheap
    default and never reaches the real DynamoDB-backed governance scan.
    """
    import executor

    default_state = MagicMock(enforcement_mode='shadow', effective_at=None)
    with patch.object(executor, 'load_governance_state', return_value=default_state):
        yield

