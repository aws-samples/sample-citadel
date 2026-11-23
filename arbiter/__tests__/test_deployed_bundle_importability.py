"""Deployed-layout importability guard for every Lambda bundle that mounts
the shared ``ArbiterCatalogLayer`` (backend/lib/arbiter-stack.ts).

Why this test exists
---------------------
``arbiter/workerWrapper/__tests__/test_deployed_bundle_importability.py``
proved only the worker/``agent_runner`` chain imports from the deployed
layout (bundle root + ``/opt/python`` layer dir, repo root absent). That
test closed a real production gap: ``tool_idempotency_hook`` /
``governed_tool_handler`` imported shared code via an ``arbiter.*`` prefix
that exists in NEITHER the deployed bundle NOR the layer, so the whole
idempotency capability was inert in production while every unit test
passed against the repo layout (where ``arbiter/conftest.py`` puts the
repo root on ``sys.path``).

Every OTHER Lambda that mounts the same ``catalogLayer`` is exposed to the
identical risk class: a handler module that imports a sibling module or a
layer package by an ``arbiter.*``-prefixed path (or any path that only
resolves because the repo root happens to be on ``sys.path`` during
collection) would be invisible to the existing per-bundle unit tests, which
all import through ``arbiter/conftest.py``'s repo-rooted ``sys.path``
entries. This file parametrises the same deployed-layout reconstruction
over every bundle enumerated from ``backend/lib/arbiter-stack.ts``'s
``catalogLayer`` consumers, so a regression in any one of them fails here
instead of silently reaching production.

Bundles covered (enumerated from arbiter-stack.ts ``layers: [catalogLayer]``)
-------------------------------------------------------------------------------
* ``supervisor``       — entry: ``ARBITER_ROOT`` (widened), index:
  ``supervisor/index.py``. Bundle root therefore contains ``supervisor/``,
  ``governance/``, and ``common/`` as siblings (assetExcludes strips
  fabricator/stepRunner/workerWrapper/activator/seedConfig/catalog), so the
  handler module path inside the bundle is ``supervisor/index.py``, not a
  bundle-root-level ``index.py``.
* ``fabricator``        — entry: ``arbiter/fabricator``, handler module
  ``index.py`` at the bundle root.
* ``seedConfig``        — entry: ``arbiter/seedConfig`` (``lambda.Code.fromAsset``,
  not ``PythonFunction``), handler module ``index.py`` at the bundle root.
* ``activator``         — entry: ``arbiter/activator``, handler module
  ``index.py`` at the bundle root.
* ``eval_judge``        — entry: ``arbiter/eval_judge``, handler module
  ``index.py`` at the bundle root.
* ``stepRunner`` (executor) — entry: ``arbiter/stepRunner`` (``lambda.Code.fromAsset``),
  handler module ``index.py`` at the bundle root (imports ``executor``
  as a bundle-root sibling).
* ``stepRunner`` (timeout watchdog) — same bundle asset as above, different
  handler module (``timeout_watchdog.py``) in the SAME bundle root.
* ``workerWrapper``     — entry: ``arbiter/workerWrapper``, handler module
  ``index.py`` (NOT ``agent_runner.py``/``lambda_handler.py`` — this is the
  Lambda's actual top-level handler, which the original worker-only test
  predates and never exercised; it is additive coverage here, not a
  duplicate of the agent_runner-chain assertions that file keeps).

Deployed layout modelled
-------------------------
* bundle root — exactly the sibling files/dirs ``entry`` stages (per
  bundle, enumerated below), imported as top-level modules/packages.
* layer (``ArbiterCatalogLayer`` at ``/opt/python``) — the ``common`` /
  ``governance`` / ``catalog`` packages, imported as top-level packages.

The subprocess ``sys.path`` is EXACTLY ``[bundle_root, layer_python]`` — the
repo root is never on it, so ``import arbiter`` (or any ``arbiter.*``
import) is impossible, mirroring the real Lambda.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys

import pytest


_HERE = os.path.dirname(os.path.abspath(__file__))
_ARBITER_ROOT = os.path.abspath(os.path.join(_HERE, ".."))

# Shared packages the ArbiterCatalogLayer stages at /opt/python for every
# consumer (arbiter/layers/common/requirements.txt mirrors this set of
# arbiter-root packages, not pip packages, into the layer at synth time via
# the catalogLayer LayerVersion's own bundling command — see arbiter-stack.ts
# around the ArbiterCatalogLayer definition).
_LAYER_PACKAGES = ["common", "governance", "catalog"]


def _copy_bundle_dir(src_dir, bundle_root, *, subdir=None):
    """Copy every top-level .py sibling (and listed subpackage dirs) from
    *src_dir* into *bundle_root*, mirroring what ``entry`` stages for a
    bundle whose asset root IS that directory (fabricator/seedConfig/
    activator/eval_judge/stepRunner/workerWrapper — everything except the
    widened supervisor entry)."""
    dest = os.path.join(bundle_root, subdir) if subdir else bundle_root
    os.makedirs(dest, exist_ok=True)
    for name in os.listdir(src_dir):
        if name in ("__tests__", "__pycache__", "conftest.py") or name.endswith(
            (".pyc", ".md", ".txt")
        ):
            continue
        src = os.path.join(src_dir, name)
        dst = os.path.join(dest, name)
        if os.path.isdir(src):
            shutil.copytree(
                src, dst, ignore=shutil.ignore_patterns("__tests__", "__pycache__", "*.pyc")
            )
        else:
            shutil.copy(src, dst)


def _stage_layer(tmp_path, *, include_layer_packages=None):
    include_layer_packages = (
        _LAYER_PACKAGES if include_layer_packages is None else include_layer_packages
    )
    layer_python = os.path.join(tmp_path, "layer", "python")
    os.makedirs(layer_python)
    for pkg in include_layer_packages:
        shutil.copytree(
            os.path.join(_ARBITER_ROOT, pkg),
            os.path.join(layer_python, pkg),
            ignore=shutil.ignore_patterns("__tests__", "__pycache__", "*.pyc"),
        )
    return layer_python


def _stage_simple_bundle(tmp_path, subdir_name):
    """Bundles whose ``entry`` is exactly ``arbiter/<subdir_name>`` — the
    bundle root IS that directory's sibling .py files, flattened (matching
    CDK's PythonFunction/Code.fromAsset, which stage the asset dir's
    CONTENTS at the task root, not the dir itself)."""
    bundle_root = os.path.join(tmp_path, "task")
    os.makedirs(bundle_root)
    _copy_bundle_dir(os.path.join(_ARBITER_ROOT, subdir_name), bundle_root)
    layer_python = _stage_layer(tmp_path)
    return bundle_root, layer_python


def _stage_supervisor_bundle(tmp_path):
    """supervisor's entry is the WIDENED ``ARBITER_ROOT`` with index
    ``supervisor/index.py`` — the bundle root therefore contains
    ``supervisor/``, ``governance/``, and ``common/`` as real subdirectories
    (assetExcludes strips fabricator/stepRunner/workerWrapper/activator/
    seedConfig/catalog from the asset, but governance/common stay IN THE
    BUNDLE as well as being layered — PythonFunction bundles whatever
    ``entry`` contains after excludes, independent of what the layer
    separately provides)."""
    bundle_root = os.path.join(tmp_path, "task")
    os.makedirs(bundle_root)
    _copy_bundle_dir(
        os.path.join(_ARBITER_ROOT, "supervisor"), bundle_root, subdir="supervisor"
    )
    for pkg in ("governance", "common"):
        shutil.copytree(
            os.path.join(_ARBITER_ROOT, pkg),
            os.path.join(bundle_root, pkg),
            ignore=shutil.ignore_patterns("__tests__", "__pycache__", "*.pyc"),
        )
    layer_python = _stage_layer(tmp_path)
    return bundle_root, layer_python


def _run_import(bundle_root, layer_python, import_body, *, cwd=None):
    """Run *import_body* in a fresh interpreter whose importable roots are
    the bundle root + layer python ONLY (via PYTHONPATH) — repo root
    deliberately absent, so ``import arbiter`` is impossible, exactly like
    the real Lambda. Using PYTHONPATH also mirrors the real mechanism
    index.py uses to hand the layer/task roots to a subprocess."""
    script = import_body + "\nprint('IMPORT_OK')\n"
    env = {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONPATH": os.pathsep.join([bundle_root, layer_python]),
        # The real Lambda runtime always sets AWS_REGION/AWS_DEFAULT_REGION
        # before any handler code runs; some modules (events.py) construct a
        # boto3 client at import time, which raises NoRegionError without
        # this. Omitting it would be a harness artifact, not a fact about
        # the deployed layout, and would make this test fail for reasons
        # unrelated to import-path resolution (the thing it exists to check).
        "AWS_DEFAULT_REGION": "us-east-1",
    }
    return subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        env=env,
        cwd=cwd or bundle_root,
    )


# ---------------------------------------------------------------------------
# Per-bundle case definitions.
#
# Each case is (case_id, stage_fn, import_body). ``import_body`` imports the
# handler module exactly the way the Lambda runtime does (top-level module
# import by the dotted path CDK's ``handler``/``index`` props resolve to),
# plus, where the handler lazily imports a layer package inside a function
# body (seedConfig -> catalog.registry_client, activator ->
# common.tenant_guard), an explicit import of that lazy target too — a bare
# ``import index`` would NOT exercise a deferred import and would miss
# exactly the class of regression this test exists to catch.
# ---------------------------------------------------------------------------

_SUPERVISOR_XFAIL_REASON = (
    "GENUINE bundle regression, not a test-harness gap: supervisor/index.py "
    "does `from approval_requests import build_approval_request` (called at "
    "line ~1221, not dead code) expecting a bundle-root-level "
    "`approval_requests` module, but approval_requests.py physically lives "
    "at arbiter/stepRunner/approval_requests.py, and `stepRunner` is "
    "explicitly listed in the supervisor Lambda's assetExcludes in "
    "backend/lib/arbiter-stack.ts (entry: ARBITER_ROOT, index: "
    "'supervisor/index.py'), so the deployed bundle does not contain it. "
    "Exact failure: ModuleNotFoundError: No module named "
    "'approval_requests'. Every repo-layout unit test for supervisor "
    "passes because arbiter/conftest.py puts arbiter/stepRunner on "
    "sys.path, masking this at test time. The deployed supervisor Lambda "
    "will crash at import time (cold start) until approval_requests.py is "
    "either copied into supervisor/'s bundle input or the "
    "assetExcludes/import path is fixed."
)

_CASES = [
    (
        "supervisor",
        _stage_supervisor_bundle,
        "import supervisor.index\n"
        "import common.region\n"
        "import common.usage\n"
        "import common.metrics_constants\n"
        "import common.tracing\n"
        "import governance\n",
    ),
    (
        "fabricator",
        lambda tmp_path: _stage_simple_bundle(tmp_path, "fabricator"),
        "import index\n"
        "import common.region\n",
    ),
    (
        "seedConfig",
        lambda tmp_path: _stage_simple_bundle(tmp_path, "seedConfig"),
        "import index\n"
        # Lazy import inside index.py (catalog layer may be unavailable at
        # runtime, but the import ITSELF must resolve from the layer here).
        "import catalog.registry_client\n",
    ),
    (
        "activator",
        lambda tmp_path: _stage_simple_bundle(tmp_path, "activator"),
        "import index\n"
        # Lazy import inside index.py's org-scoping path.
        "import common.tenant_guard\n",
    ),
    (
        "eval_judge",
        lambda tmp_path: _stage_simple_bundle(tmp_path, "eval_judge"),
        "import index\n"
        "import common.model_resolver\n"
        "import common.model_types\n"
        "import common.model_mapping\n"
        "import common.region\n",
    ),
    (
        "stepRunner-executor",
        lambda tmp_path: _stage_simple_bundle(tmp_path, "stepRunner"),
        "import index\n"
        "import executor\n"
        "import common.workflow_contract\n"
        "import common.tracing\n",
    ),
    (
        "stepRunner-timeout_watchdog",
        lambda tmp_path: _stage_simple_bundle(tmp_path, "stepRunner"),
        "import timeout_watchdog\n"
        "import events\n"
        "import executor\n"
        "import dag\n"
        "import common.tracing\n",
    ),
    (
        "workerWrapper-index",
        lambda tmp_path: _stage_simple_bundle(tmp_path, "workerWrapper"),
        "import index\n"
        # agent_runner.py is wrapped in try/except ImportError inside
        # index.py (line ~316), and tool_idempotency_hook/
        # governed_tool_handler/credential_guard are only imported lazily
        # inside function bodies — a bare `import index` would NOT exercise
        # any of them, missing exactly the arbiter.*-prefix regression class
        # (idempotency hook importing shared code via a path absent from
        # the deployed layout) this test suite exists to catch. Import the
        # full chain explicitly so the guard is not silently narrowed.
        "import agent_runner\n"
        "import tool_idempotency_hook\n"
        "import governed_tool_handler\n"
        "import credential_guard\n",
    ),
]

_CASE_IDS = [c[0] for c in _CASES]

# Importability cases are identical to _CASES except the supervisor entry is
# wrapped in pytest.param(..., marks=xfail(strict=True)) — ONLY for the
# import-resolution test, which is the one that actually hits the
# approval_requests gap. The guard-the-guard test below (which only ever
# imports the literal name "arbiter" and must always fail with
# ModuleNotFoundError regardless of the approval_requests bug) reuses the
# unmarked _CASES so it is not accidentally xfailed too.
_IMPORTABILITY_CASES = [
    pytest.param(*_CASES[0], marks=pytest.mark.xfail(strict=True, reason=_SUPERVISOR_XFAIL_REASON)),
    *_CASES[1:],
]


@pytest.mark.parametrize("case_id,stage_fn,import_body", _IMPORTABILITY_CASES, ids=_CASE_IDS)
def test_bundle_imports_in_deployed_layout(case_id, stage_fn, import_body, tmp_path):
    """Every catalogLayer-consuming bundle's handler module (+ any layer
    package it imports, including lazily inside a function body) must
    resolve with ONLY the bundle root + layer on sys.path."""
    bundle_root, layer_python = stage_fn(str(tmp_path))
    result = _run_import(bundle_root, layer_python, import_body)
    assert result.returncode == 0, (
        f"[{case_id}] deployed-layout import FAILED (bundle regression?):\n"
        f"stdout={result.stdout}\nstderr={result.stderr}"
    )
    assert "IMPORT_OK" in result.stdout


@pytest.mark.parametrize("case_id,stage_fn,import_body", _CASES, ids=_CASE_IDS)
def test_arbiter_prefix_is_not_importable_in_deployed_layout(
    case_id, stage_fn, import_body, tmp_path
):
    """Guard-the-guard: every staged bundle genuinely lacks an ``arbiter``
    package, so a regression back to an ``arbiter.*``-prefixed import would
    fail here rather than silently passing because the repo root leaked
    onto sys.path."""
    bundle_root, layer_python = stage_fn(str(tmp_path))
    result = _run_import(bundle_root, layer_python, "import arbiter")
    assert result.returncode != 0, f"[{case_id}] 'import arbiter' unexpectedly succeeded"
    assert "No module named 'arbiter'" in result.stderr
