"""Tests for agent cache LRU eviction and invalidation."""
import pytest
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
