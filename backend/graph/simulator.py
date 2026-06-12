"""
Counterfactual simulator — propagates a shock from a source node
through the causal graph using empirical betas.

Algorithm:
  BFS from source node, up to max_hops deep.
  At each hop, running_impact *= edge_beta * DAMPEN_PER_HOP.
  Cycle detection: never revisit a node in the current path.
  Beta source: edge_stats, regime-aware (falls back to 'all').
  If no empirical beta exists for an edge, uses direction × FALLBACK_BETA.

Returns a list of ImpactResult dicts sorted by |impact| descending.
"""

from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
import json

from data.db import get_conn

DAMPEN_PER_HOP = 0.8    # impact decays 20% per hop
FALLBACK_BETA  = 0.10   # used when no empirical beta exists
MAX_HOPS       = 10     # hard ceiling
MIN_IMPACT     = 0.001  # prune paths below this |impact|


@dataclass
class ImpactResult:
    node_id:    str
    label:      str
    impact:     float
    lag_days:   int
    path:       list
    confidence: float
    n_hops:     int
    via:        str


def _load_betas(regime: str) -> dict:
    """
    Load best beta per (source, target) from edge_stats.
    Prefers given regime; falls back to 'all'.
    """
    conn = get_conn()
    rows = conn.execute("""
        SELECT source, target, regime, beta, lag_days, r_squared
        FROM edge_stats
        WHERE regime IN (?, 'all')
        ORDER BY
            CASE WHEN regime = ? THEN 0 ELSE 1 END,
            r_squared DESC
    """, [regime, regime]).fetchdf()
    conn.close()

    betas = {}
    for _, row in rows.iterrows():
        key = (row["source"], row["target"])
        if key not in betas:
            betas[key] = {
                "beta":     float(row["beta"]),
                "lag_days": int(row["lag_days"]),
                "regime":   row["regime"],
            }
    return betas


def _load_edges() -> list:
    path = Path(__file__).parent.parent / "data" / "edges.json"
    with open(path) as f:
        return json.load(f)


def _load_nodes() -> dict:
    path = Path(__file__).parent.parent / "data" / "nodes.json"
    with open(path) as f:
        return {n["id"]: n for n in json.load(f)}


def simulate_shock(
    node_id:   str,
    shock_std: float = 1.0,
    regime:    str   = "all",
    max_hops:  int   = MAX_HOPS,
) -> list:
    """
    Propagate a shock of shock_std standard deviations from node_id.
    Returns impact dicts sorted by |impact| descending.
    """
    edges  = _load_edges()
    nodes  = _load_nodes()
    betas  = _load_betas(regime)

    if node_id not in nodes:
        raise ValueError(f"Unknown node: '{node_id}'")

    # Build adjacency
    adjacency = defaultdict(list)
    for edge in edges:
        adjacency[edge["source"]].append(edge)

    # BFS: (curr_node, running_impact, running_lag, path, confidences)
    queue = [(node_id, shock_std, 0, [node_id], [])]
    best  = {}   # node_id -> ImpactResult (highest |impact| path)

    while queue:
        curr, impact, lag, path, confidences = queue.pop(0)

        if len(path) - 1 >= max_hops:
            continue

        for edge in adjacency.get(curr, []):
            nxt = edge["target"]

            if nxt in path:   # cycle guard
                continue

            key = (curr, nxt)
            if key in betas:
                beta     = betas[key]["beta"]
                edge_lag = betas[key]["lag_days"]
            else:
                beta     = FALLBACK_BETA * edge.get("direction", 1)
                edge_lag = edge.get("lag_days", 5)

            new_impact = impact * beta * DAMPEN_PER_HOP
            new_lag    = lag + edge_lag
            new_conf   = confidences + [edge.get("confidence", 1)]
            new_path   = path + [nxt]

            if abs(new_impact) < MIN_IMPACT:
                continue

            node_info = nodes.get(nxt, {})
            result = ImpactResult(
                node_id    = nxt,
                label      = node_info.get("label", nxt),
                impact     = round(new_impact, 6),
                lag_days   = new_lag,
                path       = new_path,
                confidence = round(sum(new_conf) / len(new_conf), 2),
                n_hops     = len(new_path) - 1,
                via        = curr,
            )

            if nxt not in best or abs(new_impact) > abs(best[nxt].impact):
                best[nxt] = result

            queue.append((nxt, new_impact, new_lag, new_path, new_conf))

    results = sorted(best.values(), key=lambda r: abs(r.impact), reverse=True)

    return [
        {
            "node_id":    r.node_id,
            "label":      r.label,
            "impact":     r.impact,
            "impact_pct": round(r.impact * 100, 3),
            "lag_days":   r.lag_days,
            "path":       r.path,
            "confidence": r.confidence,
            "n_hops":     r.n_hops,
            "via":        r.via,
        }
        for r in results
    ]


if __name__ == "__main__":
    results = simulate_shock("fed_rate", shock_std=1.0, regime="all")
    print(f"\nShock: fed_rate +1σ — {len(results)} nodes affected\n")
    for r in results[:10]:
        print(f"  {r['label']:25} {r['impact_pct']:+.2f}%  "
              f"lag={r['lag_days']}d  hops={r['n_hops']}  "
              f"via={r['via']}")
