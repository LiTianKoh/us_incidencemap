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

Units: the shock is converted to the source's native change (decimal return, or
percentage points for rate nodes), then multiplied through the betas, which were
estimated in the same native units. `impact_pct` is therefore in each node's own
unit: % for ordinary nodes, bps for rate nodes (see each result's "unit").
Betas must pass a quality gate (R2, n, sign vs edge direction) or the flagged
fallback is used.
Each result carries a `reliability` tier (direct / chained / guess). DAMPEN_PER_HOP
is a heuristic: walk-forward tests on multi-hop chains found no out-of-sample skill
for any damping value (0.8^(h-1), 1.0 or fitted), so it is not tuned.
Each result reports fallback_hops: edges on its path with no empirical beta.
"""

from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
import json

from data.db import get_conn
from graph.enrichment import RATE_NODES

DAMPEN_PER_HOP = 0.8
FALLBACK_BETA  = 0.10
MAX_HOPS       = 10
MIN_IMPACT     = 0.001

# Nodes measured in basis points — everything else in %
BPS_NODES = RATE_NODES

# An empirical beta is only trusted if it clears these bars AND its sign agrees
# with the edge direction; otherwise the flagged fallback guess is used.
MIN_BETA_R2 = 0.02
MIN_BETA_N  = 20

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
        "sigma_native": σ of monthly change in native units (decimal return, or
                     percentage points for rate nodes) — what betas operate on,
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

    from data.ingest import FRED_MAP          # node_id -> FRED series
    FRED_REVERSE = {series: node for node, series in FRED_MAP.items()}

    sigmas = {}

    def _add(node_id, group):
        idx = pd.to_datetime(group["date"])
        raw = group.set_index(idx)["close"]
        monthly = raw.resample("ME").last().ffill()
        is_rate = node_id in BPS_NODES
        chg = (monthly.diff() if is_rate else monthly.pct_change()).dropna()
        if len(chg) < 12:
            return
        sigma_native = float(chg.std())          # pp for rate nodes, decimal return otherwise
        sigmas[node_id] = {
            "sigma":        round(sigma_native * 100, 4),   # bps or %
            "unit":         "bps" if is_rate else "%",
            "sigma_native": sigma_native,
            "level":        float(monthly.iloc[-1]),
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


def _load_betas(regime: str, directions: dict) -> dict:
    """
    Best usable monthly beta per (source, target).
    Candidates: the requested regime first, then 'all'; within each, highest R².
    A candidate is usable only if R² >= MIN_BETA_R2, n >= MIN_BETA_N and its sign
    matches the edge's stated direction. Monthly only, so betas share the return
    definition used for sigma and the shock conversion.
    """
    conn = get_conn()
    rows = conn.execute("""
        SELECT source, target, regime, beta, lag_days, r_squared, n_obs
        FROM edge_stats
        WHERE freq = 'monthly' AND regime IN (?, 'all')
        ORDER BY
            CASE WHEN regime = ? THEN 0 ELSE 1 END,
            r_squared DESC
    """, [regime, regime]).fetchdf()
    conn.close()

    betas = {}
    for _, row in rows.iterrows():
        key = (row["source"], row["target"])
        if key in betas:
            continue
        beta = float(row["beta"])
        want = directions.get(key)
        if float(row["r_squared"]) < MIN_BETA_R2 or int(row["n_obs"]) < MIN_BETA_N:
            continue
        if want is not None and beta * want <= 0:
            continue
        betas[key] = {
            "beta":     beta,
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
    betas:      dict  = None,   # inject point-in-time betas (backtesting)
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
    directions = {(e["source"], e["target"]): e.get("direction") for e in edges}
    # `betas` may be injected (e.g. point-in-time betas for backtesting)
    if betas is None:
        betas = _load_betas(regime, directions)
    sigmas = _load_node_sigmas()

    if node_id not in nodes:
        raise ValueError(f"Unknown node: '{node_id}'")

    # Resolve the shock to a change in the source's NATIVE units: a decimal
    # return for ordinary nodes, percentage points for rate nodes. Betas were
    # estimated in these units, so propagation stays unit-consistent.
    # (bps / 100 = pp ; % / 100 = decimal — the same arithmetic.)
    nd        = sigmas.get(node_id)
    unit      = nd["unit"] if nd else "%"
    sigma_val = nd["sigma"] if nd else None

    if shock_real is not None:
        start = shock_real / 100.0
    elif shock_std is not None and nd:
        start = shock_std * nd["sigma_native"]
        shock_real = start * 100.0
    else:
        start = nd["sigma_native"] if nd else 0.01   # default: 1σ
        shock_real = None

    shock_in_std = (start / nd["sigma_native"]) if nd and nd["sigma_native"] else None
    start_ret = start

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
                "impact_pct": round(r.impact * 100, 3),   # in the node's own unit: % or bps (see "unit")
                "unit":          "bps" if r.node_id in BPS_NODES else "%",
                "fallback_hops": r.fallback_hops,
                "empirical":     r.fallback_hops == 0,
                # direct: one measured edge (backtest-supported);
                # chained: 2+ measured edges — walk-forward tests show no
                #          out-of-sample skill, so treat as indicative only;
                # guess: at least one edge uses the default fallback.
                "reliability":   ("guess" if r.fallback_hops else
                                  "direct" if r.n_hops == 1 else "chained"),
                "lag_days":   r.lag_days,
                "path":       r.path,
                "confidence": r.confidence,
                "n_hops":     r.n_hops,
                "via":        r.via,
            }
            for r in results
        ],
    }


def simulate_scenario(
    shocks:   list,             # [{"node_id", "shock_real"|"shock_std"}, ...] applied together
    regime:   str = "all",
    max_hops: int = MAX_HOPS,
    betas:    dict = None,
) -> dict:
    """
    Several simultaneous shocks. Betas are linear, so each shock is propagated on
    its own and the effects are ADDED per node (superposition). Every node reports
    its per-shock contributions, so a combined move can be traced back to its causes.

    Each shock is an extra, independent move: if you shock oil +10% and the Fed +50bps
    and the Fed also moves oil in the graph, oil's total = your +10% plus the Fed's
    modelled effect. `linked_shocks` lists any shock source that another shock reaches,
    so that overlap is visible rather than hidden.
    """
    if not shocks:
        raise ValueError("at least one shock is required")
    edges = _load_edges()
    directions = {(e["source"], e["target"]): e.get("direction") for e in edges}
    if betas is None:
        betas = _load_betas(regime, directions)
    nodes = _load_nodes()

    sims, seen = [], set()
    for sh in shocks:
        nid = sh.get("node_id")
        if nid in seen:
            raise ValueError(f"Duplicate shock on '{nid}' — combine them into one")
        seen.add(nid)
        sims.append(simulate_shock(nid, shock_real=sh.get("shock_real"),
                                   shock_std=sh.get("shock_std"),
                                   regime=regime, max_hops=max_hops, betas=betas))

    contribs = defaultdict(list)       # node_id -> [contribution, ...]
    linked = []
    for sim in sims:
        src = sim["source"]
        if sim["shock_real"] is not None:   # the shock itself, on its own node
            own = sim["shock_real"] / 100.0
            contribs[src].append({"source": src, "impact": own, "path": [src], "n_hops": 0,
                                  "empirical": True, "fallback_hops": 0, "lag_days": 0})
        for r in sim["results"]:
            contribs[r["node_id"]].append({
                "source": src, "impact": r["impact"], "path": r["path"],
                "n_hops": r["n_hops"], "empirical": r["empirical"],
                "fallback_hops": r["fallback_hops"], "lag_days": r["lag_days"]})
            if r["node_id"] in seen and r["node_id"] != src:
                linked.append({"from": src, "to": r["node_id"]})

    results = []
    for nid, cs in contribs.items():
        total = sum(c["impact"] for c in cs)
        dom = max(cs, key=lambda c: abs(c["impact"]))
        fb = max(c["fallback_hops"] for c in cs)
        results.append({
            "node_id":    nid,
            "label":      nodes.get(nid, {}).get("label", nid),
            "impact":     round(total, 6),
            "impact_pct": round(total * 100, 3),
            "unit":       "bps" if nid in BPS_NODES else "%",
            "empirical":  all(c["empirical"] for c in cs),
            "fallback_hops": fb,
            "reliability": ("guess" if any(c["fallback_hops"] for c in cs) else
                            "direct" if dom["n_hops"] <= 1 else "chained"),
            "lag_days":   max(c["lag_days"] for c in cs),
            "path":       dom["path"],
            "n_hops":     dom["n_hops"],
            "via":        dom["path"][-2] if len(dom["path"]) > 1 else nid,
            "confidence": 1,
            "contributions": [
                {"source": c["source"], "impact_pct": round(c["impact"] * 100, 3),
                 "n_hops": c["n_hops"], "path": c["path"], "empirical": c["empirical"]}
                for c in sorted(cs, key=lambda c: -abs(c["impact"]))],
        })
    results.sort(key=lambda r: abs(r["impact"]), reverse=True)

    return {
        "shocks": [{"node_id": x["source"], "shock_real": x["shock_real"], "unit": x["unit"]}
                   for x in sims],
        "regime": regime, "affected": len(results), "linked_shocks": linked,
        "results": results,
    }


if __name__ == "__main__":
    result = simulate_shock("fed_rate", shock_real=25, regime="all")
    print(f"\nShock: fed_rate +25bps ({result['shock_std']:.2f}σ) "
          f"— {result['affected']} nodes affected\n")
    for r in result["results"][:10]:
        print(f"  {r['label']:25} {r['impact_pct']:+.2f}%  "
              f"lag={r['lag_days']}d  hops={r['n_hops']}  via={r['via']}")