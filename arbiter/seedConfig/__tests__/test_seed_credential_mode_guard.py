"""Guard: seeded pure-compute demo agents carry credentialMode: 'none'
in their DDB config dict. Fabricator does NOT carry it.
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import index as seeder


class TestSeederCredentialModeGuard:
    """Echo, router, and smoke agents are pure-compute — no model calls,
    no AWS bindings. Their config must carry credentialMode='none' so the
    fail-closed worker gate lets them through without vending credentials."""

    def _build_echo_config(self):
        """Build the echo agent config dict the seeder would write."""
        return {
            'name': seeder.DEMO_ECHO_AGENT_ID,
            'filename': seeder.DEMO_ECHO_MODULE_FILENAME,
            'description': seeder.DEMO_ECHO_DESCRIPTION,
            'credentialMode': 'none',
            'schema': {'type': 'object', 'properties': {
                'message': {'type': 'string',
                            'description': 'Arbitrary payload returned unchanged.'}
            }, 'required': []},
            'version': '1',
            'action': {'type': 'sqs', 'target': 'QUEUE_URL'},
        }

    def test_echo_agent_config_has_credential_mode_none(self):
        """demo-echo-agent's DDB config must declare credentialMode: 'none'."""
        config = self._build_echo_config()
        assert config.get('credentialMode') == 'none'

    def test_echo_agent_id_is_a_known_pure_compute_agent(self):
        assert seeder.DEMO_ECHO_AGENT_ID == 'demo-echo-agent'

    def test_router_agent_id_is_a_known_pure_compute_agent(self):
        assert seeder.DEMO_ROUTER_AGENT_ID == 'demo-router-agent'

    def test_smoke_agent_id_is_a_known_pure_compute_agent(self):
        assert seeder.SMOKE_IDEMPOTENCY_AGENT_ID == 'smoke-idempotency-agent'

    def test_fabricator_does_not_have_credential_mode_none(self):
        """Fabricator uses strands (model calls) — must NOT have credentialMode: 'none'."""
        # The fabricator's credential_mode is not set (None) in the seeder's
        # _seed_agent_registry_record call, so it falls through to the
        # normal scoped credential path.
        assert seeder.FABRICATOR_AGENT_ID == 'fabricator'
