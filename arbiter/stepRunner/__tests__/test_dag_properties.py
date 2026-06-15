"""
Property-based tests for stepRunner/dag.py.

Tests cover:
- Property 2: Topological Sort Ordering Invariant
- Property 6: Convergence Node Barrier
- find_root_nodes returns only nodes with no incoming edges
- find_ready_nodes never returns a node whose predecessor is still pending or running
- find_downstream_subgraph is a superset of direct successors
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from hypothesis import given, settings, assume
from hypothesis import strategies as st

from dag import (
    topological_sort,
    find_root_nodes,
    find_ready_nodes,
    find_convergence_nodes,
    find_downstream_subgraph,
)


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

@st.composite
def dag_strategy(draw):
    """Generate a random DAG with 1-10 nodes and valid edges (no cycles)."""
    num_nodes = draw(st.integers(min_value=1, max_value=10))
    nodes = [{'id': f'n{i}'} for i in range(num_nodes)]
    node_ids = [n['id'] for n in nodes]

    edges = []
    if num_nodes >= 2:
        # Only allow edges from lower index to higher index (guarantees DAG)
        possible_edges = [(i, j) for i in range(num_nodes) for j in range(i + 1, num_nodes)]
        num_edges = draw(st.integers(min_value=0, max_value=min(len(possible_edges), num_nodes * 2)))
        selected = draw(st.lists(
            st.sampled_from(possible_edges) if possible_edges else st.nothing(),
            min_size=0,
            max_size=num_edges,
            unique=True,
        ))
        edges = [
            {'id': f'e{k}', 'source': node_ids[i], 'target': node_ids[j]}
            for k, (i, j) in enumerate(selected)
        ]

    return nodes, edges


@st.composite
def dag_with_convergence_strategy(draw):
    """Generate a DAG that is guaranteed to have at least one convergence node (in-degree > 1)."""
    # Need at least 3 nodes: 2 sources + 1 convergence target
    num_nodes = draw(st.integers(min_value=3, max_value=10))
    nodes = [{'id': f'n{i}'} for i in range(num_nodes)]
    node_ids = [n['id'] for n in nodes]

    # Force at least one convergence node: pick a target with >= 2 sources
    target_idx = draw(st.integers(min_value=2, max_value=num_nodes - 1))
    source_indices = draw(st.lists(
        st.integers(min_value=0, max_value=target_idx - 1),
        min_size=2,
        max_size=min(target_idx, 4),
        unique=True,
    ))

    edges = []
    for k, src_idx in enumerate(source_indices):
        edges.append({
            'id': f'e{k}',
            'source': node_ids[src_idx],
            'target': node_ids[target_idx],
        })

    # Add some extra random edges (lower→higher, no duplicates)
    existing = {(e['source'], e['target']) for e in edges}
    possible_extras = [
        (i, j) for i in range(num_nodes) for j in range(i + 1, num_nodes)
        if (node_ids[i], node_ids[j]) not in existing
    ]
    if possible_extras:
        num_extras = draw(st.integers(min_value=0, max_value=min(len(possible_extras), num_nodes)))
        selected = draw(st.lists(
            st.sampled_from(possible_extras),
            min_size=0,
            max_size=num_extras,
            unique=True,
        ))
        for i, j in selected:
            edges.append({
                'id': f'e{len(edges)}',
                'source': node_ids[i],
                'target': node_ids[j],
            })

    return nodes, edges


# ---------------------------------------------------------------------------
# Property 2: Topological Sort Ordering Invariant (Task 7.2)
# ---------------------------------------------------------------------------

class TestTopologicalSortOrderingInvariant:
    """
    **Validates: Requirements 10.2, 10.11**

    Property 2: For all valid DAGs and resulting sort order O,
    for every edge (u, v), indexOf(u, O) < indexOf(v, O).
    """

    @given(data=dag_strategy())
    @settings(max_examples=100)
    def test_every_edge_respects_topological_order(self, data):
        """For every edge (u, v) in the DAG, u appears before v in the sort order."""
        nodes, edges = data
        order = topological_sort(nodes, edges)

        # All node IDs must be present in the output
        node_ids = {n['id'] for n in nodes}
        assert set(order) == node_ids

        # Build index map for O(1) lookup
        index_of = {nid: idx for idx, nid in enumerate(order)}

        for edge in edges:
            src, tgt = edge['source'], edge['target']
            assert index_of[src] < index_of[tgt], (
                f"Edge ({src} -> {tgt}): {src} at index {index_of[src]}, "
                f"{tgt} at index {index_of[tgt]}"
            )

    def test_single_node_no_edges(self):
        """A single node with no edges returns that node."""
        nodes = [{'id': 'a'}]
        edges = []
        assert topological_sort(nodes, edges) == ['a']

    def test_cycle_raises_value_error(self):
        """A graph with a cycle raises ValueError."""
        nodes = [{'id': 'a'}, {'id': 'b'}]
        edges = [
            {'id': 'e0', 'source': 'a', 'target': 'b'},
            {'id': 'e1', 'source': 'b', 'target': 'a'},
        ]
        with pytest.raises(ValueError, match="cycle"):
            topological_sort(nodes, edges)


# ---------------------------------------------------------------------------
# Property 6: Convergence Node Barrier (Task 7.3)
# ---------------------------------------------------------------------------

class TestConvergenceNodeBarrier:
    """
    **Validates: Requirements 10.4, 21.2, 21.3**

    Property 6: For all convergence nodes n with predecessors P,
    n is ready iff for all p in P: status(p) ∈ {completed, skipped}.
    """

    @given(data=dag_with_convergence_strategy())
    @settings(max_examples=100)
    def test_convergence_node_ready_when_all_predecessors_done(self, data):
        """A convergence node is ready only when ALL predecessors are completed or skipped."""
        nodes, edges = data
        convergence_ids = find_convergence_nodes(nodes, edges)
        assume(len(convergence_ids) > 0)

        # Build predecessor map
        predecessors = {}
        for edge in edges:
            predecessors.setdefault(edge['target'], set()).add(edge['source'])

        for conv_id in convergence_ids:
            preds = predecessors.get(conv_id, set())
            assert len(preds) > 1, f"Convergence node {conv_id} should have >1 predecessors"

            # Case 1: All predecessors completed/skipped → node should be ready
            node_results_all_done = {n['id']: 'completed' for n in nodes}
            node_results_all_done[conv_id] = 'pending'  # The convergence node itself is pending
            for p in preds:
                node_results_all_done[p] = 'completed'

            ready = find_ready_nodes(nodes, edges, node_results_all_done)
            assert conv_id in ready, (
                f"Convergence node {conv_id} should be ready when all predecessors are done"
            )

            # Case 2: One predecessor still running → node should NOT be ready
            node_results_one_running = dict(node_results_all_done)
            first_pred = next(iter(preds))
            node_results_one_running[first_pred] = 'running'

            ready_partial = find_ready_nodes(nodes, edges, node_results_one_running)
            assert conv_id not in ready_partial, (
                f"Convergence node {conv_id} should NOT be ready when predecessor {first_pred} is running"
            )

    @given(data=dag_with_convergence_strategy())
    @settings(max_examples=100)
    def test_convergence_node_ready_with_skipped_predecessors(self, data):
        """A convergence node is ready when predecessors are a mix of completed and skipped."""
        nodes, edges = data
        convergence_ids = find_convergence_nodes(nodes, edges)
        assume(len(convergence_ids) > 0)

        predecessors = {}
        for edge in edges:
            predecessors.setdefault(edge['target'], set()).add(edge['source'])

        for conv_id in convergence_ids:
            preds = list(predecessors.get(conv_id, set()))
            assert len(preds) > 1

            # Mix of completed and skipped
            node_results = {n['id']: 'completed' for n in nodes}
            node_results[conv_id] = 'pending'
            node_results[preds[0]] = 'skipped'  # First predecessor skipped

            ready = find_ready_nodes(nodes, edges, node_results)
            assert conv_id in ready, (
                f"Convergence node {conv_id} should be ready when predecessors are completed/skipped"
            )


# ---------------------------------------------------------------------------
# find_root_nodes, find_ready_nodes, find_downstream_subgraph (Task 7.4)
# ---------------------------------------------------------------------------

class TestFindRootNodes:
    """
    **Validates: Requirements 10.2, 10.8, 27.6**

    find_root_nodes returns only nodes with no incoming edges.
    """

    @given(data=dag_strategy())
    @settings(max_examples=100)
    def test_root_nodes_have_no_incoming_edges(self, data):
        """Every root node has zero incoming edges."""
        nodes, edges = data
        roots = find_root_nodes(nodes, edges)

        targets = {e['target'] for e in edges}
        for root_id in roots:
            assert root_id not in targets, (
                f"Root node {root_id} has incoming edges"
            )

    @given(data=dag_strategy())
    @settings(max_examples=100)
    def test_all_nodes_without_incoming_edges_are_roots(self, data):
        """Every node with no incoming edges is returned as a root."""
        nodes, edges = data
        roots = set(find_root_nodes(nodes, edges))

        targets = {e['target'] for e in edges}
        for node in nodes:
            if node['id'] not in targets:
                assert node['id'] in roots, (
                    f"Node {node['id']} has no incoming edges but is not a root"
                )

    def test_single_node_is_root(self):
        """A single node with no edges is a root."""
        nodes = [{'id': 'a'}]
        edges = []
        assert find_root_nodes(nodes, edges) == ['a']


class TestFindReadyNodes:
    """
    **Validates: Requirements 10.2, 10.8, 27.6**

    find_ready_nodes never returns a node whose predecessor is still pending or running.
    """

    @given(data=dag_strategy())
    @settings(max_examples=100)
    def test_ready_nodes_have_no_pending_or_running_predecessors(self, data):
        """No ready node has a predecessor with status 'pending' or 'running'."""
        nodes, edges = data
        node_ids = [n['id'] for n in nodes]

        # Assign random statuses
        statuses = ['pending', 'running', 'completed', 'skipped', 'failed']
        node_results = {nid: statuses[hash(nid) % len(statuses)] for nid in node_ids}

        ready = find_ready_nodes(nodes, edges, node_results)

        # Build predecessor map
        predecessors = {}
        for edge in edges:
            predecessors.setdefault(edge['target'], set()).add(edge['source'])

        for ready_id in ready:
            preds = predecessors.get(ready_id, set())
            for p in preds:
                assert node_results[p] in ('completed', 'skipped'), (
                    f"Ready node {ready_id} has predecessor {p} with status '{node_results[p]}'"
                )

    @given(data=dag_strategy())
    @settings(max_examples=100)
    def test_ready_nodes_are_pending(self, data):
        """Only pending nodes can be ready."""
        nodes, edges = data
        node_ids = [n['id'] for n in nodes]

        # All completed except first node pending
        node_results = {nid: 'completed' for nid in node_ids}
        if node_ids:
            node_results[node_ids[0]] = 'pending'

        ready = find_ready_nodes(nodes, edges, node_results)
        for ready_id in ready:
            assert node_results[ready_id] == 'pending', (
                f"Ready node {ready_id} has status '{node_results[ready_id]}', expected 'pending'"
            )


class TestFindDownstreamSubgraph:
    """
    **Validates: Requirements 10.2, 10.8, 27.6**

    find_downstream_subgraph is a superset of direct successors.
    """

    @given(data=dag_strategy())
    @settings(max_examples=100)
    def test_downstream_includes_direct_successors(self, data):
        """The downstream subgraph includes all direct successors of the start node."""
        nodes, edges = data
        assume(len(nodes) >= 2 and len(edges) >= 1)

        # Pick a node that has at least one outgoing edge
        sources = {e['source'] for e in edges}
        assume(len(sources) > 0)
        start_node = next(iter(sources))

        direct_successors = {e['target'] for e in edges if e['source'] == start_node}
        downstream = find_downstream_subgraph(start_node, edges)

        for succ in direct_successors:
            assert succ in downstream, (
                f"Direct successor {succ} of {start_node} not in downstream subgraph"
            )

    @given(data=dag_strategy())
    @settings(max_examples=100)
    def test_downstream_does_not_include_start_node(self, data):
        """The downstream subgraph does not include the start node itself."""
        nodes, edges = data
        node_ids = [n['id'] for n in nodes]
        assume(len(node_ids) > 0)

        start_node = node_ids[0]
        downstream = find_downstream_subgraph(start_node, edges)
        assert start_node not in downstream

    def test_leaf_node_has_empty_downstream(self):
        """A leaf node (no outgoing edges) has an empty downstream subgraph."""
        edges = [{'id': 'e0', 'source': 'a', 'target': 'b'}]
        downstream = find_downstream_subgraph('b', edges)
        assert downstream == set()

    def test_transitive_reachability(self):
        """Downstream includes transitively reachable nodes, not just direct successors."""
        edges = [
            {'id': 'e0', 'source': 'a', 'target': 'b'},
            {'id': 'e1', 'source': 'b', 'target': 'c'},
            {'id': 'e2', 'source': 'c', 'target': 'd'},
        ]
        downstream = find_downstream_subgraph('a', edges)
        assert downstream == {'b', 'c', 'd'}
