"""Deployed-layout checks specific to the worker bundle's layer-provided
pip packages (boto3 / aws_xray_sdk) — NOT covered by the generic
cross-bundle importability test.

Why this file still exists
---------------------------
``arbiter/__tests__/test_deployed_bundle_importability.py`` now covers the
generic "does the handler module chain import from the deployed bundle
root + /opt/python layer" question for EVERY catalogLayer consumer
(including workerWrapper), closing the original gap this file was written
for (``tool_idempotency_hook`` / ``governed_tool_handler`` importing via an
``arbiter.*`` prefix that doesn't exist in the deployed layout).

What remains here is strictly the worker-specific pip-package-resolution
behavior that the generic test does not exercise: after
``workerWrapper/requirements.txt`` dropped its explicit boto3/aws-xray-sdk
pins (they are provided solely by ``arbiter/layers/common/requirements.txt``
via the shared ``ArbiterCatalogLayer``), these two tests prove (a) the
packages resolve from the LAYER directory, not the bundle root, when
actually pip-installed into a staged layer, and (b) removing the
``governance`` package from the layer makes the hook chain's import fail —
the bundle-regression signal this file was built to detect never applied
to a package-resolution-source question, so it stays local here rather
than being generalised into the cross-bundle file (which only imports
already-installed site-packages, never runs ``pip install``).
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
    "constitution_gate.py",
    "governed_tool_handler.py",
    "worker_governance.py",
    "credential_guard.py",
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
    def test_layer_provided_packages_resolve_from_layer_not_bundle(self, tmp_path):
        """boto3 and aws_xray_sdk must resolve from the layer (/opt/python),
        NOT from the bundle root.  After removing the explicit pins from
        workerWrapper/requirements.txt, these packages are provided solely by
        the common layer (arbiter/layers/common/requirements.txt).  This test
        pip-installs the layer requirements into the staged layer path and
        asserts the two packages import successfully and resolve from the
        layer directory — and that they are NOT present in the bundle root."""
        bundle_root, layer_python = _stage_deployed_layout(str(tmp_path))

        # Install layer requirements (boto3, aws-xray-sdk) into the layer dir.
        layer_reqs = os.path.join(_ARBITER_ROOT, "layers", "common", "requirements.txt")
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "-q",
             "--target", layer_python, "-r", layer_reqs],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        result = _run_import(
            bundle_root,
            layer_python,
            "import boto3, aws_xray_sdk\n"
            "import os, pathlib\n"
            f"layer = '{layer_python}'\n"
            f"bundle = '{bundle_root}'\n"
            "b3 = pathlib.Path(boto3.__file__).resolve()\n"
            "xr = pathlib.Path(aws_xray_sdk.__file__).resolve()\n"
            "assert str(b3).startswith(layer), "
            "f'boto3 resolved from {b3}, expected under {layer}'\n"
            "assert str(xr).startswith(layer), "
            "f'aws_xray_sdk resolved from {xr}, expected under {layer}'\n"
            "assert not os.path.exists(os.path.join(bundle, 'boto3')), "
            "'boto3 must NOT be in the bundle root'\n"
            "assert not os.path.exists(os.path.join(bundle, 'aws_xray_sdk')), "
            "'aws_xray_sdk must NOT be in the bundle root'\n",
        )
        assert result.returncode == 0, (
            "layer-provided packages did NOT resolve from the layer:\n"
            f"stdout={result.stdout}\nstderr={result.stderr}"
        )
        assert "IMPORT_OK" in result.stdout

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
