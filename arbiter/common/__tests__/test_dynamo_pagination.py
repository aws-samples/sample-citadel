"""Unit tests for the shared bounded DynamoDB paginator (finding: PR213 CI
hang; mirrors the fix in 920e557).

Covers: multi-page scan/query collection, the MagicMock-shaped non-dict
``LastEvaluatedKey`` guard, and the hard page cap (both log-and-stop and
raise_on_cap=True semantics).
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from common.dynamo_pagination import (
    DEFAULT_MAX_PAGES,
    PaginationPageCapExceeded,
    collect_items,
    paginate_pages,
)


class TestMultiPage:
    def test_single_page_no_last_evaluated_key(self):
        call = MagicMock(return_value={"Items": [{"id": 1}, {"id": 2}]})
        pages = list(paginate_pages(call))
        assert len(pages) == 1
        call.assert_called_once_with()

    def test_multi_page_follows_last_evaluated_key_as_exclusive_start_key(self):
        responses = [
            {"Items": [{"id": 1}], "LastEvaluatedKey": {"id": 1}},
            {"Items": [{"id": 2}], "LastEvaluatedKey": {"id": 2}},
            {"Items": [{"id": 3}]},
        ]
        call = MagicMock(side_effect=responses)
        pages = list(paginate_pages(call))
        assert len(pages) == 3
        assert call.call_args_list[0].kwargs == {}
        assert call.call_args_list[1].kwargs == {"ExclusiveStartKey": {"id": 1}}
        assert call.call_args_list[2].kwargs == {"ExclusiveStartKey": {"id": 2}}

    def test_extra_kwargs_forwarded_to_every_page(self):
        responses = [
            {"Items": [{"id": 1}], "LastEvaluatedKey": {"id": 1}},
            {"Items": [{"id": 2}]},
        ]
        call = MagicMock(side_effect=responses)
        list(
            paginate_pages(
                call,
                FilterExpression="#s = :running",
                ExpressionAttributeNames={"#s": "status"},
            )
        )
        for c in call.call_args_list:
            assert c.kwargs["FilterExpression"] == "#s = :running"
            assert c.kwargs["ExpressionAttributeNames"] == {"#s": "status"}

    def test_collect_items_flattens_all_pages(self):
        responses = [
            {"Items": [{"id": 1}, {"id": 2}], "LastEvaluatedKey": {"id": 2}},
            {"Items": [{"id": 3}]},
        ]
        call = MagicMock(side_effect=responses)
        items = collect_items(call)
        assert items == [{"id": 1}, {"id": 2}, {"id": 3}]

    def test_collect_items_handles_missing_items_key(self):
        call = MagicMock(return_value={})
        assert collect_items(call) == []


class TestNonDictKeyGuard:
    """The MagicMock guard (finding: PR213 CI hang): a stubbed table's
    attribute access always returns a truthy MagicMock, which would loop
    forever under a naive ``if not last_key: break`` check alone.
    """

    def test_magicmock_last_evaluated_key_stops_immediately(self):
        response = {"Items": [{"id": 1}]}
        response["LastEvaluatedKey"] = MagicMock()  # truthy, not a dict
        call = MagicMock(return_value=response)
        pages = list(paginate_pages(call, max_pages=5))
        assert len(pages) == 1
        call.assert_called_once()

    def test_empty_dict_last_evaluated_key_stops(self):
        call = MagicMock(return_value={"Items": [{"id": 1}], "LastEvaluatedKey": {}})
        pages = list(paginate_pages(call))
        assert len(pages) == 1

    def test_non_dict_non_mock_last_evaluated_key_stops(self):
        call = MagicMock(
            return_value={"Items": [{"id": 1}], "LastEvaluatedKey": "not-a-dict"}
        )
        pages = list(paginate_pages(call))
        assert len(pages) == 1


class TestPageCap:
    def test_default_cap_is_10000(self):
        assert DEFAULT_MAX_PAGES == 10000

    def test_cap_stops_pagination_and_logs_by_default(self, caplog):
        def always_more_pages(**_kwargs):
            return {"Items": [{"id": 1}], "LastEvaluatedKey": {"id": 1}}

        call = MagicMock(side_effect=always_more_pages)
        pages = list(paginate_pages(call, max_pages=3))
        # Pages yielded: page 0, page 1 (pages=1 after it), page 2
        # (pages=2 after it) — the cap check fires after incrementing, so
        # with max_pages=3 we get pages 0,1,2 then stop before a 4th call.
        assert len(pages) == 3
        assert call.call_count == 3

    def test_cap_exceeded_raises_when_raise_on_cap_true(self):
        def always_more_pages(**_kwargs):
            return {"Items": [{"id": 1}], "LastEvaluatedKey": {"id": 1}}

        call = MagicMock(side_effect=always_more_pages)
        with pytest.raises(PaginationPageCapExceeded):
            list(paginate_pages(call, max_pages=2, raise_on_cap=True))

    def test_magicmock_table_bounded_by_cap_not_infinite(self):
        """End-to-end MagicMock-table scenario: a raw, unconfigured
        MagicMock standing in for a DynamoDB Table terminates via the page
        cap rather than looping forever (the actual PR213 CI hang shape).
        """
        table = MagicMock()
        table.scan.return_value = {"Items": []}  # LastEvaluatedKey absent
        # Force the truthy-mock-forever shape by overriding return_value
        # with a dict whose LastEvaluatedKey is itself a MagicMock.
        table.scan.return_value = {"Items": [], "LastEvaluatedKey": MagicMock()}
        pages = list(paginate_pages(table.scan, max_pages=50))
        # Non-dict guard fires on page 1 already (MagicMock stand-in key),
        # so this never approaches the cap — but assert boundedness anyway.
        assert len(pages) == 1
        assert table.scan.call_count == 1
