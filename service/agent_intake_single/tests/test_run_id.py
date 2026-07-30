"""Tests for tools.run_id (container-local copy) — mint format/uniqueness,
mirroring arbiter/common/run_id.py's contract (Pass 1, decision f1cbd5ef).
"""
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

_RUN_ID_RE = re.compile(
    r"^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


class TestMintRunId:
    def test_produces_run_prefixed_uuid_format(self):
        import tools.run_id as run_id_mod

        value = run_id_mod.mint_run_id()
        assert _RUN_ID_RE.match(value)

    def test_produces_unique_values(self):
        import tools.run_id as run_id_mod

        values = {run_id_mod.mint_run_id() for _ in range(100)}
        assert len(values) == 100
