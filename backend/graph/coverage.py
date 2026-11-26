"""
Edge-coverage report: how many edges have a usable empirical beta?

Run:  python -m graph.coverage

An edge is "usable" if its monthly beta passes the simulator's quality gate
(R2, n, sign agrees with the edge direction). Everything else runs on the
flagged fallback guess. Also lists the nodes whose lack of data blocks the most
edges, i.e. where new data series would help most.
"""
import json
from collections import Counter
from pathlib import Path

from data.db import get_conn
from graph.simulator import _load_betas

DATA = Path(__file__).parent.parent / "data"


def main(regime: str = "all") -> None:
    edges = json.load(open(DATA / "edges.json"))
    directions = {(e["source"], e["target"]): e.get("direction") for e in edges}

    conn = get_conn()
    have_data = {r[0] for r in conn.execute("SELECT DISTINCT node_id FROM prices").fetchall()}
    have_data |= {r[0] for r in conn.execute("SELECT DISTINCT series_id FROM macro").fetchall()}
    stat_pairs = {(r[0], r[1]) for r in conn.execute(
        "SELECT DISTINCT source, target FROM edge_stats WHERE freq = 'monthly'").fetchall()}
    conn.close()

    # price node ids are node ids; macro rows are keyed by FRED series id
    from data.ingest import FRED_MAP
    have_nodes = {n for n in have_data} | {n for n, s in FRED_MAP.items() if s in have_data}

    usable = _load_betas(regime, directions)
    n_edges = len(edges)
    n_usable = sum(1 for e in edges if (e["source"], e["target"]) in usable)
    n_stat = sum(1 for e in edges if (e["source"], e["target"]) in stat_pairs)
    n_both = sum(1 for e in edges if e["source"] in have_nodes and e["target"] in have_nodes)

    print(f"Edges total:                  {n_edges}")
    print(f"  data at both ends:          {n_both}  ({n_both / n_edges:.0%})")
    print(f"  have monthly stats:         {n_stat}")
    print(f"  usable beta (passes gate):  {n_usable}  ({n_usable / n_edges:.0%})   [regime={regime}]")
    print(f"  rejected by quality gate:   {n_stat - n_usable}")

    blockers = Counter()
    for e in edges:
        s_ok, t_ok = e["source"] in have_nodes, e["target"] in have_nodes
        if s_ok != t_ok:                       # exactly one end lacks data
            blockers[e["target"] if s_ok else e["source"]] += 1
    print("\nNodes without data blocking the most edges:")
    for node, k in blockers.most_common(12):
        print(f"  {node:36} {k} edges")

    rejected = [(e["source"], e["target"]) for e in edges
                if (e["source"], e["target"]) in stat_pairs
                and (e["source"], e["target"]) not in usable]
    if rejected:
        print("\nRejected by gate (weak fit or sign contradicts the edge direction):")
        for s, t in rejected[:15]:
            print(f"  {s} -> {t}")


if __name__ == "__main__":
    main()