"""Regression test for the root ``conftest.py`` module-environment
isolation fix (finding: PR213 CI hang root cause).

Collection order within a directory is alphabetical, so this file is
collected and run after ``test_env_isolation_a.py``, which sets
``CITADEL_LEAK_PROBE_TABLE`` at import time. This module must NOT see that
key: the isolation fixture resets ``os.environ`` to pristine (plus this
module's own import-time diff, which is empty) at the start of this
module's tests, so a leaked key from a sibling module cannot survive.
"""
from __future__ import annotations

import os


def test_probe_absent_in_later_module():
    """A later module never observes an earlier module's import-time env var."""
    assert "CITADEL_LEAK_PROBE_TABLE" not in os.environ
