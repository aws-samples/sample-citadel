"""Consistency guard: workerWrapper/index.py's deferred-bundling ImportError
fallback for common.metrics_constants re-declares the same literals inline
(the worker Lambda bundle currently ships only arbiter/workerWrapper/, so a
missing common.metrics_constants import must not break dispatch). If the
shared module's values ever drift from this inline fallback, the two
producers would silently disagree on the dashboards contract. Pinned here so
an edit to either side trips this test.
"""
from common import metrics_constants as mc

import index


def test_worker_fallback_literals_match_shared_constants_module():
    assert index.METRIC_NAMESPACE == mc.METRIC_NAMESPACE
    assert index.METRIC_NODE_COLD_START == mc.METRIC_NODE_COLD_START
    assert index.UNIT_COUNT == mc.UNIT_COUNT
    assert index.DIMENSION_AGENT_ID == mc.DIMENSION_AGENT_ID
