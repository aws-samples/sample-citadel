"""PR-4 §2c: write_job_file validates generated code content before any
write — malicious content is rejected and NO file is written.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import types
import pytest

# Same strands/strands_tools stubbing convention as test_write_job_file.py
_strands_mod = types.ModuleType("strands")
_strands_mod.Agent = type("Agent", (), {})
_strands_mod.tool = lambda fn: fn
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

from index import write_job_file  # type: ignore[import-untyped]
from code_validation import GeneratedCodeRejected


class TestWriteJobFileValidatesContent:
    def test_rejects_forbidden_import_no_file_written(self, tmp_path, monkeypatch):
        monkeypatch.setattr("index._JOB_DIR", str(tmp_path))
        with pytest.raises(GeneratedCodeRejected, match="forbidden import"):
            write_job_file("evil.py", "import subprocess\nsubprocess.run(['ls'])\n")
        assert not (tmp_path / "evil.py").exists()

    def test_rejects_os_system_no_file_written(self, tmp_path, monkeypatch):
        monkeypatch.setattr("index._JOB_DIR", str(tmp_path))
        with pytest.raises(GeneratedCodeRejected, match="forbidden call"):
            write_job_file("evil2.py", "import os\nos.system('rm -rf /')\n")
        assert not (tmp_path / "evil2.py").exists()

    def test_rejects_eval_no_file_written(self, tmp_path, monkeypatch):
        monkeypatch.setattr("index._JOB_DIR", str(tmp_path))
        with pytest.raises(GeneratedCodeRejected, match="forbidden call"):
            write_job_file("evil3.py", "eval(input())\n")
        assert not (tmp_path / "evil3.py").exists()

    def test_rejects_syntax_error_no_file_written(self, tmp_path, monkeypatch):
        monkeypatch.setattr("index._JOB_DIR", str(tmp_path))
        with pytest.raises(GeneratedCodeRejected, match="syntax error"):
            write_job_file("evil4.py", "def f(:\n  pass")
        assert not (tmp_path / "evil4.py").exists()

    def test_accepts_normal_boto3_tool_and_writes(self, tmp_path, monkeypatch):
        monkeypatch.setattr("index._JOB_DIR", str(tmp_path))
        content = (
            "import boto3\n"
            "import json\n\n"
            "def handler(event):\n"
            "    client = boto3.client('s3')\n"
            "    return json.dumps({'ok': True})\n"
        )
        result = write_job_file("good_tool.py", content)
        assert result == str(tmp_path / "good_tool.py")
        assert (tmp_path / "good_tool.py").read_text() == content

    def test_path_traversal_checked_before_validation_still_rejected(self, tmp_path, monkeypatch):
        """Path-traversal rejection and content validation are independent
        gates — a traversal attempt with otherwise-benign content is still
        rejected (by the pre-existing path check), confirming the new
        validation call didn't replace or bypass it."""
        monkeypatch.setattr("index._JOB_DIR", str(tmp_path))
        with pytest.raises(ValueError, match="Path traversal is not allowed"):
            write_job_file("../escape.py", "x = 1\n")
