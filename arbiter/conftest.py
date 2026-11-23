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

import pytest

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

# Make arbiter-root packages (e.g. ``common``, ``catalog``) importable during
# test collection regardless of import order. Appended (lowest priority) so it
# never shadows the per-subdir ``index`` resolution handled below.
if _ARBITER_ROOT not in sys.path:
    sys.path.append(_ARBITER_ROOT)

# Names that collide across subdirs (``index``, ``model_config_loader``)
# or are shadowed by the ``arbiter/governance/`` package (``governance``).
_AMBIGUOUS_MODULE_NAMES = {
    # After the US-ARB-012a follow-up (#6) renamed
    # ``arbiter/workerWrapper/governance.py`` to
    # ``worker_governance.py``, the cross-subdir basename collisions in
    # this tree are ``index.py`` (6 copies) and, from the configurable
    # model-selection feature, ``model_config_loader.py`` (2 copies:
    # fabricator/ and supervisor/).
    "index",
    "model_config_loader",
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
# Test-module environment isolation (finding: PR213 CI hang root cause).
# ---------------------------------------------------------------------------
# Several test modules set table-name env vars (e.g. ``AUTHORITY_UNITS_TABLE``)
# at *import* time via ``os.environ.setdefault(...)`` (see
# ``seedConfig/__tests__/test_index_properties.py``), because the module
# under test reads those vars when it is imported. ``os.environ`` is process
# -wide and outlives the importing module's test functions, so once module A
# has been collected, module B's collection/tests can observe A's table name
# even though B never asked for it. This is the PR213 CI hang's root cause:
# a module picked up another module's table env var and exercised a
# real-shaped pagination loop against a MagicMock standing in for that
# table, whose truthy ``LastEvaluatedKey`` never terminates.
#
# Fix, composed with the ambiguous-module-name hooks above rather than
# replacing them (both concerns share ``pytest_collectstart`` /
# ``pytest_collectreport`` / ``pytest_runtest_setup``, so their logic is
# merged into the SAME function bodies below — pytest only calls one
# ``pytest_collectstart`` per plugin/module, so a second same-named
# definition in this file would silently shadow the first rather than being
# called in addition to it):
#
# 1. Capture the pristine environment once, in ``pytest_configure``, before
#    collection starts.
# 2. During collection, snapshot the environment immediately before each
#    test module is imported, and again immediately after it finishes
#    importing; the difference is that module's own import-time env diff
#    (keys it added or changed).
# 3. An autouse, module-scoped fixture resets ``os.environ`` to
#    ``pristine + that module's own diff`` at the start of the module's
#    tests, and restores the pre-fixture environment afterwards. A module
#    therefore always sees exactly what pristine pytest startup had plus
#    whatever IT set at import time — never another module's leftovers.
_PRISTINE_ENVIRON: dict[str, str] = {}
_PRISTINE_CAPTURED = False

# Per-module import-time diffs. Keys are absolute test-file paths (matching
# the keys used by ``_MODULE_SNAPSHOT`` above). Values map an env var name
# to either its value (set or changed by that module's import) or ``None``
# (the module's import removed a key present in the pristine environment).
_ENV_DIFF: dict[str, dict[str, str | None]] = {}

# Snapshot of os.environ taken just before a module's import, keyed the
# same way. Consulted when that module finishes importing to compute its
# diff.
_PRE_IMPORT_ENV: dict[str, dict[str, str]] = {}

# Snapshot of os.environ taken by the autouse fixture just before it resets
# the environment for a module's tests, so teardown can restore whatever
# was actually present right before this module ran.
_FIXTURE_PRE_RESET_ENV: dict[str, dict[str, str]] = {}


def pytest_configure(config) -> None:  # noqa: D401 — pytest hook name, ARG001
    """Capture the pristine environment before any test module is imported."""
    global _PRISTINE_CAPTURED
    _PRISTINE_ENVIRON.clear()
    _PRISTINE_ENVIRON.update(os.environ)
    _PRISTINE_CAPTURED = True


def _diff_env(before: dict[str, str], after: dict[str, str]) -> dict[str, str | None]:
    """Return the changes ``after`` introduces relative to ``before``."""
    diff: dict[str, str | None] = {}
    for key, value in after.items():
        if before.get(key) != value:
            diff[key] = value
    for key in before:
        if key not in after:
            diff[key] = None
    return diff


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
    # Env-isolation: taken for every Module collector, independent of
    # the ambiguous-module-name subdir check below. Reset os.environ to
    # pristine BEFORE this module imports (collection runs ALL modules'
    # imports before any test executes, so without this reset a sibling
    # module's import-time env additions would still be present in
    # os.environ while THIS module imports, corrupting the diff computed
    # in pytest_collectreport below into blaming this module for a key a
    # predecessor set).
    if _PRISTINE_CAPTURED:
        os.environ.clear()
        os.environ.update(_PRISTINE_ENVIRON)
    _PRE_IMPORT_ENV[os.path.abspath(str(path))] = dict(os.environ)
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
    # Env-isolation diff: computed for every Module collector regardless
    # of the ambiguous-module-name subdir check below. Diffed against the
    # PRISTINE baseline, not this module's own (possibly already-leaked)
    # pre-import snapshot: if an earlier module already leaked a key this
    # module also sets to the SAME value, a diff against the pre-import
    # snapshot would see no change and wrongly conclude this module never
    # set it, so the isolation fixture would then strip it even though
    # this module legitimately depends on it being present.
    _PRE_IMPORT_ENV.pop(key, None)
    _ENV_DIFF[key] = _diff_env(_PRISTINE_ENVIRON, dict(os.environ))
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


@pytest.fixture(autouse=True, scope="module")
def _isolate_module_environment(request):  # noqa: ANN001
    """Reset ``os.environ`` to pristine + this module's own import diff.

    Keeps whatever the module itself set at import time (so its own tests
    still see e.g. ``AUTHORITY_UNITS_TABLE``) but removes anything a
    previously-collected module introduced, so leakage across modules (the
    PR213 CI hang's root cause) cannot happen. Restores the pre-reset
    environment when the module's tests finish, so this fixture is a
    no-op with respect to any session-scoped state set up outside module
    collection.
    """
    key = os.path.abspath(str(request.node.path))
    pre_reset = dict(os.environ)
    _FIXTURE_PRE_RESET_ENV[key] = pre_reset

    restored = dict(_PRISTINE_ENVIRON)
    diff = _ENV_DIFF.get(key, {})
    for env_key, env_value in diff.items():
        if env_value is None:
            restored.pop(env_key, None)
        else:
            restored[env_key] = env_value

    os.environ.clear()
    os.environ.update(restored)

    yield

    os.environ.clear()
    os.environ.update(_FIXTURE_PRE_RESET_ENV.pop(key, pre_reset))
