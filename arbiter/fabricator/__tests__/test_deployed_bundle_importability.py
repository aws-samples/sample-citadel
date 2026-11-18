"""Deployed-layout importability guard for the fabricator Lambda bundle
(PR-4 §4, mirroring arbiter/workerWrapper/__tests__/test_deployed_bundle_importability.py).

Why this test exists
--------------------
The fabricator Lambda's CDK entry is the WHOLE ``arbiter/fabricator``
directory (``entry: path.join(ARBITER_ROOT, "fabricator")`` in
backend/lib/arbiter-stack.ts) — every top-level ``.py`` file in that
directory ships as a bundle-sibling import (no ``arbiter.`` prefix), and
the shared ``catalog`` / ``common`` / ``governance`` packages are staged
onto a separate layer at ``/opt/python`` (the same ``ArbiterCatalogLayer``
the worker uses). PR-4 adds THREE new bundle-sibling modules to this
directory — ``permission_deriver.py``, ``fence.py``, ``code_validation.py``
— each of which must resolve as a top-level import with ONLY the bundle
root + layer on ``sys.path``, exactly like every existing fabricator
sibling module (``tools_config.py``, ``deadline.py``, etc.).

Deployed layout modelled
------------------------
* bundle root (== Lambda task root, ``entry: arbiter/fabricator``): every
  top-level ``.py`` file in ``arbiter/fabricator/`` (excluding
  ``__tests__``/``__pycache__``/``.hypothesis``, matching
  ``PYTHON_ASSET_EXCLUDES`` in backend/lib/python-asset-excludes.ts).
* layer (``ArbiterCatalogLayer`` at ``/opt/python``): the ``catalog`` /
  ``common`` / ``governance`` packages — imported as top-level packages.

The subprocess ``sys.path`` is EXACTLY ``[bundle_root, layer_python]`` —
the repo root is never on it, so ``import arbiter`` is impossible,
mirroring the real Lambda.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys


_HERE = os.path.dirname(os.path.abspath(__file__))
_ARBITER_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))
_FABRICATOR_DIR = os.path.join(_ARBITER_ROOT, "fabricator")

# Exclude patterns matching PYTHON_ASSET_EXCLUDES (backend/lib/python-asset-excludes.ts):
# __pycache__, .hypothesis, __tests__, *.md are never part of the deployed
# bundle. templates/ is a non-.py data directory (prompt templates) — real
# CDK bundling would still copy it (it is not in PYTHON_ASSET_EXCLUDES), so
# it is included here too for fidelity, though it has no import surface.
_EXCLUDED_NAMES = {"__pycache__", ".hypothesis", "__tests__"}

# Shared packages the ArbiterCatalogLayer stages at /opt/python.
_LAYER_PACKAGES = ["common", "governance", "catalog"]

# The new PR-4 bundle-sibling modules that MUST resolve top-level.
_PR4_NEW_MODULES = ["permission_deriver.py", "fence.py", "code_validation.py"]


def _stage_deployed_layout(tmp_path, *, include_layer_packages=None):
    """Materialise a deployed-like layout under *tmp_path*.

    Returns ``(bundle_root, layer_python)``. ``include_layer_packages`` lets a
    negative-control caller omit a package to prove the guard bites.
    """
    include_layer_packages = (
        _LAYER_PACKAGES if include_layer_packages is None else include_layer_packages
    )
    bundle_root = os.path.join(tmp_path, "task")
    layer_python = os.path.join(tmp_path, "layer", "python")
    os.makedirs(bundle_root)
    os.makedirs(layer_python)

    for entry in os.listdir(_FABRICATOR_DIR):
        if entry in _EXCLUDED_NAMES or entry.endswith(".md"):
            continue
        src = os.path.join(_FABRICATOR_DIR, entry)
        dst = os.path.join(bundle_root, entry)
        if os.path.isdir(src):
            shutil.copytree(
                src, dst,
                ignore=shutil.ignore_patterns("__pycache__", "*.pyc", ".hypothesis"),
            )
        else:
            shutil.copy(src, dst)

    for pkg in include_layer_packages:
        shutil.copytree(
            os.path.join(_ARBITER_ROOT, pkg),
            os.path.join(layer_python, pkg),
            ignore=shutil.ignore_patterns("__tests__", "__pycache__", "*.pyc"),
        )
    return bundle_root, layer_python


def _run_import(bundle_root, layer_python, import_body):
    script = import_body + "\nprint('IMPORT_OK')\n"
    env = {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONPATH": os.pathsep.join([bundle_root, layer_python]),
    }
    return subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        env=env,
        cwd=bundle_root,
    )


class TestFabricatorDeployedBundleImportability:
    def test_new_pr4_modules_resolve_in_deployed_layout(self, tmp_path):
        """permission_deriver, fence, and code_validation must each resolve
        as top-level imports with ONLY the bundle root + layer on sys.path."""
        bundle_root, layer_python = _stage_deployed_layout(str(tmp_path))
        result = _run_import(
            bundle_root,
            layer_python,
            "import permission_deriver\n"
            "import fence\n"
            "import code_validation\n",
        )
        assert result.returncode == 0, (
            "deployed-layout import of new PR-4 modules FAILED:\n"
            f"stdout={result.stdout}\nstderr={result.stderr}"
        )
        assert "IMPORT_OK" in result.stdout

    def test_index_import_chain_resolves_in_deployed_layout(self, tmp_path):
        """index.py itself (which imports permission_deriver/fence/
        code_validation at module load) must resolve in the deployed
        layout — this is the end-to-end regression guard: a bundle
        wiring mistake in any ONE of the three new modules breaks the
        whole fabricator Lambda at cold start."""
        bundle_root, layer_python = _stage_deployed_layout(str(tmp_path))
        result = _run_import(bundle_root, layer_python, "import index\n")
        assert result.returncode == 0, (
            "deployed-layout import of fabricator index.py FAILED:\n"
            f"stdout={result.stdout}\nstderr={result.stderr}"
        )
        assert "IMPORT_OK" in result.stdout

    def test_arbiter_prefix_is_not_importable_in_deployed_layout(self, tmp_path):
        """Guard-the-guard: prove the deployed sandbox genuinely lacks an
        ``arbiter`` package, so a regression back to
        ``from arbiter.governance import ...`` would fail here rather than
        silently pass."""
        bundle_root, layer_python = _stage_deployed_layout(str(tmp_path))
        result = _run_import(bundle_root, layer_python, "import arbiter")
        assert result.returncode != 0
        assert "No module named 'arbiter'" in result.stderr

    def test_missing_layer_common_package_bites(self, tmp_path):
        """Negative control: if the layer regresses and stops staging the
        ``common`` package, importing index.py MUST fail — index.py imports
        the bundle-sibling ``transient_retry`` module eagerly, which itself
        eagerly imports ``common.failure_taxonomy``. This is the bundle-
        regression signal the test is here to raise.

        (``governance`` is NOT a valid negative control for this bundle:
        unlike the worker's hook chain, fabricator/index.py only reaches
        into ``catalog``/``governance`` LAZILY inside function bodies, e.g.
        ``from catalog.registry_client import ...`` inside
        store_agent_config_registry — so a bare ``import index`` with
        those two packages absent does not, and should not, fail.)"""
        bundle_root, layer_python = _stage_deployed_layout(
            str(tmp_path), include_layer_packages=["catalog", "governance"]
        )
        result = _run_import(bundle_root, layer_python, "import index\n")
        assert result.returncode != 0
        assert "common" in result.stderr
