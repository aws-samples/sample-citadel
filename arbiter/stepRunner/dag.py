"""DAG module — pure functions for workflow graph operations.

Provides topological sorting, root/convergence node detection,
ready-node resolution, and downstream subgraph traversal.
All functions are pure (no side effects, no AWS calls).
"""

from collections import deque


def topological_sort(nodes: list[dict], edges: list[dict]) -> list[str]:
    """Kahn's algorithm. Returns ordered node IDs. Raises ValueError on cycle."""
    node_ids = [n['id'] for n in nodes]

    # Build adjacency list and in-degree map
    in_degree = {nid: 0 for nid in node_ids}
    adjacency = {nid: [] for nid in node_ids}

    for edge in edges:
        src, tgt = edge['source'], edge['target']
        adjacency[src].append(tgt)
        in_degree[tgt] += 1

    # Start with all nodes that have in-degree 0
    queue = deque(nid for nid in node_ids if in_degree[nid] == 0)
    result = []

    while queue:
        node = queue.popleft()
        result.append(node)
        for neighbor in adjacency[node]:
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                queue.append(neighbor)

    if len(result) != len(node_ids):
        raise ValueError("Graph contains a cycle — topological sort not possible")

    return result


def find_root_nodes(nodes: list[dict], edges: list[dict]) -> list[str]:
    """Nodes with in-degree 0 — execution entry points."""
    targets = {e['target'] for e in edges}
    return [n['id'] for n in nodes if n['id'] not in targets]


def find_ready_nodes(nodes: list[dict], edges: list[dict], node_results: dict) -> list[str]:
    """Nodes whose all predecessors are completed or skipped, and node itself is pending."""
    # Build predecessor map
    predecessors = {}
    for edge in edges:
        predecessors.setdefault(edge['target'], set()).add(edge['source'])

    ready = []
    for node in nodes:
        nid = node['id']
        # Only pending nodes can become ready
        if node_results.get(nid) != 'pending':
            continue
        # Check all predecessors are completed or skipped
        preds = predecessors.get(nid, set())
        if all(node_results.get(p) in ('completed', 'skipped') for p in preds):
            ready.append(nid)

    return ready


def find_convergence_nodes(nodes: list[dict], edges: list[dict]) -> list[str]:
    """Nodes with in-degree > 1 — require barrier synchronization."""
    in_degree = {}
    for edge in edges:
        tgt = edge['target']
        in_degree[tgt] = in_degree.get(tgt, 0) + 1

    return [n['id'] for n in nodes if in_degree.get(n['id'], 0) > 1]


def find_downstream_subgraph(node_id: str, edges: list[dict]) -> set[str]:
    """All nodes reachable from node_id via outgoing edges (BFS)."""
    # Build adjacency list
    adjacency = {}
    for edge in edges:
        adjacency.setdefault(edge['source'], []).append(edge['target'])

    visited = set()
    queue = deque(adjacency.get(node_id, []))

    while queue:
        current = queue.popleft()
        if current in visited:
            continue
        visited.add(current)
        for neighbor in adjacency.get(current, []):
            if neighbor not in visited:
                queue.append(neighbor)

    return visited
