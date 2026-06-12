import networkx as nx
from graph.loader import G, EVENTS


def get_all_nodes() -> list[dict]:
    """Return all nodes with their attributes."""
    return [{"id": n, **G.nodes[n]} for n in G.nodes]


def get_all_edges() -> list[dict]:
    """Return all edges with their attributes."""
    return [
        {"source": u, "target": v, **G.edges[u, v]}
        for u, v in G.edges
    ]


def get_node(node_id: str) -> dict | None:
    """Return a single node by ID, or None if not found."""
    if node_id not in G.nodes:
        return None
    return {"id": node_id, **G.nodes[node_id]}


def find_paths(source: str, target: str, max_paths: int = 5) -> list[dict]:
    """
    Find all simple paths between two nodes.
    Returns paths sorted by total lag (fastest first).
    """
    if source not in G.nodes:
        raise ValueError(f"Unknown source node: '{source}'")
    if target not in G.nodes:
        raise ValueError(f"Unknown target node: '{target}'")

    try:
        raw_paths = list(nx.all_simple_paths(G, source, target, cutoff=6))
    except nx.NetworkXNoPath:
        return []

    results = []
    for path in raw_paths:
        edges = []
        total_lag = 0
        total_confidence = 0
        net_direction = 1

        for i in range(len(path) - 1):
            u, v = path[i], path[i + 1]
            edge = G.edges[u, v]
            edges.append({
                "source": u,
                "target": v,
                **edge
            })
            total_lag += edge.get("lag_days", 0)
            total_confidence += edge.get("confidence", 1)
            net_direction *= edge.get("direction", 1)

        results.append({
            "path": path,
            "edges": edges,
            "total_lag_days": total_lag,
            "net_direction": net_direction,
            "avg_confidence": round(total_confidence / len(edges), 2),
            "hop_count": len(edges)
        })

    results.sort(key=lambda x: x["total_lag_days"])
    return results[:max_paths]


def get_neighbours(node_id: str) -> dict:
    """Return immediate upstream and downstream neighbours of a node."""
    if node_id not in G.nodes:
        raise ValueError(f"Unknown node: '{node_id}'")

    upstream = []
    for u in G.predecessors(node_id):
        edge = G.edges[u, node_id]
        upstream.append({"id": u, **G.nodes[u], "edge": edge})

    downstream = []
    for v in G.successors(node_id):
        edge = G.edges[node_id, v]
        downstream.append({"id": v, **G.nodes[v], "edge": edge})

    return {"upstream": upstream, "downstream": downstream}


def get_most_connected_nodes(top_n: int = 10) -> list[dict]:
    """Return the most connected nodes by total degree (in + out)."""
    degree = dict(G.degree())
    sorted_nodes = sorted(degree.items(), key=lambda x: x[1], reverse=True)

    return [
        {
            "id": node_id,
            **G.nodes[node_id],
            "degree": deg,
            "in_degree": G.in_degree(node_id),
            "out_degree": G.out_degree(node_id)
        }
        for node_id, deg in sorted_nodes[:top_n]
    ]


def get_events() -> list[dict]:
    """Return all historical events — reads from disk each time."""
    from data.db import get_conn
    from pathlib import Path
    import json
    events_path = Path(__file__).parent.parent / "data" / "events.json"
    with open(events_path) as f:
        return json.load(f)


def get_event(event_id: str) -> dict | None:
    """Return a single event by ID."""
    return next((e for e in get_events() if e["id"] == event_id), None)