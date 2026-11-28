"""
Reverse stress test — instead of "what does this shock cost me?", ask
"what would it take to lose X%?".

For every node with market data, the portfolio's P&L response to that node is
measured with a probe shock (PROBE_SD standard deviations) and scaled linearly
(betas are linear, so P&L per σ is constant unless the 0.001 impact floor bites).
From that:
  - required shock: the move in that node that produces the target loss,
    in its own unit and in σ of monthly moves (the plausibility yardstick);
  - loss_at_3sd: the worst loss a 3σ move in that node could cause either way,
    so the most dangerous nodes show up even when no plausible shock hits the target.

Target losses are approximate (~±5%): the simulator drops impacts under 0.001.
Everything inherits the simulator's limits: only paths up to `max_hops` and only
holdings that map to a node with a modelled path can lose money here — an
unmodelled holding is reported, never assumed safe.
"""
from graph.simulator import (_load_edges, _load_betas, _load_node_sigmas, BPS_NODES)
from graph.portfolio import portfolio_shock, load_ticker_map

PROBE_SD   = 2.0
SEVERE_SD  = 2.0     # |required| <= this: plausible in a month
EXTREME_SD = 3.5     # beyond this: extreme


def _plausibility(sd: float) -> str:
    a = abs(sd)
    return "plausible" if a <= SEVERE_SD else "severe" if a <= EXTREME_SD else "extreme"


def reverse_stress(holdings: list, target_loss_pct: float, regime: str = "all",
                   max_hops: int = 2, top_n: int = 15) -> dict:
    if target_loss_pct <= 0:
        raise ValueError("target_loss_pct must be a positive number (e.g. 5 for a 5% loss)")
    edges  = _load_edges()
    dirs   = {(e["source"], e["target"]): e.get("direction") for e in edges}
    betas  = _load_betas(regime, dirs)
    sigmas = _load_node_sigmas()
    labels = {}
    try:
        from graph.simulator import _load_nodes
        labels = {k: v.get("label", k) for k, v in _load_nodes().items()}
    except Exception:
        pass

    rows, total_value, unmodelled = [], None, None
    for node_id, nd in sigmas.items():
        if not nd.get("sigma_native"):
            continue
        res = portfolio_shock(holdings, node_id, shock_std=PROBE_SD, regime=regime,
                              max_hops=max_hops, sigmas=sigmas, betas=betas)
        if total_value is None:
            total_value = res["total_value"]
            unmodelled = ([h["ticker"] for h in res["holdings"] if h["status"] != "ok"]
                          + [u["ticker"] for u in res["unmapped"]])
        if not total_value or res["total_pnl"] == 0:
            continue
        per_sd  = res["total_pnl"] / PROBE_SD                  # USD per 1σ
        target  = target_loss_pct / 100.0 * total_value         # USD loss to reach
        need_sd = -target / per_sd                              # signed σ that produces it
        need    = need_sd * nd["sigma"]                         # display unit (% or bps)
        drivers = sorted((h for h in res["holdings"] if h["pnl"]),
                         key=lambda h: -abs(h["pnl"]))[:3]
        reachable = not (nd["unit"] == "%" and need <= -100.0)   # a price cannot fall >100%
        rows.append({
            "reachable": reachable,
            "node_id": node_id, "label": labels.get(node_id, node_id),
            "unit": nd["unit"], "sigma": nd["sigma"],
            "required_shock": round(need, 3), "required_sd": round(need_sd, 2),
            "direction": "down" if need_sd < 0 else "up",
            "plausibility": _plausibility(need_sd),
            "loss_pct_at_3sd": round(-abs(per_sd) * 3 / total_value * 100, 2),
            "pnl_per_sd_pct": round(per_sd / total_value * 100, 3),
            "empirical_share": None if res["est_share"] is None else round(1 - res["est_share"], 2),
            "drivers": [{"ticker": h["ticker"], "pnl": round(h["pnl"])} for h in drivers],
        })

    rows.sort(key=lambda r: abs(r["required_sd"]))
    unreachable = [r for r in rows if not r["reachable"]]
    rows_ok = [r for r in rows if r["reachable"]]
    worst = sorted(rows, key=lambda r: r["loss_pct_at_3sd"])[:top_n]
    return {
        "target_loss_pct": target_loss_pct, "regime": regime, "max_hops": max_hops,
        "total_value": total_value, "probe_sd": PROBE_SD,
        "nodes_tested": len(rows),
        "unmodelled_tickers": sorted(set(unmodelled or [])),
        "nodes_unreachable": len(unreachable),   # would need a >100% fall: no single move gets there
        "easiest": rows_ok[:top_n],           # smallest shock (in σ) that reaches the target
        "most_dangerous": worst,           # biggest loss from a 3σ move
    }
