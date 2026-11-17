"""Tests — consent catalogue is a standalone JSON file loaded by consent.py.

Validates:
- consent_catalogue.json exists
- It parses as valid JSON with the required fields
- consent.py ACTION_CATALOGUE matches the JSON file
"""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


CATALOGUE_PATH = os.path.join(
    os.path.dirname(__file__), "..", "tools", "consent_catalogue.json"
)


def test_catalogue_json_file_exists():
    assert os.path.isfile(CATALOGUE_PATH), "consent_catalogue.json must exist"


def test_catalogue_json_is_valid():
    with open(CATALOGUE_PATH) as f:
        data = json.load(f)
    assert isinstance(data, dict)
    for action_id, entry in data.items():
        assert isinstance(action_id, str)
        assert "label" in entry
        assert "confirmMessage" in entry
        assert "description" in entry


def test_consent_py_catalogue_matches_json():
    """ACTION_CATALOGUE in consent.py must be derived from the JSON file."""
    with open(CATALOGUE_PATH) as f:
        json_cat = json.load(f)

    from tools.consent import ACTION_CATALOGUE

    assert set(ACTION_CATALOGUE.keys()) == set(json_cat.keys())
    for action_id in json_cat:
        assert ACTION_CATALOGUE[action_id]["label"] == json_cat[action_id]["label"]
        assert ACTION_CATALOGUE[action_id]["description"] == json_cat[action_id]["description"]
