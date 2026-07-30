"""Literal-value pin test for the new UnstampedDispatch WARN metric name
(Pass 1, decision f1cbd5ef — runtime backstop layer). Pinned per the
project's "do NOT retype metric names" lesson: this constant is imported
everywhere the metric is emitted, never hand-typed as a string literal.
"""
from common import metrics_constants as mc


def test_unstamped_dispatch_metric_name_is_pinned():
    assert mc.METRIC_UNSTAMPED_DISPATCH == 'UnstampedDispatch'


def test_shares_existing_namespace_and_count_unit_convention():
    assert mc.METRIC_NAMESPACE == 'Citadel/Workflows'
    assert mc.UNIT_COUNT == 'Count'
