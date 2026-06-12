import json
import networkx as nx
from pathlib import Path

DATA_DIR = Path(__file__).parent.parent / "data"


def load_graph() -> nx.DiGraph:
    """Load nodes and edges from JSON files into a NetworkX directed graph."""
    with open(DATA_DIR / "nodes.json") as f:
        nodes = json.load(f)
    with open(DATA_DIR / "edges.json") as f:
        edges = json.load(f)

    G = nx.DiGraph()

    for node in nodes:
        G.add_node(node["id"], **node)

    for edge in edges:
        G.add_edge(
            edge["source"],
            edge["target"],
            **{k: v for k, v in edge.items() if k not in ("source", "target")}
        )

    return G


def load_events() -> list[dict]:
    """Load one-off events from JSON."""
    with open(DATA_DIR / "events.json") as f:
        return json.load(f)


# Single shared instance — import this everywhere
G = load_graph()
EVENTS = load_events()