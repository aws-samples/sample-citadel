"""
Tests for transitive skip propagation (CIT-259 H4).

Includes deterministic unit tests for specific graph shapes and Hypothesis
property-based tests over random DAGs verifying that every node ends in
exactly one terminal status and no deadlock occurs.
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from hypothesis import given, settings, assume
from hypothesis import strategies as st

from dag import propagate_skips, find_ready_nodes


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
def dag_with_skip_strategy(draw):
    """Generate a random DAG plus a random subset of nodes to skip."""
    nodes, edges = draw(dag_strategy())
    node_ids = [n['id'] for n in nodes]
    skip_count = draw(st.integers(min_value=0, max_value=len(node_ids)))
    skipped = set(draw(st.lists(
        st.sampled_from(node_ids) if node_ids else st.nothing(),
        min_size=0,
        max_size=skip_count,
        unique=True,
    )))
    return nodes, edges, skipped


# ---------------------------------------------------------------------------
# Deterministic unit tests: propagate_skips
# ---------------------------------------------------------------------------

class TestPropagateSkipsDeterministic:
    def test_diamond_skip_one_branch_convergence_stays_live(self):
        """Diamond: A->B, A->C, B->D, C->D. Skip B. D has live path via C."""
        nodes = [{'id': 'A'}, {'id': 'B'}, {'id': 'C'}, {'id': 'D'}]
        edges = [
            {'source': 'A', 'target': 'B'},
            {'source': 'A', 'target': 'C'},
            {'source': 'B', 'target': 'D'},
            {'source': 'C', 'target': 'D'},
        ]
        unreachable = propagate_skips({'B'}, nodes, edges)
        assert unreachable == set()  # D has a live path via C

    def test_linear_chain_skip_propagates(self):
        """Linear: A->B->C->D. Skip B. C and D become unreachable."""
        nodes = [{'id': 'A'}, {'id': 'B'}, {'id': 'C'}, {'id': 'D'}]
        edges = [
            {'source': 'A', 'target': 'B'},
            {'source': 'B', 'target': 'C'},
            {'source': 'C', 'target': 'D'},
        ]
        unreachable = propagate_skips({'B'}, nodes, edges)
        assert unreachable == {'C', 'D'}

    def test_fan_out_both_skipped(self):
        """Fan-out: A->B, A->C, B->D, C->E. Skip both B and C."""
        nodes = [{'id': 'A'}, {'id': 'B'}, {'id': 'C'}, {'id': 'D'}, {'id': 'E'}]
        edges = [
            {'source': 'A', 'target': 'B'},
            {'source': 'A', 'target': 'C'},
            {'source': 'B', 'target': 'D'},
            {'source': 'C', 'target': 'E'},
        ]
        unreachable = propagate_skips({'B', 'C'}, nodes, edges)
        assert unreachable == {'D', 'E'}

    def test_mixed_skip_convergence_live(self):
        """Mixed: A->B, A->C, B->D, C->D, D->E. Skip B. D has live path via C."""
        nodes = [{'id': 'A'}, {'id': 'B'}, {'id': 'C'}, {'id': 'D'}, {'id': 'E'}]
        edges = [
            {'source': 'A', 'target': 'B'},
            {'source': 'A', 'target': 'C'},
            {'source': 'B', 'target': 'D'},
            {'source': 'C', 'target': 'D'},
            {'source': 'D', 'target': 'E'},
        ]
        unreachable = propagate_skips({'B'}, nodes, edges)
        assert unreachable == set()

    def test_no_skips_returns_empty(self):
        nodes = [{'id': 'A'}, {'id': 'B'}]
        edges = [{'source': 'A', 'target': 'B'}]
        unreachable = propagate_skips(set(), nodes, edges)
        assert unreachable == set()

    def test_skip_root_propagates_to_all_downstream(self):
        """Skip the only root -> entire graph unreachable."""
        nodes = [{'id': 'A'}, {'id': 'B'}, {'id': 'C'}]
        edges = [
            {'source': 'A', 'target': 'B'},
            {'source': 'A', 'target': 'C'},
        ]
        unreachable = propagate_skips({'A'}, nodes, edges)
        assert unreachable == {'B', 'C'}

    def test_deep_chain_propagation(self):
        """Long chain: n0->n1->...->n9. Skip n0."""
        nodes = [{'id': f'n{i}'} for i in range(10)]
        edges = [{'source': f'n{i}', 'target': f'n{i+1}'} for i in range(9)]
        unreachable = propagate_skips({'n0'}, nodes, edges)
        assert unreachable == {f'n{i}' for i in range(1, 10)}

    def test_node_with_no_predecessors_never_unreachable(self):
        """Root nodes (no predecessors) are never marked unreachable."""
        nodes = [{'id': 'A'}, {'id': 'B'}, {'id': 'C'}]
        edges = [{'source': 'B', 'target': 'C'}]
        # Skip B — A is a root and should not be affected
        unreachable = propagate_skips({'B'}, nodes, edges)
        assert 'A' not in unreachable
        assert unreachable == {'C'}


# ---------------------------------------------------------------------------
# Hypothesis property tests
# ---------------------------------------------------------------------------

class TestPropagateSkipsProperties:
    @given(data=dag_with_skip_strategy())
    @settings(max_examples=200)
    def test_unreachable_set_excludes_initially_skipped(self, data):
        """propagate_skips returns only NEWLY unreachable nodes."""
        nodes, edges, skipped = data
        unreachable = propagate_skips(skipped, nodes, edges)
        assert unreachable.isdisjoint(skipped)

    @given(data=dag_with_skip_strategy())
    @settings(max_examples=200)
    def test_monotonicity(self, data):
        """Adding more skipped nodes can only grow the unreachable set."""
        nodes, edges, skipped = data
        node_ids = [n['id'] for n in nodes]
        if not node_ids:
            return

        # Compute with original skip set
        unreachable_base = propagate_skips(skipped, nodes, edges)

        # Add one more node to the skip set
        for nid in node_ids:
            if nid not in skipped:
                larger_skip = skipped | {nid}
                unreachable_larger = propagate_skips(larger_skip, nodes, edges)
                # Everything unreachable before (that isn't in the new skip set)
                # should still be unreachable
                for u in unreachable_base:
                    if u not in larger_skip:
                        assert u in unreachable_larger, (
                            f"Node {u} was unreachable with skips={skipped} "
                            f"but not with skips={larger_skip}"
                        )
                break

    @given(data=dag_with_skip_strategy())
    @settings(max_examples=200)
    def test_live_path_preservation(self, data):
        """A node with at least one non-dead predecessor is never unreachable."""
        nodes, edges, skipped = data
        unreachable = propagate_skips(skipped, nodes, edges)
        dead = skipped | unreachable

        predecessors: dict[str, set[str]] = {}
        for edge in edges:
            predecessors.setdefault(edge['target'], set()).add(edge['source'])

        for nid in unreachable:
            preds = predecessors.get(nid, set())
            # All predecessors must be dead
            assert preds <= dead, (
                f"Node {nid} marked unreachable but has live predecessor(s): "
                f"{preds - dead}"
            )


# ---------------------------------------------------------------------------
# Simulation: full execution terminates (no deadlock)
# ---------------------------------------------------------------------------

class TestFullExecutionSimulation:
    @given(data=dag_with_skip_strategy())
    @settings(max_examples=200)
    def test_every_node_reaches_terminal_status(self, data):
        """Simulate a full execution: every node ends in exactly one of
        {completed, skipped, unreachable}. No node is left pending."""
        nodes, edges, initially_skipped = data
        if not nodes:
            return

        # Build predecessors map
        predecessors: dict[str, set[str]] = {}
        for edge in edges:
            predecessors.setdefault(edge['target'], set()).add(edge['source'])

        # Compute all unreachable nodes
        unreachable = propagate_skips(initially_skipped, nodes, edges)

        # Simulate execution: remaining nodes that aren't skipped or unreachable
        # will be "completed"
        status = {}
        for node in nodes:
            nid = node['id']
            if nid in initially_skipped:
                status[nid] = 'skipped'
            elif nid in unreachable:
                status[nid] = 'unreachable'
            else:
                status[nid] = 'pending'

        # Run simulation: repeatedly find ready nodes and complete them
        max_steps = len(nodes) * 2  # bounded to prevent infinite loop
        step = 0
        while step < max_steps:
            ready = find_ready_nodes(nodes, edges, status)
            if not ready:
                break
            for r in ready:
                status[r] = 'completed'
            step += 1

        # Every node must be terminal
        for node in nodes:
            nid = node['id']
            assert status[nid] in ('completed', 'skipped', 'unreachable'), (
                f"Node {nid} stuck in status '{status[nid]}' after simulation"
            )

    @given(data=dag_with_skip_strategy())
    @settings(max_examples=200)
    def test_no_deadlock_bounded_steps(self, data):
        """The scheduler terminates within O(n) steps."""
        nodes, edges, initially_skipped = data
        if not nodes:
            return

        unreachable = propagate_skips(initially_skipped, nodes, edges)

        status = {}
        for node in nodes:
            nid = node['id']
            if nid in initially_skipped:
                status[nid] = 'skipped'
            elif nid in unreachable:
                status[nid] = 'unreachable'
            else:
                status[nid] = 'pending'

        step = 0
        while step < len(nodes) + 1:
            ready = find_ready_nodes(nodes, edges, status)
            if not ready:
                break
            for r in ready:
                status[r] = 'completed'
            step += 1

        # Must have terminated within bounds
        assert step <= len(nodes), (
            f"Simulation took {step} steps for {len(nodes)} nodes — possible deadlock"
        )

    @given(data=dag_with_skip_strategy())
    @settings(max_examples=200)
    def test_partition_property(self, data):
        """Every node is in exactly one of {completed, skipped, unreachable, failed}
        after simulation — no overlaps, no missing."""
        nodes, edges, initially_skipped = data
        if not nodes:
            return

        unreachable = propagate_skips(initially_skipped, nodes, edges)

        status = {}
        for node in nodes:
            nid = node['id']
            if nid in initially_skipped:
                status[nid] = 'skipped'
            elif nid in unreachable:
                status[nid] = 'unreachable'
            else:
                status[nid] = 'pending'

        for _ in range(len(nodes) + 1):
            ready = find_ready_nodes(nodes, edges, status)
            if not ready:
                break
            for r in ready:
                status[r] = 'completed'

        node_ids = {n['id'] for n in nodes}
        terminal = {nid for nid, s in status.items() if s in ('completed', 'skipped', 'unreachable')}
        assert terminal == node_ids, (
            f"Non-terminal nodes: {node_ids - terminal}"
        )
