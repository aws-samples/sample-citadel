"""Deployed-layout importability guard for the worker agent_runner chain.

Why this test exists
--------------------
The first real idempotency smoke run failed with

    [agent_runner] WARN idempotency hook skipped — tool_idempotency_hook
    unavailable: No module named arbiter

— i.e. the whole fail-closed idempotency capability (and the governance/usage
siblings) was inert because ``tool_idempotency_hook`` / ``governed_tool_handler``
imported shared code via an ``arbiter.*`` prefix that exists in NEITHER the
deployed worker bundle NOR the ``ArbiterCatalogLayer``. Every other worker
test resolves those names via ``arbiter/conftest.py`` (which puts the repo /
arbiter roots on ``sys.path``), so they passed against the REPO layout while
the DEPLOYED layout was broken. This test closes that exact gap: it
reconstructs the deployed layout and imports the chain in a subprocess with
the repo root REMOVED from ``sys.path``, so an ``arbiter.*`` import (or a
missing bundled/layered module) fails here the way it failed in production.

Deployed layout modelled
------------------------
* bundle root  (== Lambda task root, ``entry: arbiter/workerWrapper``):
  ``agent_runner.py``, ``tool_idempotency_hook.py``, ``tool_idempotency.py``,
  ``governed_tool_handler.py``, ``worker_governance.py`` — imported as
  top-level modules.
* layer  (``ArbiterCatalogLayer`` at ``/opt/python``): the ``common`` /
  ``governance`` / ``catalog`` packages — imported as top-level packages.

The subprocess ``sys.path`` is EXACTLY ``[bundle_root, layer_python]`` (plus
the stdlib/site-packages the fresh interpreter adds) — the repo root is never
on it, so ``import arbiter`` is impossible, mirroring the real Lambda.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys


_HERE = os.path.dirname(os.path.abspath(__file__))
_ARBITER_ROOT = os.path.abspath(os.path.join(_HERE, "..", ".."))

# Bundle-root sibling modules the worker ships (entry: arbiter/workerWrapper).
_BUNDLE_MODULES = [
    "agent_runner.py",
    "tool_idempotency_hook.py",
    "tool_idempotency.py",
    "governance_tool_hook.py",
    "governed_tool_handler.py",
    "worker_governance.py",
]
# Shared packages the ArbiterCatalogLayer stages at /opt/python.
_LAYER_PACKAGES = ["common", "governance", "catalog"]


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

    wworker = os.path.join(_ARBITER_ROOT, "workerWrapper")
    for mod in _BUNDLE_MODULES:
        shutil.copy(os.path.join(wworker, mod), os.path.join(bundle_root, mod))

    for pkg in include_layer_packages:
        shutil.copytree(
            os.path.join(_ARBITER_ROOT, pkg),
            os.path.join(layer_python, pkg),
            ignore=shutil.ignore_patterns("__tests__", "__pycache__", "*.pyc"),
        )
    return bundle_root, layer_python


def _run_import(bundle_root, layer_python, import_body):
    """Run *import_body* in a fresh interpreter whose importable roots are the
    bundle root + layer python ONLY (via PYTHONPATH) — repo root deliberately
    absent, so ``import arbiter`` is impossible, exactly like the real Lambda.
    Using PYTHONPATH also mirrors the real mechanism index.py uses to hand the
    layer/task roots to the agent_runner subprocess."""
    script = import_body + "\nprint('IMPORT_OK')\n"
    # Clean env (only PATH) + an explicit PYTHONPATH of exactly the deployed
    # roots, so no inherited PYTHONPATH can smuggle the repo root back in.
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


class TestDeployedBundleImportability:
    def test_import_chain_resolves_in_deployed_layout(self, tmp_path):
        """The worker's agent_runner import chain must resolve with ONLY the
        bundle root + layer on sys.path (no arbiter package anywhere)."""
        bundle_root, layer_python = _stage_deployed_layout(str(tmp_path))
        result = _run_import(
            bundle_root,
            layer_python,
            "import agent_runner\n"
            "import tool_idempotency_hook\n"
            "import governed_tool_handler\n",
        )
        assert result.returncode == 0, (
            "deployed-layout import FAILED (bundle regression?):\n"
            f"stdout={result.stdout}\nstderr={result.stderr}"
        )
        assert "IMPORT_OK" in result.stdout

    def test_arbiter_prefix_is_not_importable_in_deployed_layout(self, tmp_path):
        """Guard-the-guard: prove the deployed sandbox genuinely lacks an
        ``arbiter`` package, so a regression back to ``from arbiter.governance
        import ...`` would fail here rather than silently pass."""
        bundle_root, layer_python = _stage_deployed_layout(str(tmp_path))
        result = _run_import(bundle_root, layer_python, "import arbiter")
        assert result.returncode != 0
        assert "No module named 'arbiter'" in result.stderr

    def test_missing_layer_governance_package_bites(self, tmp_path):
        """Negative control: if the layer regresses and stops staging the
        ``governance`` package, importing the hook chain MUST fail — this is
        the bundle-regression signal the test is here to raise."""
        bundle_root, layer_python = _stage_deployed_layout(
            str(tmp_path), include_layer_packages=["common", "catalog"]
        )
        result = _run_import(
            bundle_root, layer_python, "import tool_idempotency_hook"
        )
        assert result.returncode != 0
        assert "governance" in result.stderr or "No module named" in result.stderr
