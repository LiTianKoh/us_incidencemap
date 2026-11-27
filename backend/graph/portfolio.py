"""
Portfolio shock P&L — apply a simulator shock to a set of holdings.

Each holding maps to a graph node (via data/ticker_map.json or an explicit `node`
override). Equity-like holdings take the node's simulated return. Bond holdings
carry a duration and take  P&L% = -duration * (change in yield, as a decimal).

Every holding reports the causal path that drives it and whether that path rests
entirely on empirical betas; `est_share` is the share of gross P&L resting on
fallback guesses. Holdings with no mapping or no causal path are reported, never
silently dropped.
"""
import json
from pathlib import Path

from graph.simulator import simulate_shock, BPS_NODES

TICKER_MAP_PATH = Path(__file__).parent.parent / "data" / "ticker_map.json"


def load_ticker_map() -> dict:
    with open(TICKER_MAP_PATH) as f:
        return json.load(f)


def portfolio_shock(
    holdings:   list,
    node_id:    str,
    shock_real: float = None,
    shock_std:  float = None,
    regime:     str   = "all",
    max_hops:   int   = 10,
) -> dict:
    tmap = load_ticker_map()
    sim  = simulate_shock(node_id, shock_real=shock_real, shock_std=shock_std,
                          regime=regime, max_hops=max_hops)
    impacts = {r["node_id"]: r for r in sim["results"]}

    # The shocked node itself, in native units (decimal return, or pp for rate nodes)
    src_native = sim["shock_real"] / 100.0 if sim["shock_real"] is not None else None

    rows, unmapped = [], []
    for h in holdings:
        ticker = str(h.get("ticker", "")).strip().upper()
        try:
            value = float(h.get("value"))
        except (TypeError, ValueError):
            unmapped.append({"ticker": ticker, "value": h.get("value"), "reason": "invalid value"})
            continue

        m = {**tmap.get(ticker, {})}
        if h.get("node"):
            m["node"] = h["node"]
        if h.get("duration") is not None:
            m["duration"] = float(h["duration"])
        node = m.get("node")
        if not node:
            unmapped.append({"ticker": ticker, "value": value, "reason": "no node mapping"})
            continue

        row = {"ticker": ticker, "value": value, "node": node,
               "duration": m.get("duration"), "status": "ok",
               "impact_native": None, "pnl_pct": 0.0, "pnl": 0.0,
               "path": [], "empirical": True, "fallback_hops": 0, "lag_days": 0}

        if node == node_id:
            native, row["path"] = src_native, [node]
        elif node in impacts:
            r = impacts[node]
            native = r["impact"]
            row.update(path=r["path"], empirical=r["empirical"],
                       fallback_hops=r["fallback_hops"], lag_days=r["lag_days"])
        else:
            row["status"] = "no_path"            # shock never reaches this node
            rows.append(row)
            continue

        row["impact_native"] = native
        if native is None:
            row["status"] = "no_shock_size"
        elif node in BPS_NODES:
            if row["duration"] is None:
                row["status"] = "needs_duration"
            else:
                row["pnl_pct"] = -row["duration"] * native / 100.0   # native is pp
        else:
            row["pnl_pct"] = native
        row["pnl"] = value * row["pnl_pct"]
        rows.append(row)

    rows.sort(key=lambda r: abs(r["pnl"]), reverse=True)
    total_value = sum(abs(r["value"]) for r in rows)
    total_pnl   = sum(r["pnl"] for r in rows)
    gross       = sum(abs(r["pnl"]) for r in rows)
    est_gross   = sum(abs(r["pnl"]) for r in rows if not r["empirical"])

    return {
        "source": node_id, "shock_real": sim["shock_real"], "shock_std": sim["shock_std"],
        "unit": sim["unit"], "regime": regime,
        "total_value": total_value,
        "total_pnl":   total_pnl,
        "total_pnl_pct": (total_pnl / total_value) if total_value else None,
        "est_share":   (est_gross / gross) if gross else None,
        "holdings":    rows,
        "unmapped":    unmapped,
    }