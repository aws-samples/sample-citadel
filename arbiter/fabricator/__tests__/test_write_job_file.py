"""Tests for the write_job_file confined-write tool."""

import os
import sys
import pathlib
import pytest

# Make the fabricator package importable without installed strands
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Provide lightweight stubs so `from strands import Agent, tool, models`
# and `from strands_tools import ...` succeed at import time without the
# real packages.  The root conftest.py already stubs boto3 but not strands.
import types

_strands_mod = types.ModuleType("strands")
_strands_mod.Agent = type("Agent", (), {})
_strands_mod.tool = lambda fn: fn  # identity decorator
_strands_mod_models = types.ModuleType("strands.models")
_strands_mod_models.BedrockModel = type("BedrockModel", (), {})
_strands_mod.models = _strands_mod_models

_strands_tools_mod = types.ModuleType("strands_tools")
_strands_tools_mod.file_write = lambda *a, **kw: None
_strands_tools_mod.http_request = lambda *a, **kw: None
_strands_tools_mod.shell = lambda *a, **kw: None
_strands_tools_mod.calculator = lambda *a, **kw: None

sys.modules.setdefault("strands", _strands_mod)
sys.modules.setdefault("strands.models", _strands_mod_models)
sys.modules.setdefault("strands_tools", _strands_tools_mod)

# Now import the tool from the fabricator module.  We cannot import the
# entire index (it touches boto3 clients at module level), so we extract
# write_job_file by parsing/exec'ing its definition in isolation.
#
# Alternatively, since write_job_file is a top-level @tool function we
# can import it via a targeted exec of just its source.

from index import write_job_file  # type: ignore[import-untyped]


class TestWriteJobFile:
    """Unit tests for the confined write_job_file tool."""

    def test_writes_file_to_tmp(self, tmp_path, monkeypatch):
        """A simple filename writes to /tmp/<name>."""
        job_dir = str(tmp_path)
        monkeypatch.setattr("index._JOB_DIR", job_dir)
        result = write_job_file("hello.py", "print('hi')")
        assert result == str(tmp_path / "hello.py")
        assert (tmp_path / "hello.py").read_text() == "print('hi')"

    def test_rejects_absolute_path(self, tmp_path, monkeypatch):
        monkeypatch.setattr("index._JOB_DIR", str(tmp_path))
        with pytest.raises(ValueError, match="Absolute paths are not allowed"):
            write_job_file("/etc/passwd", "bad")

    def test_rejects_traversal_dotdot(self, tmp_path, monkeypatch):
        monkeypatch.setattr("index._JOB_DIR", str(tmp_path))
        with pytest.raises(ValueError, match="Path traversal is not allowed"):
            write_job_file("../escape.py", "bad")

    def test_rejects_traversal_nested(self, tmp_path, monkeypatch):
        monkeypatch.setattr("index._JOB_DIR", str(tmp_path))
        with pytest.raises(ValueError, match="Path traversal is not allowed"):
            write_job_file("foo/../../escape.py", "bad")

    def test_rejects_empty_filename(self, tmp_path, monkeypatch):
        monkeypatch.setattr("index._JOB_DIR", str(tmp_path))
        with pytest.raises(ValueError, match="non-empty string"):
            write_job_file("", "bad")

    def test_allows_subdirectory(self, tmp_path, monkeypatch):
        """Subdirectories within the job dir are allowed."""
        monkeypatch.setattr("index._JOB_DIR", str(tmp_path))
        result = write_job_file("sub/tool.py", "code")
        assert result == str(tmp_path / "sub" / "tool.py")
        assert (tmp_path / "sub" / "tool.py").read_text() == "code"

    def test_rejects_backslash_absolute(self, tmp_path, monkeypatch):
        monkeypatch.setattr("index._JOB_DIR", str(tmp_path))
        with pytest.raises(ValueError, match="Absolute paths are not allowed"):
            write_job_file("\\etc\\passwd", "bad")

    def test_returns_resolved_path(self, tmp_path, monkeypatch):
        monkeypatch.setattr("index._JOB_DIR", str(tmp_path))
        result = write_job_file("my_tool.py", "x = 1")
        expected = str((tmp_path / "my_tool.py").resolve())
        assert result == expected
