"""CIT-030 test — ArbitrationDecision.REQUIRE_APPROVAL enum member.

Verifies the new enum value exists, serializes correctly, and is distinct
from all prior members.
"""
from __future__ import annotations

import os
import sys

_GOV_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
if _GOV_DIR not in sys.path:
    sys.path.insert(0, _GOV_DIR)

from governance.models import ArbitrationDecision


def test_require_approval_enum_exists():
    assert hasattr(ArbitrationDecision, 'REQUIRE_APPROVAL')
    assert ArbitrationDecision.REQUIRE_APPROVAL.value == 'require_approval'


def test_require_approval_is_distinct_from_existing():
    existing = {ArbitrationDecision.PERMIT, ArbitrationDecision.DENY,
                ArbitrationDecision.ESCALATE, ArbitrationDecision.HALT}
    assert ArbitrationDecision.REQUIRE_APPROVAL not in existing


def test_require_approval_round_trips_via_str():
    assert ArbitrationDecision('require_approval') is ArbitrationDecision.REQUIRE_APPROVAL
