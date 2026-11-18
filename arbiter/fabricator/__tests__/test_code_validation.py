"""Tests for code_validation.validate_generated_code (PR-4 §2c): static
AST-based validation of LLM-generated code before persistence.
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from hypothesis import given, strategies as st

from code_validation import (
    validate_generated_code,
    GeneratedCodeRejected,
    FORBIDDEN_MODULES,
)


class TestSyntaxErrors:
    def test_rejects_unparseable_source(self):
        with pytest.raises(GeneratedCodeRejected, match="syntax error"):
            validate_generated_code("def f(:\n  pass")

    def test_accepts_empty_source(self):
        validate_generated_code("")

    def test_accepts_valid_normal_tool(self):
        source = (
            "import boto3\n"
            "import json\n\n"
            "def handler(event):\n"
            "    client = boto3.client('s3')\n"
            "    return json.dumps({'ok': True})\n"
        )
        validate_generated_code(source)  # must not raise


class TestForbiddenImports:
    @pytest.mark.parametrize("module", sorted(FORBIDDEN_MODULES))
    def test_rejects_direct_import(self, module):
        with pytest.raises(GeneratedCodeRejected, match="forbidden import"):
            validate_generated_code(f"import {module}\n")

    @pytest.mark.parametrize("module", sorted(FORBIDDEN_MODULES))
    def test_rejects_from_import(self, module):
        with pytest.raises(GeneratedCodeRejected, match="forbidden import"):
            validate_generated_code(f"from {module} import something\n")

    def test_rejects_submodule_of_forbidden_root(self):
        with pytest.raises(GeneratedCodeRejected, match="forbidden import"):
            validate_generated_code("import subprocess.run\n")

    def test_accepts_safe_imports(self):
        source = "\n".join(
            f"import {m}" for m in
            ["boto3", "json", "base64", "datetime", "typing", "re", "math", "uuid", "hashlib", "logging"]
        )
        validate_generated_code(source)  # must not raise


class TestOsEscapeCalls:
    def test_rejects_os_system(self):
        with pytest.raises(GeneratedCodeRejected, match="forbidden call"):
            validate_generated_code("import os\nos.system('rm -rf /')\n")

    def test_rejects_os_popen(self):
        with pytest.raises(GeneratedCodeRejected, match="forbidden call"):
            validate_generated_code("import os\nos.popen('ls')\n")

    def test_rejects_os_exec_variants(self):
        with pytest.raises(GeneratedCodeRejected, match="forbidden call"):
            validate_generated_code("import os\nos.execv('/bin/sh', [])\n")

    def test_allows_os_path_and_environ(self):
        """The os module itself is not forbidden — only its process-escape
        surface — so os.path/os.environ usage is a false positive we must
        NOT reject."""
        source = (
            "import os\n"
            "p = os.path.join('/tmp', 'x')\n"
            "v = os.environ.get('FOO')\n"
        )
        validate_generated_code(source)  # must not raise


class TestDunderAndReflectionAbuse:
    def test_rejects_dunder_import_call(self):
        with pytest.raises(GeneratedCodeRejected, match="forbidden call"):
            validate_generated_code("__import__('os')\n")

    def test_rejects_eval(self):
        with pytest.raises(GeneratedCodeRejected, match="forbidden call"):
            validate_generated_code("eval('1+1')\n")

    def test_rejects_exec(self):
        with pytest.raises(GeneratedCodeRejected, match="forbidden call"):
            validate_generated_code("exec('x=1')\n")

    def test_rejects_compile(self):
        with pytest.raises(GeneratedCodeRejected, match="forbidden call"):
            validate_generated_code("compile('x=1', '<string>', 'exec')\n")

    def test_rejects_subclasses_attribute_access(self):
        with pytest.raises(GeneratedCodeRejected, match="forbidden attribute"):
            validate_generated_code("x = ().__class__.__subclasses__()\n")

    def test_rejects_builtins_attribute_access(self):
        with pytest.raises(GeneratedCodeRejected, match="forbidden attribute"):
            validate_generated_code("x = __builtins__\n")

    def test_rejects_globals_attribute_access(self):
        with pytest.raises(GeneratedCodeRejected, match="forbidden attribute"):
            validate_generated_code("def f():\n    return f.__globals__\n")

    def test_rejects_getattr_dunder_string(self):
        with pytest.raises(GeneratedCodeRejected, match="forbidden reflection"):
            validate_generated_code("getattr(object, '__subclasses__')\n")

    def test_rejects_setattr_dunder_string(self):
        with pytest.raises(GeneratedCodeRejected, match="forbidden reflection"):
            validate_generated_code("setattr(object, '__bases__', ())\n")

    def test_allows_normal_getattr_setattr(self):
        source = (
            "class C:\n"
            "    pass\n"
            "c = C()\n"
            "setattr(c, 'name', 'x')\n"
            "y = getattr(c, 'name')\n"
        )
        validate_generated_code(source)  # must not raise


# ---------------------------------------------------------------------------
# Property-based coverage (Hypothesis): random safe-module programs accepted,
# random denylist imports rejected.
# ---------------------------------------------------------------------------

_safe_modules = ["boto3", "json", "base64", "datetime", "typing", "re", "math", "uuid", "hashlib", "logging"]


class TestProperties:
    @given(module=st.sampled_from(_safe_modules))
    def test_random_safe_module_import_accepted(self, module):
        validate_generated_code(f"import {module}\n")

    @given(module=st.sampled_from(sorted(FORBIDDEN_MODULES)))
    def test_random_denylist_import_rejected(self, module):
        with pytest.raises(GeneratedCodeRejected):
            validate_generated_code(f"import {module}\n")

    @given(
        modules=st.lists(st.sampled_from(_safe_modules), min_size=0, max_size=5, unique=True),
    )
    def test_arbitrary_combinations_of_safe_imports_accepted(self, modules):
        source = "\n".join(f"import {m}" for m in modules)
        validate_generated_code(source)
