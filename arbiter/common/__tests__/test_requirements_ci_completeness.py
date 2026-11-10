"""Guard: every arbiter/*/requirements.txt is referenced from requirements-ci.txt.

If a new Lambda directory appears under arbiter/ with its own requirements.txt,
CI must install it or test collection will fail with ModuleNotFoundError.  This
test enforces that the aggregate ``requirements-ci.txt`` file ``-r``s every such
file so the omission is caught at test time rather than in a CI failure.
"""

from __future__ import annotations

import pathlib

ARBITER = pathlib.Path(__file__).resolve().parent.parent.parent  # common/__tests__/ -> common/ -> arbiter/


def test_requirements_ci_completeness():
    ci_txt = ARBITER / "requirements-ci.txt"
    assert ci_txt.exists(), "arbiter/requirements-ci.txt is missing"

    ci_lines = ci_txt.read_text()

    # Collect every requirements.txt under arbiter/*/ (one level of sub-dirs).
    sub_reqs: list[pathlib.Path] = []
    for child in sorted(ARBITER.iterdir()):
        if not child.is_dir():
            continue
        req = child / "requirements.txt"
        if req.exists():
            sub_reqs.append(req)

    assert sub_reqs, "Expected at least one arbiter/*/requirements.txt"

    missing: list[str] = []
    for req in sub_reqs:
        # The -r line uses a path relative to arbiter/, e.g. "fabricator/requirements.txt"
        relative = str(req.relative_to(ARBITER))
        if relative not in ci_lines:
            missing.append(relative)

    assert not missing, (
        f"arbiter/requirements-ci.txt is missing -r entries for: {missing}. "
        "Add them so CI installs every Lambda's dependencies."
    )
