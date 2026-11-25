"""
Counterfactual simulator — propagates a shock from a source node
through the causal graph using empirical betas.

Algorithm:
  BFS from source node, up to max_hops deep.
  At each hop, running_impact *= edge_beta * DAMPEN_PER_HOP.
  Cycle detection: never revisit a node in the current path.
  Beta source: edge_stats, regime-aware (falls back to 'all').
  If no empirical beta exists for an edge, uses direction × FALLBACK_BETA.

Shock input:
  Accepts shock_real (in the node's natural unit: bps for rate nodes,
  % for everything else) and converts to shock_std internally using the
  node's empirical monthly return σ.

Units: the shock is converted to a decimal monthly-style return on the source
(bps nodes via the current level), then multiplied through the betas, so
`impact` / `impact_pct` are real returns of each node, not σ-multiples.
Each result reports fallback_hops: edges on its path with no empirical beta.
"""

from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
import json

from data.db import get_conn

DAMPEN_PER_HOP = 0.8
FALLBACK_BETA  = 0.10
MAX_HOPS       = 10
MIN_IMPACT     = 0.001

# Nodes measured in basis points — everything else in %
BPS_NODES = {"fed_rate", "yield_10y", "yield_2y"}

# Reference examples shown in the UI per unit type
UNIT_EXAMPLES = {
    "bps": [
        {"label": "1 Fed hike",     "value": 25},
        {"label": "2022 pace/qtr",  "value": 75},
        {"label": "Emergency cut",  "value": 50},
    ],
    "%": [
        {"label": "Quiet day",   "value": 0.5},
        {"label": "Normal move", "value": 1.0},
        {"label": "Large move",  "value": 3.0},
        {"label": "Crisis day",  "value": 5.0},
    ],
}


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
    fallback_hops: int = 0


def _load_node_sigmas() -> dict:
    """
    Per-node monthly-return statistics from DuckDB (same return definition
    enrichment.py uses to estimate betas: month-end pct_change).

    Returns {node_id: {
        "sigma":     σ in the node's display unit (bps of level change for
                     rate nodes at the current level; % for everything else),
        "unit":      "bps" | "%",
        "sigma_ret": σ of monthly return as a decimal (what betas operate on),
        "level":     latest level (used to convert bps <-> relative change),
    }}
    """
    import pandas as pd

    conn = get_conn()
    price_rows = conn.execute(
        "SELECT node_id, date, close FROM prices ORDER BY node_id, date"
    ).fetchdf()
    macro_rows = conn.execute(
        "SELECT series_id, date, value AS close FROM macro ORDER BY series_id, date"
    ).fetchdf()
    conn.close()

    FRED_REVERSE = {
        "FEDFUNDS": "fed_rate", "CPIAUCSL": "cpi", "PCEPI": "pce",
        "PAYEMS": "nfp", "UNRATE": "unemployment", "GDP": "gdp",
    }

    sigmas = {}

    def _add(node_id, group):
        idx = pd.to_datetime(group["date"])
        raw = group.set_index(idx)["close"]
        monthly = raw.resample("ME").last().ffill()
        rets = monthly.pct_change().dropna()
        if len(rets) < 12:
            return
        unit      = "bps" if node_id in BPS_NODES else "%"
        sigma_ret = float(rets.std())
        level     = float(monthly.iloc[-1])
        display   = sigma_ret * level * 100 if unit == "bps" else sigma_ret * 100
        sigmas[node_id] = {
            "sigma":     round(display, 4),
            "unit":      unit,
            "sigma_ret": sigma_ret,
            "level":     level,
        }

    for node_id, group in price_rows.groupby("node_id"):
        _add(node_id, group)
    for series_id, group in macro_rows.groupby("series_id"):
        node_id = FRED_REVERSE.get(series_id)
        if node_id:
            _add(node_id, group)

    return sigmas


def get_node_sigmas() -> dict:
    """Public function for the API endpoint."""
    sigmas = _load_node_sigmas()
    # Attach unit examples
    for node_id, data in sigmas.items():
        data["examples"] = UNIT_EXAMPLES[data["unit"]]
    return sigmas


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
    node_id:    str,
    shock_real: float = None,   # shock in natural units (bps or %)
    shock_std:  float = None,   # shock in σ (fallback if shock_real not given)
    regime:     str   = "all",
    max_hops:   int   = MAX_HOPS,
) -> dict:
    """
    Propagate a shock from node_id.

    Accepts either:
      shock_real: value in natural units (bps for rate nodes, % for others)
      shock_std:  value in standard deviations (legacy, used if shock_real absent)

    Returns a dict with metadata + results list sorted by |impact| descending.
    """
    edges  = _load_edges()
    nodes  = _load_nodes()
    betas  = _load_betas(regime)
    sigmas = _load_node_sigmas()

    if node_id not in nodes:
        raise ValueError(f"Unknown node: '{node_id}'")

    # Resolve the shock to a decimal return on the source node.
    # All propagation below happens in return space, because that is the
    # space the betas were estimated in (monthly pct_change on both sides).
    nd        = sigmas.get(node_id)
    unit      = nd["unit"] if nd else "%"
    sigma_val = nd["sigma"] if nd else None

    def _real_to_ret(x):
        if unit == "bps" and nd and nd["level"]:
            return (x / 100.0) / nd["level"]      # bps -> relative change of level
        return x / 100.0                           # % -> decimal

    if shock_real is not None:
        start_ret = _real_to_ret(shock_real)
    elif shock_std is not None and nd:
        start_ret = shock_std * nd["sigma_ret"]
        shock_real = (start_ret * nd["level"] * 100.0) if unit == "bps" else start_ret * 100.0
    else:
        start_ret = nd["sigma_ret"] if nd else 0.01   # default: 1σ
        shock_real = None

    shock_in_std = (start_ret / nd["sigma_ret"]) if nd and nd["sigma_ret"] else None

    # Build adjacency
    adjacency = defaultdict(list)
    for edge in edges:
        adjacency[edge["source"]].append(edge)

    # BFS
    queue = [(node_id, start_ret, 0, [node_id], [], 0)]
    best  = {}

    while queue:
        curr, impact, lag, path, confidences, n_fb = queue.pop(0)

        if len(path) - 1 >= max_hops:
            continue

        for edge in adjacency.get(curr, []):
            nxt = edge["target"]

            if nxt in path:
                continue

            key = (curr, nxt)
            if key in betas:
                beta     = betas[key]["beta"]
                edge_lag = betas[key]["lag_days"]
                fb       = 0
            else:
                beta     = FALLBACK_BETA * edge.get("direction", 1)
                edge_lag = edge.get("lag_days", 5)
                fb       = 1

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
                fallback_hops = n_fb + fb,
            )

            if nxt not in best or abs(new_impact) > abs(best[nxt].impact):
                best[nxt] = result

            queue.append((nxt, new_impact, new_lag, new_path, new_conf, n_fb + fb))

    results = sorted(best.values(), key=lambda r: abs(r.impact), reverse=True)

    return {
        "source":     node_id,
        "shock_real": round(shock_real, 4) if shock_real is not None else None,
        "shock_std":  round(shock_in_std, 4) if shock_in_std is not None else None,
        "unit":       unit,
        "sigma":      sigma_val,
        "regime":     regime,
        "affected":   len(results),
        "results": [
            {
                "node_id":    r.node_id,
                "label":      r.label,
                "impact":     r.impact,
                "impact_pct": round(r.impact * 100, 3),   # true % return of the node
                "fallback_hops": r.fallback_hops,
                "empirical":     r.fallback_hops == 0,
                "lag_days":   r.lag_days,
                "path":       r.path,
                "confidence": r.confidence,
                "n_hops":     r.n_hops,
                "via":        r.via,
            }
            for r in results
        ],
    }


if __name__ == "__main__":
    result = simulate_shock("fed_rate", shock_real=25, regime="all")
    print(f"\nShock: fed_rate +25bps ({result['shock_std']:.2f}σ) "
          f"— {result['affected']} nodes affected\n")
    for r in result["results"][:10]:
        print(f"  {r['label']:25} {r['impact_pct']:+.2f}%  "
              f"lag={r['lag_days']}d  hops={r['n_hops']}  via={r['via']}")
        