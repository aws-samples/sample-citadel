"""Regression test for the root ``conftest.py`` module-environment
isolation fix (finding: PR213 CI hang root cause).

Collection order within a directory is alphabetical, so this file
(``test_env_isolation_a.py``) is collected and its tests run before
``test_env_isolation_b.py``. This module sets ``CITADEL_LEAK_PROBE_TABLE``
at *import* time, mirroring how real table-name env vars (e.g.
``AUTHORITY_UNITS_TABLE``) are set by ``seedConfig/__tests__`` modules. The
isolation fixture in ``arbiter/conftest.py`` must preserve a module's own
import-time env additions for its own tests.
"""
from __future__ import annotations

import os

os.environ["CITADEL_LEAK_PROBE_TABLE"] = "leak-probe-table-a"


def test_probe_visible_in_its_own_module():
    """A module sees the env var it set at import time."""
    assert os.environ.get("CITADEL_LEAK_PROBE_TABLE") == "leak-probe-table-a"
