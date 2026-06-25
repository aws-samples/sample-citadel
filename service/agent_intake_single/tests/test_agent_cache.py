"""Tests for agent cache LRU eviction and invalidation."""
import sys
import types

import pytest

# The SUT (``agent.py``) imports ``bedrock_agentcore`` at module load, which
# is only available inside the AWS Bedrock AgentCore runtime image. Stub it
# here so the import chain resolves in a plain pytest venv. Tests below never
# exercise the stubbed symbols — they target ``LRUCache`` and the interaction
# between ``tools.state.update_intake_progress`` and ``agent._agent_cache``,
# both of which are independent of the AgentCore SDK.
if 'bedrock_agentcore' not in sys.modules:
    stub = types.ModuleType('bedrock_agentcore')

    class _StubApp:
        def __init__(self, *a, **kw): pass
        def add_middleware(self, *a, **kw): pass  # real app registers CORS at import time
        def entrypoint(self, fn):
            return fn  # passthrough decorator

    class _StubRequestContext:
        pass

    stub.BedrockAgentCoreApp = _StubApp  # type: ignore[attr-defined]
    stub.RequestContext = _StubRequestContext  # type: ignore[attr-defined]
    sys.modules['bedrock_agentcore'] = stub
from unittest.mock import patch, MagicMock


class TestLRUCache:
    def test_evicts_oldest_when_exceeding_maxsize(self):
        from agent import LRUCache
        cache = LRUCache(maxsize=3)
        cache['a'] = 1
        cache['b'] = 2
        cache['c'] = 3
        cache['d'] = 4  # should evict 'a'
        assert 'a' not in cache
        assert 'd' in cache
        assert len(cache) == 3

    def test_access_refreshes_position(self):
        from agent import LRUCache
        cache = LRUCache(maxsize=3)
        cache['a'] = 1
        cache['b'] = 2
        cache['c'] = 3
        _ = cache['a']  # refresh 'a'
        cache['d'] = 4  # should evict 'b' (oldest unused)
        assert 'a' in cache
        assert 'b' not in cache


class TestCacheInvalidation:
    @patch('tools.state._table')
    @patch('tools.state._publish_event')
    def test_cache_cleared_on_progress_update(self, mock_publish, mock_table):
        import agent
        from tools.state import update_intake_progress

        mock_table.return_value = MagicMock()
        mock_table.return_value.update_item = MagicMock()

        # Pre-populate cache
        agent._agent_cache['test-session'] = MagicMock()
        assert 'test-session' in agent._agent_cache

        update_intake_progress(
            session_id='test-session',
            phase='assessment',
            progress=50,
            change_summary='test'
        )

        assert 'test-session' not in agent._agent_cache


class TestCacheInvalidationFailure:
    """Cache invalidation is best-effort. If it raises, the operator must see
    a warning, but the function must still return successfully because the
    DynamoDB write (the actual unit of work) has already committed."""

    @patch('tools.state._table')
    @patch('tools.state._publish_event')
    def test_cache_invalidation_attribute_error_is_logged_and_swallowed(
        self, mock_publish, mock_table, caplog
    ):
        import logging
        import agent
        from tools.state import update_intake_progress

        mock_table.return_value = MagicMock()
        mock_table.return_value.update_item = MagicMock()

        # Replace the cache with one that explodes on membership test.
        bad_cache = MagicMock()
        bad_cache.__contains__ = MagicMock(side_effect=AttributeError('boom'))

        with patch.object(agent, '_agent_cache', bad_cache):
            with caplog.at_level(logging.WARNING, logger='tools.state'):
                result = update_intake_progress(
                    session_id='test-session',
                    phase='assessment',
                    progress=50,
                    change_summary='test',
                )

        # DynamoDB write succeeded → caller sees the success message.
        assert 'assessment progress: 50%' in result
        # Operator-visible warning was emitted.
        assert any(
            'Cache invalidation failed' in rec.message
            for rec in caplog.records
            if rec.levelno == logging.WARNING
        ), f'expected cache-invalidation warning, got: {[r.message for r in caplog.records]}'

    @patch('tools.state._table')
    @patch('tools.state._publish_event')
    def test_cache_invalidation_key_error_is_logged_and_swallowed(
        self, mock_publish, mock_table, caplog
    ):
        """Race: another worker deletes the key between the membership check
        and ``del``. Must not crash."""
        import logging
        import agent
        from tools.state import update_intake_progress

        mock_table.return_value = MagicMock()
        mock_table.return_value.update_item = MagicMock()

        bad_cache = MagicMock()
        bad_cache.__contains__ = MagicMock(return_value=True)
        bad_cache.__delitem__ = MagicMock(side_effect=KeyError('test-session'))

        with patch.object(agent, '_agent_cache', bad_cache):
            with caplog.at_level(logging.WARNING, logger='tools.state'):
                result = update_intake_progress(
                    session_id='test-session',
                    phase='assessment',
                    progress=50,
                    change_summary='test',
                )

        assert 'assessment progress: 50%' in result
        assert any(
            'Cache invalidation failed' in rec.message
            for rec in caplog.records
            if rec.levelno == logging.WARNING
        )
