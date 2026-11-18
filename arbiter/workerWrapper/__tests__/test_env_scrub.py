"""Unit tests for ``credential_guard`` (PR-4): CredentialRefusal, the ambient
AWS-credential denylist/scrub, and ``build_agent_credential_env``.

Owner decision 5750aeec: FAIL CLOSED, no grandfathering.
"""
from __future__ import annotations

import string

import pytest
from hypothesis import given, strategies as st

import credential_guard as cg


class TestCredentialRefusal:
    def test_error_class_is_stable_string(self):
        exc = cg.CredentialRefusal(cg.NO_REQUIRED_PERMISSIONS, "agent-A")
        assert exc.error_class == "CredentialRefusal"

    def test_message_includes_agent_id_when_present(self):
        exc = cg.CredentialRefusal(cg.VEND_FAILED, "agent-A")
        assert "agent-A" in exc.message
        assert cg.VEND_FAILED in exc.message

    def test_message_omits_agent_id_when_absent(self):
        exc = cg.CredentialRefusal(cg.NO_ORG, None)
        assert exc.message == cg.NO_ORG


class TestScrubAmbientAwsEnv:
    def test_removes_every_denylist_key(self):
        env = {k: "x" for k in cg.AMBIENT_AWS_KEYS}
        env["PATH"] = "/usr/bin"
        scrubbed = cg.scrub_ambient_aws_env(env)
        assert not (set(scrubbed) & cg.AMBIENT_AWS_KEYS)
        assert scrubbed["PATH"] == "/usr/bin"

    def test_keeps_aws_region_and_default_region(self):
        env = {
            "AWS_ACCESS_KEY_ID": "AKIA...",
            "AWS_REGION": "us-east-1",
            "AWS_DEFAULT_REGION": "us-west-2",
        }
        scrubbed = cg.scrub_ambient_aws_env(env)
        assert scrubbed["AWS_REGION"] == "us-east-1"
        assert scrubbed["AWS_DEFAULT_REGION"] == "us-west-2"
        assert "AWS_ACCESS_KEY_ID" not in scrubbed

    def test_does_not_mutate_input(self):
        env = {"AWS_ACCESS_KEY_ID": "AKIA...", "PATH": "/bin"}
        original = dict(env)
        cg.scrub_ambient_aws_env(env)
        assert env == original

    def test_empty_env_returns_empty(self):
        assert cg.scrub_ambient_aws_env({}) == {}

    @given(
        extra_aws_keys=st.dictionaries(
            st.sampled_from(sorted(cg.AMBIENT_AWS_KEYS)),
            st.text(alphabet=string.printable, max_size=40),
        ),
        other_keys=st.dictionaries(
            st.text(min_size=1, max_size=20, alphabet=string.ascii_uppercase + "_"),
            st.text(max_size=40),
        ),
    )
    def test_property_output_never_carries_denylist_keys(self, extra_aws_keys, other_keys):
        """For ANY env dict seeded with arbitrary ambient AWS keys mixed with
        arbitrary other keys, the scrub output contains none of
        AMBIENT_AWS_KEYS, and every non-denylisted key survives unchanged."""
        env = {**other_keys, **extra_aws_keys}
        scrubbed = cg.scrub_ambient_aws_env(env)
        assert not (set(scrubbed) & cg.AMBIENT_AWS_KEYS)
        for k, v in other_keys.items():
            if k not in cg.AMBIENT_AWS_KEYS:
                assert scrubbed[k] == v


class TestBuildAgentCredentialEnv:
    def test_scoped_mode_injects_exactly_three_keys(self):
        base = {"AWS_ACCESS_KEY_ID": "ambient", "PATH": "/bin"}
        scoped = {
            "accessKeyId": "AKIASCOPED",
            "secretAccessKey": "scoped-secret",
            "sessionToken": "scoped-token",
        }
        env = cg.build_agent_credential_env(base, scoped, credential_mode="scoped")
        assert env["AWS_ACCESS_KEY_ID"] == "AKIASCOPED"
        assert env["AWS_SECRET_ACCESS_KEY"] == "scoped-secret"
        assert env["AWS_SESSION_TOKEN"] == "scoped-token"
        assert env["PATH"] == "/bin"

    def test_scoped_mode_with_empty_credentials_raises(self):
        with pytest.raises(cg.CredentialRefusal) as excinfo:
            cg.build_agent_credential_env({}, None, credential_mode="scoped")
        assert excinfo.value.reason == cg.VEND_FAILED

    def test_scoped_mode_with_empty_dict_raises(self):
        with pytest.raises(cg.CredentialRefusal):
            cg.build_agent_credential_env({}, {}, credential_mode="scoped")

    def test_none_mode_injects_nothing_and_scrubs(self):
        base = {"AWS_ACCESS_KEY_ID": "ambient", "PATH": "/bin"}
        env = cg.build_agent_credential_env(base, None, credential_mode="none")
        assert not (set(env) & cg.AMBIENT_AWS_KEYS)
        assert env["PATH"] == "/bin"

    def test_none_mode_ignores_scoped_credentials_if_present(self):
        scoped = {"accessKeyId": "x", "secretAccessKey": "y", "sessionToken": "z"}
        env = cg.build_agent_credential_env({}, scoped, credential_mode="none")
        assert "AWS_ACCESS_KEY_ID" not in env

    def test_unknown_mode_raises(self):
        with pytest.raises(cg.CredentialRefusal):
            cg.build_agent_credential_env({}, None, credential_mode="bogus")

    def test_never_leaves_an_ambient_key_in_result(self):
        """Even when scoped credentials are supplied, no AMBIENT_AWS_KEYS
        member other than the 3 injected ones can survive."""
        base = {k: "ambient" for k in cg.AMBIENT_AWS_KEYS}
        scoped = {
            "accessKeyId": "AKIASCOPED",
            "secretAccessKey": "scoped-secret",
            "sessionToken": "scoped-token",
        }
        env = cg.build_agent_credential_env(base, scoped, credential_mode="scoped")
        leaked = (set(env) & cg.AMBIENT_AWS_KEYS) - {
            "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
        }
        assert not leaked
        assert env["AWS_ACCESS_KEY_ID"] == "AKIASCOPED"
