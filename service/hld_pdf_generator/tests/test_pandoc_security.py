"""Tests for HLD PDF generator security hardening (Finding H30).

Validates four defence layers against raw TeX/HTML injection:
  1. Input format disables raw_tex, raw_html, raw_attribute extensions
  2. --pdf-engine-opt=-no-shell-escape prevents \\write18 shell execution
  3. Lua filter strips RawBlock/RawInline nodes
  4. openin_any/openout_any env vars restrict TeX file access
"""
import os
import sys
import tempfile

import pytest

# Add parent dir so we can import the handler module
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lambda_handler import (
    PANDOC_INPUT_FORMAT,
    build_pandoc_command,
    build_pandoc_env,
    write_lua_filter,
)


# ---------- Layer 1: Input format extension flags ----------

class TestPandocInputFormat:
    """Verify the PANDOC_INPUT_FORMAT constant disables dangerous extensions."""

    def test_raw_tex_disabled(self):
        assert '-raw_tex' in PANDOC_INPUT_FORMAT

    def test_raw_html_disabled(self):
        assert '-raw_html' in PANDOC_INPUT_FORMAT

    def test_raw_attribute_disabled(self):
        assert '-raw_attribute' in PANDOC_INPUT_FORMAT

    def test_hard_line_breaks_preserved(self):
        assert '+hard_line_breaks' in PANDOC_INPUT_FORMAT

    def test_base_format_is_markdown(self):
        assert PANDOC_INPUT_FORMAT.startswith('markdown')


# ---------- Layer 2: Pandoc command argv ----------

class TestBuildPandocCommand:
    """Verify the pandoc argv includes all security flags."""

    @pytest.fixture()
    def cmd(self, tmp_path):
        md = str(tmp_path / 'input.md')
        pdf = str(tmp_path / 'output.pdf')
        lua = str(tmp_path / 'filter.lua')
        res = str(tmp_path)
        return build_pandoc_command(md, pdf, lua, res)

    def test_pdf_engine_is_xelatex(self, cmd):
        assert '--pdf-engine=xelatex' in cmd

    def test_no_shell_escape_flag(self, cmd):
        assert '--pdf-engine-opt=-no-shell-escape' in cmd

    def test_from_flag_uses_hardened_format(self, cmd):
        from_args = [a for a in cmd if a.startswith('--from=')]
        assert len(from_args) == 1
        assert from_args[0] == f'--from={PANDOC_INPUT_FORMAT}'

    def test_lua_filter_included(self, cmd, tmp_path):
        lua = str(tmp_path / 'filter.lua')
        assert f'--lua-filter={lua}' in cmd

    def test_resource_path_included(self, cmd, tmp_path):
        idx = cmd.index('--resource-path')
        assert cmd[idx + 1] == str(tmp_path)

    def test_first_arg_is_pandoc(self, cmd):
        assert cmd[0] == 'pandoc'


# ---------- Layer 3: Lua filter content ----------

class TestLuaFilter:
    """Verify the Lua filter strips raw TeX/HTML blocks and inlines."""

    @pytest.fixture()
    def lua_content(self, tmp_path):
        path = write_lua_filter(str(tmp_path))
        with open(path) as f:
            return f.read()

    def test_rawblock_function_exists(self, lua_content):
        assert 'function RawBlock(el)' in lua_content

    def test_rawinline_function_exists(self, lua_content):
        assert 'function RawInline(el)' in lua_content

    def test_strips_tex_format(self, lua_content):
        assert "el.format == 'tex'" in lua_content

    def test_strips_latex_format(self, lua_content):
        assert "el.format == 'latex'" in lua_content

    def test_strips_html_format(self, lua_content):
        assert "el.format == 'html'" in lua_content

    def test_header_pagebreak_preserved(self, lua_content):
        assert 'function Header(el)' in lua_content
        assert 'newpage' in lua_content

    def test_filter_file_written(self, tmp_path):
        path = write_lua_filter(str(tmp_path))
        assert os.path.exists(path)
        assert path.endswith('pagebreak.lua')


# ---------- Layer 4: Environment variables ----------

class TestBuildPandocEnv:
    """Verify the env restricts TeX file access."""

    @pytest.fixture()
    def env(self):
        return build_pandoc_env()

    def test_openin_any_paranoid(self, env):
        assert env.get('openin_any') == 'p'

    def test_openout_any_paranoid(self, env):
        assert env.get('openout_any') == 'p'

    def test_texmfvar_set(self, env):
        assert env.get('TEXMFVAR') == '/tmp/texmf-var'

    def test_inherits_existing_env(self, env):
        # Should contain at least PATH from parent environment
        assert 'PATH' in env
