"""Independent-checker probes for code_validation (PR-4 §2c).

Documents an accepted-but-should-be-rejected class found during review: the
``os.system`` / ``os.popen`` / ``os.exec*`` / ``os.fork`` / ``os.spawn*``
denial only fires on ATTRIBUTE calls (``os.system(...)``). Importing the same
function by name (``from os import system``), aliasing it, or star-importing
``os`` yields a bare ``Name`` call that the validator accepts. ``posix`` and
``_posixsubprocess`` (the C substrate of ``subprocess``) are likewise
importable. These are RED until code_validation closes the class.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from code_validation import GeneratedCodeRejected, validate_generated_code  # noqa: E402


@pytest.mark.parametrize("source", [
    "from os import system\nsystem('id')",
    "from os import popen as p\np('id')",
    "from os import execv\nexecv('/bin/sh', ['sh'])",
    "from os import fork\nfork()",
    "from os import spawnl",
    "from os import *\nsystem('id')",
    "from posix import system\nsystem('id')",
    "import _posixsubprocess",
])
def test_from_import_os_escape_is_rejected(source):
    with pytest.raises(GeneratedCodeRejected):
        validate_generated_code(source)


@pytest.mark.parametrize("source", [
    "import os\nx = os.environ.get('A')",
    "from os import environ\nx = environ.get('A')",
    "from os.path import join\njoin('a', 'b')",
])
def test_benign_os_usage_still_accepted(source):
    validate_generated_code(source)
