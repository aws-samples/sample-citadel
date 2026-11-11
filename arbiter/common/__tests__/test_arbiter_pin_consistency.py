"""Guard: pinned packages shared across arbiter requirement files must use the same version.

If Dependabot (or a human) bumps boto3 in arbiter/fabricator but misses
arbiter/supervisor, requirements-ci.txt will install both and pip will
resolve one winner — but the mismatch is a latent conflict.  This test
scans every arbiter/*/requirements.txt (plus arbiter/layers/common/) and
fails when a pinned package appears in more than one file with different
versions.

Only ``==`` pins are checked; range specifiers (``>=``, ``~=``) are ignored
because they are intentionally allowed to differ.
"""

from __future__ import annotations

import pathlib
import re
from collections import defaultdict

ARBITER = pathlib.Path(__file__).resolve().parent.parent.parent  # common/__tests__/ -> common/ -> arbiter/

# Matches lines like "boto3==1.43.126" — only exact pins.
_PIN_RE = re.compile(r"^([A-Za-z0-9_][A-Za-z0-9._-]*)==([^\s#]+)")


def _collect_pins() -> dict[str, dict[str, list[str]]]:
    """Return {package: {version: [file, ...]}} for all == pins."""
    pins: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))

    req_files: list[pathlib.Path] = []
    for child in sorted(ARBITER.iterdir()):
        if not child.is_dir():
            continue
        # Direct sub-dirs (activator/, fabricator/, …)
        req = child / "requirements.txt"
        if req.exists():
            req_files.append(req)
        # layers/common/ (two levels)
        for grandchild in sorted(child.iterdir()):
            if grandchild.is_dir():
                nested_req = grandchild / "requirements.txt"
                if nested_req.exists():
                    req_files.append(nested_req)

    for req in req_files:
        label = str(req.relative_to(ARBITER))
        for line in req.read_text().splitlines():
            line = line.strip()
            m = _PIN_RE.match(line)
            if m:
                pkg = m.group(1).lower()
                ver = m.group(2)
                pins[pkg][ver].append(label)

    return pins


def test_arbiter_pin_consistency():
    pins = _collect_pins()
    assert pins, "Expected at least one pinned package across arbiter requirements"

    mismatches: list[str] = []
    for pkg, versions in sorted(pins.items()):
        if len(versions) > 1:
            detail = "; ".join(f"{v} in {', '.join(fs)}" for v, fs in sorted(versions.items()))
            mismatches.append(f"  {pkg}: {detail}")

    assert not mismatches, (
        "Pinned packages have inconsistent versions across arbiter requirements files. "
        "Dependabot groups all arbiter directories in a single update — if you bump one "
        "file, bump them all.\n" + "\n".join(mismatches)
    )
