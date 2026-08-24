"""Unit tests for the single DynamoDB marshalling boundary (finding 96d24639).

The boundary must make it IMPOSSIBLE for a native float to reach DynamoDB
silently: integral floats collapse to int (DDB TTL requires int), genuine
fractional floats become Decimal, non-finite floats are REJECTED, and floats
nested anywhere in the item are caught.
"""
import decimal

import pytest

from common.ddb_marshalling import (
    FloatMarshallingError,
    marshal_ddb_item,
    normalize_ddb_value,
)


class TestFloatPolicy:
    def test_integral_float_becomes_int(self):
        out = marshal_ddb_item({"ttl": 1000.0})
        assert out["ttl"] == 1000
        assert isinstance(out["ttl"], int)

    def test_fractional_float_becomes_decimal_via_repr(self):
        out = marshal_ddb_item({"writtenAt": 1000.5})
        assert out["writtenAt"] == decimal.Decimal("1000.5")
        assert isinstance(out["writtenAt"], decimal.Decimal)

    def test_fractional_float_has_no_binary_precision_tail(self):
        # Decimal(str(0.1)) == Decimal('0.1'), NOT the 0.1000000000000000055…
        # tail that Decimal(0.1) would produce.
        out = marshal_ddb_item({"x": 0.1})
        assert str(out["x"]) == "0.1"

    def test_negative_zero_float_is_integral(self):
        out = marshal_ddb_item({"x": -0.0})
        assert out["x"] == 0
        assert isinstance(out["x"], int)

    @pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
    def test_non_finite_float_is_rejected(self, bad):
        with pytest.raises(FloatMarshallingError):
            marshal_ddb_item({"x": bad})


class TestPassThroughAndNesting:
    def test_bool_is_preserved_not_coerced_to_int(self):
        out = marshal_ddb_item({"flag": True, "off": False})
        assert out["flag"] is True
        assert out["off"] is False

    def test_int_str_decimal_none_bytes_pass_through(self):
        item = {"i": 5, "s": "x", "d": decimal.Decimal("1.25"), "n": None, "b": b"raw"}
        out = marshal_ddb_item(item)
        assert out == item

    def test_float_nested_in_dict_and_list_is_caught(self):
        out = marshal_ddb_item({
            "nested": {"a": 2.0, "deep": {"b": 3.5}},
            "items": [1.0, 2.5, {"c": 4.0}],
        })
        assert out["nested"]["a"] == 2 and isinstance(out["nested"]["a"], int)
        assert out["nested"]["deep"]["b"] == decimal.Decimal("3.5")
        assert out["items"][0] == 1 and out["items"][1] == decimal.Decimal("2.5")
        assert out["items"][2]["c"] == 4

    def test_tuple_becomes_list(self):
        out = normalize_ddb_value((1.0, 2.5))
        assert out == [1, decimal.Decimal("2.5")]


class TestBoundaryContract:
    def test_returns_new_dict_never_mutates_caller(self):
        original = {"ttl": 10.0, "keep": "v"}
        out = marshal_ddb_item(original)
        assert original["ttl"] == 10.0  # caller's dict untouched
        assert out["ttl"] == 10 and out is not original

    def test_non_dict_item_rejected(self):
        with pytest.raises(TypeError):
            marshal_ddb_item([("k", 1.0)])
