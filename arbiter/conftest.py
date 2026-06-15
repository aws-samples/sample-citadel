"""Root conftest for arbiter tests.

Problem this file solves
------------------------

Several arbiter subdirectories (``activator/``, ``fabricator/``,
``seedConfig/``, ``stepRunner/``, ``supervisor/``, ``workerWrapper/``)
each ship an ``index.py``. The ``workerWrapper/governance.py`` module
shares a name with the ``arbiter/governance/`` package. Tests in those
dirs do bare imports such as ``from index import publish_fabrication_event``
which go through standard Python import machinery and cache under
``sys.modules['index']``. When pytest runs the whole suite, whichever
test file was collected last "wins" the cache slot, so tests in other
dirs that call ``patch('index.boto3')`` at runtime end up patching the
wrong module.

Fix strategy
------------

1. **Boto3 neutralisation** — several arbiter modules create AWS clients
   at module import time (``events.py``, ``agent_config.py`` etc.).
   Replace ``boto3.client`` / ``boto3.resource`` with MagicMock factories
   before any test module is imported, so imports don't touch the
   credential chain (which fails in CI / non-Midway dev envs).

2. **Per-test sys.modules rebinding** — during collection we snapshot,
   for each test file, which sibling module (e.g. ``fabricator/index.py``)
   its ``from index import X`` resolved to. Before each test *runs*, we
   restore ``sys.modules['index']`` to the snapshotted sibling so
   ``patch('index.foo')`` resolves correctly.

The snapshot-and-restore pattern is the only approach that keeps BOTH
(a) the pre-bound callables captured at test-file import time, and
(b) runtime ``patch(str)`` / ``import X`` calls pointing at the same
module object. Re-importing modules mid-session creates distinct copies,
breaking (a). Bare eviction without restore breaks (b).
"""
from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock

_ARBITER_ROOT = os.path.dirname(__file__)


# ---------------------------------------------------------------------------
# Boto3 stub — installed BEFORE any arbiter module is imported.
# ---------------------------------------------------------------------------
# Drop any active AWS profile. Don't set bogus credentials; we route
# every boto3 call through MagicMock.
os.environ.pop("AWS_PROFILE", None)
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

try:
    import boto3 as _boto3  # type: ignore

    def _stub_client(*_args, **_kwargs):  # noqa: ANN001
        return MagicMock(name="boto3.client.stub")

    def _stub_resource(*_args, **_kwargs):  # noqa: ANN001
        return MagicMock(name="boto3.resource.stub")

    _boto3.client = _stub_client  # type: ignore[assignment]
    _boto3.resource = _stub_resource  # type: ignore[assignment]
except ImportError:  # pragma: no cover — boto3 always present in arbiter
    pass


# ---------------------------------------------------------------------------
# Module-directory handling.
# ---------------------------------------------------------------------------
_MODULE_DIRS = [
    "fabricator",
    "supervisor",
    "workerWrapper",
    "seedConfig",
    "stepRunner",
    "activator",
]

# Seed sys.path once at conftest import so any bare ``from X import Y``
# fired at test-file import time resolves against one of the arbiter
# subdirs.
for _subdir in _MODULE_DIRS:
    _p = os.path.join(_ARBITER_ROOT, _subdir)
    if _p not in sys.path:
        sys.path.insert(0, _p)

# Names that collide across subdirs (``index``) or are shadowed by the
# ``arbiter/governance/`` package (``governance``).
_AMBIGUOUS_MODULE_NAMES = {
    # After the US-ARB-012a follow-up (#6) renamed
    # ``arbiter/workerWrapper/governance.py`` to
    # ``worker_governance.py``, the only remaining cross-subdir
    # basename collision in this tree is ``index.py`` (6 copies).
    "index",
}


def _subdir_for_path(path: str) -> str | None:
    """Return the arbiter/<subdir> that owns *path*, if any."""
    norm = os.path.normpath(path)
    for subdir in _MODULE_DIRS:
        marker = os.sep + subdir + os.sep
        if marker in norm:
            return subdir
    return None


def _reprioritise_sys_path(subdir: str) -> None:
    """Move ``arbiter/<subdir>`` to index 0 of sys.path."""
    target = os.path.join(_ARBITER_ROOT, subdir)
    while target in sys.path:
        sys.path.remove(target)
    sys.path.insert(0, target)


def _evict_ambiguous_modules() -> None:
    """Drop cached imports of ambiguous names from sys.modules."""
    for name in list(sys.modules):
        if name in _AMBIGUOUS_MODULE_NAMES:
            del sys.modules[name]


# Per-test-file snapshot: after a test file finishes importing, we
# record which module object is currently bound in sys.modules for each
# ambiguous name. Before that file's tests *run*, we restore those
# snapshots so runtime ``patch(str)`` resolves to the same module the
# test file captured callables from.
#
# Keys are absolute test-file paths. Values are dicts mapping ambiguous
# name -> module object (or None if the test file didn't import it).
_MODULE_SNAPSHOT: dict[str, dict[str, object]] = {}


# ---------------------------------------------------------------------------
# Pytest hooks.
# ---------------------------------------------------------------------------
def pytest_collectstart(collector):  # noqa: D401 — pytest hook name
    """Before a test FILE is imported for collection.

    Only act on ``pytest.Module`` collectors (test files). Evict the
    ambiguous names from ``sys.modules`` and prioritise the right
    subdir on ``sys.path`` so the upcoming ``from index import X``
    at the top of the test file resolves to the sibling module.
    """
    import pytest  # local import avoids circular import at conftest load

    if not isinstance(collector, pytest.Module):
        return
    path = getattr(collector, "path", None) or getattr(collector, "fspath", None)
    if path is None:
        return
    subdir = _subdir_for_path(str(path))
    if subdir is None:
        return
    _evict_ambiguous_modules()
    _reprioritise_sys_path(subdir)


def pytest_collectreport(report):  # noqa: D401 — pytest hook name
    """After a test FILE has been imported for collection.

    Snapshot ``sys.modules[<ambiguous>]`` now, while the cache still
    reflects what the just-collected test file bound. We'll restore
    these entries before this file's tests run.
    """
    # Only care about successful collection reports.
    if report.nodeid == "" or report.failed:
        return
    fspath = getattr(report, "fspath", None)
    if fspath is None:
        return
    # Normalise to an absolute path so the snapshot key matches the
    # lookup key pytest_runtest_setup uses (item.path is absolute).
    key = os.path.abspath(str(fspath))
    if _subdir_for_path(key) is None:
        return
    snap: dict[str, object] = {}
    for name in _AMBIGUOUS_MODULE_NAMES:
        snap[name] = sys.modules.get(name)
    _MODULE_SNAPSHOT[key] = snap


def pytest_runtest_setup(item):  # noqa: D401 — pytest hook name
    """Before each test *runs*, restore the sys.modules snapshot taken
    when its containing file was collected. This ensures any
    ``patch('index.X')`` in the test body resolves to the same
    ``index`` module the test file's top-level ``from index import X``
    captured.
    """
    path = getattr(item, "path", None) or getattr(item, "fspath", None)
    if path is None:
        return
    key = os.path.abspath(str(path))
    snap = _MODULE_SNAPSHOT.get(key)
    if snap is None:
        return
    for name, module in snap.items():
        if module is None:
            # The test file didn't import this name — remove any stray
            # cached entry so a fresh ``import name`` from within the
            # test would resolve via sys.path (which we also reset).
            sys.modules.pop(name, None)
        else:
            sys.modules[name] = module
    subdir = _subdir_for_path(key)
    if subdir is not None:
        _reprioritise_sys_path(subdir)
