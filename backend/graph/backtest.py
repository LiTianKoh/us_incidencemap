"""
Walk-forward backtest — does the causal map's empirical layer hold up out of sample?

Everything is estimated point-in-time: a month's prediction only uses betas
fitted on months strictly before it. Two tests:

1. EDGE-LEVEL  (walk_forward_edges)
   For every edge with data at both ends, expand the training window month by
   month (after MIN_TRAIN months), fit beta on the past, and predict the target's
   change from the source's change that month. Reported per edge:
     oos_r2       R² vs. predicting the target's expanding historical mean (>0 = skill)
     hit_rate     share of months where the predicted sign was right
     hit_z        z-score of the hit rate vs. a coin flip
     hit_big      hit rate in months with a large source move (top quartile)
     beta_flips   times the fitted beta changed sign (instability)
     sign_ok      median beta sign agrees with the edge's stated direction
     regime_lift  oos_r2 with regime-matched betas minus oos_r2 with all-history
                  betas — does the regime layer add out-of-sample value?
   Verdict: validated / weak / fails.

   Note: the source's same-month move is treated as known (lag 0) — this tests the
   conditional "if the source moves by x, how far does the target move", which is
   exactly what the simulator assumes. It is not a forecast of the source.

2. EPISODE-LEVEL  (backtest_episode)
   Replay a real episode through the FULL multi-hop simulator, using only betas
   estimated through the month before it began, and compare each downstream
   node's predicted move to what actually happened. Reported: sign hit rate
   overall and by hop depth, rank/linear correlation, and the typical
   predicted-to-realised scale.

Run:  python -m graph.backtest        (writes data/backtest_results.json)
"""

import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from graph.enrichment import _load_series, _changes, RATE_NODES
from graph.regimes import get_regime_dates
from graph.simulator import (
    simulate_shock, MIN_BETA_R2, MIN_BETA_N,
)

DATA_DIR    = Path(__file__).parent.parent / "data"
RESULT_PATH = DATA_DIR / "backtest_results.json"

MIN_TRAIN        = 60     # months of history before the first prediction
MIN_OOS          = 36     # out-of-sample months needed to give a verdict
MIN_REGIME_TRAIN = 20     # same-regime months needed to use a regime beta
HIT_Z_CUTOFF     = 1.645  # one-sided 5% vs. a coin flip
R2_CUTOFF        = 0.02

# Episodes: (name, source node, first month, last month) — month-end windows.
EPISODES = [
    ("Global financial crisis panic", "vix",       "2008-09", "2008-10"),
    ("2018 Q4 equity selloff",        "vix",       "2018-10", "2018-12"),
    ("COVID crash",                   "vix",       "2020-02", "2020-03"),
    ("2022 rate-hiking cycle",        "yield_2y",  "2022-03", "2022-12"),
    ("2022 long-end yield surge",     "yield_10y", "2022-01", "2022-10"),
    ("2023 banking stress (SVB)",     "yield_2y",  "2023-03", "2023-03"),
]


# ── Data helpers ─────────────────────────────────────────────────────────────

_cache = {}


def _monthly(node_id: str):
    """Month-end changes in native units (pp for rate nodes, decimal return else)."""
    if node_id not in _cache:
        raw = _load_series(node_id)
        _cache[node_id] = None if raw is None else _changes(raw, node_id, "ME")
    return _cache[node_id]


def _pair(source: str, target: str, lag_days: int):
    """Aligned (x_lagged, y) monthly frame, or None if either series is missing."""
    s, t = _monthly(source), _monthly(target)
    if s is None or t is None:
        return None
    lag_months = round((lag_days or 0) / 21)
    df = pd.concat([s, t], axis=1, join="inner").dropna()
    df.columns = ["x", "y"]
    df["x"] = df["x"].shift(lag_months)
    return df.dropna()


def _beta(x: np.ndarray, y: np.ndarray):
    v = float(np.var(x))
    return float(np.cov(x, y)[0, 1] / v) if len(x) > 2 and v > 0 else None


def _load_edges():
    """edges.json, de-duplicated by (source, target) so a repeated edge isn't counted twice."""
    seen, out = set(), []
    for e in json.load(open(DATA_DIR / "edges.json")):
        key = (e["source"], e["target"])
        if key not in seen:
            seen.add(key)
            out.append(e)
    return out


# ── 1. Edge-level walk-forward ───────────────────────────────────────────────

def _walk_forward_one(df: pd.DataFrame, labels: pd.Series) -> dict | None:
    x, y = df["x"].values, df["y"].values
    idx  = df.index
    reg  = labels.reindex(idx).values
    n    = len(df)
    if n < MIN_TRAIN + MIN_OOS:
        return None

    pred, pred_reg, real, bench, betas, big, used_reg = [], [], [], [], [], [], []
    for i in range(MIN_TRAIN, n):
        xt, yt = x[:i], y[:i]
        b = _beta(xt, yt)
        if b is None:
            continue
        # regime-matched beta (falls back to the all-history beta)
        b_reg, fell_back = b, True
        if reg[i] is not None and not (isinstance(reg[i], float) and math.isnan(reg[i])):
            m = reg[:i] == reg[i]
            if m.sum() >= MIN_REGIME_TRAIN:
                br = _beta(xt[m], yt[m])
                if br is not None:
                    b_reg, fell_back = br, False
        thr = np.percentile(np.abs(xt), 75)
        pred.append(b * x[i])
        pred_reg.append(b_reg * x[i])
        real.append(y[i])
        bench.append(float(np.mean(yt)))
        betas.append(b)
        big.append(abs(x[i]) >= thr and thr > 0)
        used_reg.append(not fell_back)

    if len(real) < MIN_OOS:
        return None
    pred, pred_reg, real, bench = map(np.array, (pred, pred_reg, real, bench))
    betas, big = np.array(betas), np.array(big)

    def r2(p):
        denom = float(np.sum((real - bench) ** 2))
        return 1.0 - float(np.sum((real - p) ** 2)) / denom if denom > 0 else float("nan")

    nz = pred != 0
    hits = (np.sign(pred[nz]) == np.sign(real[nz]))
    n_h = int(nz.sum())
    hit_rate = float(hits.mean()) if n_h else float("nan")
    hit_z = (hits.sum() - n_h / 2) / math.sqrt(n_h / 4) if n_h else 0.0

    bm = big & nz
    hit_big = float((np.sign(pred[bm]) == np.sign(real[bm])).mean()) if bm.sum() >= 8 else None

    signs = np.sign(betas)
    flips = int(np.sum(signs[1:] != signs[:-1]))
    corr = float(np.corrcoef(pred, real)[0, 1]) if np.std(pred) > 0 and np.std(real) > 0 else float("nan")

    return {
        "n_oos":       int(len(real)),
        "first_oos":   str(idx[MIN_TRAIN].date()),
        "oos_r2":      round(r2(pred), 4),
        "oos_r2_regime": round(r2(pred_reg), 4),
        "regime_lift": round(r2(pred_reg) - r2(pred), 4),
        "regime_coverage": round(float(np.mean(used_reg)), 3),
        "hit_rate":    round(hit_rate, 3),
        "hit_z":       round(float(hit_z), 2),
        "hit_big":     None if hit_big is None else round(hit_big, 3),
        "corr":        None if math.isnan(corr) else round(corr, 3),
        "beta_last":   round(float(betas[-1]), 4),
        "beta_median": round(float(np.median(betas)), 4),
        "beta_flips":  flips,
    }


def walk_forward_edges() -> list:
    labels = get_regime_dates()
    out = []
    for e in _load_edges():
        df = _pair(e["source"], e["target"], e.get("lag_days", 0))
        if df is None:
            continue
        res = _walk_forward_one(df, labels)
        if res is None:
            continue
        direction = e.get("direction", 1)
        sign_ok = bool(res["beta_median"] * direction > 0)
        if (res["oos_r2"] >= R2_CUTOFF and res["hit_z"] >= HIT_Z_CUTOFF and sign_ok):
            verdict = "validated"
        elif res["oos_r2"] > 0 and sign_ok:
            verdict = "weak"
        else:
            verdict = "fails"
        out.append({
            "source": e["source"], "target": e["target"],
            "direction": direction, "confidence": e.get("confidence"),
            "lag_days": e.get("lag_days", 0),
            "sign_ok": sign_ok, "verdict": verdict, **res,
        })
    return out


# ── 2. Episode-level replay ──────────────────────────────────────────────────

def _pit_betas(cutoff: pd.Timestamp, edges: list) -> dict:
    """
    Betas estimated using only months <= cutoff, with the same quality gate the
    live simulator applies (R², n, sign vs. the edge direction).
    """
    betas = {}
    for e in edges:
        df = _pair(e["source"], e["target"], e.get("lag_days", 0))
        if df is None:
            continue
        tr = df[df.index <= cutoff]
        if len(tr) < MIN_BETA_N:
            continue
        b = _beta(tr["x"].values, tr["y"].values)
        if b is None:
            continue
        c = np.corrcoef(tr["x"].values, tr["y"].values)[0, 1]
        if np.isnan(c) or c * c < MIN_BETA_R2:
            continue
        if b * e.get("direction", 1) <= 0:
            continue
        betas[(e["source"], e["target"])] = {
            "beta": b, "lag_days": round((e.get("lag_days", 0) or 0) / 21) * 21,
            "regime": "all",
        }
    return betas


def backtest_episode(name: str, source: str, start: str, end: str) -> dict:
    edges   = _load_edges()
    s_chg   = _monthly(source)
    if s_chg is None:
        return {"name": name, "source": source, "error": "no data for source node"}

    window = slice(pd.Period(start, "M").end_time.normalize(),
                   pd.Period(end,   "M").end_time.normalize())
    cutoff = pd.Period(start, "M").start_time - pd.Timedelta(days=1)   # month-end before start
    s_win  = s_chg.loc[window]
    if s_win.empty:
        return {"name": name, "source": source, "error": "no source data in window"}

    shock_native = float(s_win.sum())                      # pp or decimal return
    shock_real   = shock_native * 100.0                    # bps or %
    unit         = "bps" if source in RATE_NODES else "%"

    betas = _pit_betas(cutoff, edges)
    sim   = simulate_shock(source, shock_real=shock_real, betas=betas, max_hops=6)

    rows = []
    for r in sim["results"]:
        chg = _monthly(r["node_id"])
        if chg is None:
            continue
        w = chg.loc[window]
        if w.empty:
            continue
        realised = float(w.sum())
        pred     = float(r["impact"])
        rows.append({
            "node": r["node_id"], "n_hops": r["n_hops"],
            "predicted": round(pred * 100, 3), "realised": round(realised * 100, 3),
            "unit": r["unit"], "empirical": r["empirical"],
            "sign_hit": bool(np.sign(pred) == np.sign(realised)) if realised != 0 else None,
            "path": r["path"],
        })

    # Every node the simulator reached (including ones with no price data to score)
    scored_ids = {r["node"] for r in rows}
    affected = [{
        "node": r["node_id"], "n_hops": r["n_hops"], "path": r["path"],
        "predicted": round(float(r["impact"]) * 100, 3), "unit": r["unit"],
        "empirical": r["empirical"], "scored": r["node_id"] in scored_ids,
    } for r in sim["results"]]

    scored = [r for r in rows if r["sign_hit"] is not None]
    emp    = [r for r in scored if r["empirical"]]

    def rate(rs):
        return round(sum(r["sign_hit"] for r in rs) / len(rs), 3) if rs else None

    by_hop = {}
    for h in sorted({r["n_hops"] for r in scored}):
        rs = [r for r in scored if r["n_hops"] == h]
        by_hop[str(h)] = {"n": len(rs), "hit_rate": rate(rs)}

    pr = np.array([r["predicted"] for r in scored]); rr = np.array([r["realised"] for r in scored])
    corr = float(np.corrcoef(pr, rr)[0, 1]) if len(scored) >= 4 and pr.std() > 0 and rr.std() > 0 else None
    ratios = [abs(r["predicted"] / r["realised"]) for r in scored if r["realised"] != 0 and r["empirical"]]

    return {
        "name": name, "source": source, "window": f"{start} to {end}",
        "betas_through": str(cutoff.date()),
        "source_move": round(shock_real, 2), "unit": unit,
        "n_affected": len(affected), "affected": affected,
        "n_scored": len(scored), "n_empirical": len(emp),
        "hit_rate_all": rate(scored), "hit_rate_empirical": rate(emp),
        "by_hop": by_hop,
        "corr_pred_realised": None if corr is None else round(corr, 3),
        "median_scale": None if not ratios else round(float(np.median(ratios)), 2),
        "nodes": sorted(rows, key=lambda r: -abs(r["realised"])),
    }


# ── Summary + CLI ────────────────────────────────────────────────────────────

def hop_depth_skill(max_depth: int = 3) -> dict:
    """
    Does skill survive chaining? For every simple path of 1..max_depth edges where
    every node has data, predict the END node's monthly move from the START node's
    move as  x * prod(beta_i) * DAMPEN^(h-1), each beta fitted point-in-time on
    strictly earlier months and quality-gated (R2, sign) exactly like the live
    simulator; a month where any hop fails the gate is skipped (the simulator would
    use a guess there). Moves are scaled by the end node's own std so paths pool.
    skill = 1 - MSE(model)/MSE(predict zero): >0 beats doing nothing.
    """
    from graph.simulator import DAMPEN_PER_HOP
    edges = _load_edges()
    adj = {}
    for e in edges:
        adj.setdefault(e["source"], []).append(e)

    paths = []
    def dfs(nodes, es):
        if es:
            paths.append((list(nodes), list(es)))
        if len(es) >= max_depth:
            return
        for e in adj.get(nodes[-1], []):
            if e["target"] in nodes:
                continue
            dfs(nodes + [e["target"]], es + [e])
    for n in list(adj):
        dfs([n], [])

    acc = {h: {"paths": 0, "y": [], "pred": [], "beat": 0, "ps": []} for h in range(1, max_depth + 1)}
    for nodes, es in paths:
        h = len(es)
        pairs = [_pair(e["source"], e["target"], e.get("lag_days", 0)) for e in es]
        if any(p is None for p in pairs):
            continue
        x0 = pairs[0]["x"]
        yT = pairs[-1]["y"]
        df = pd.concat([x0, yT], axis=1, join="inner").dropna()
        df.columns = ["x", "y"]
        if len(df) < MIN_TRAIN + MIN_OOS:
            continue
        sd = float(df["y"].std())
        if sd == 0:
            continue
        ys, ps = [], []
        for t in df.index[MIN_TRAIN:]:
            b, ok = 1.0, True
            for p_, e in zip(pairs, es):
                tr = p_[p_.index < t]
                if len(tr) < MIN_BETA_N:
                    ok = False; break
                bi = _beta(tr["x"].values, tr["y"].values)
                c = np.corrcoef(tr["x"].values, tr["y"].values)[0, 1] if bi is not None else np.nan
                if bi is None or np.isnan(c) or c * c < MIN_BETA_R2 or bi * e.get("direction", 1) <= 0:
                    ok = False; break
                b *= bi
            if not ok:
                continue
            ys.append(df.loc[t, "y"] / sd)
            ps.append(b * df.loc[t, "x"] * DAMPEN_PER_HOP ** (h - 1) / sd)
        if len(ys) < MIN_OOS:
            continue
        ys, ps = np.array(ys), np.array(ps)
        a = acc[h]
        a["paths"] += 1
        a["y"].append(ys); a["pred"].append(ps)
        a["beat"] += int(np.mean((ys - ps) ** 2) < np.mean(ys ** 2))
        a["ps"].append(1 - np.mean((ys - ps) ** 2) / np.mean(ys ** 2))

    out = []
    for h, a in acc.items():
        if not a["paths"]:
            out.append({"hops": h, "paths": 0, "obs": 0, "skill": None, "median_path_skill": None, "share_beating_zero": None})
            continue
        y, pr = np.concatenate(a["y"]), np.concatenate(a["pred"])
        mz, mm = float(np.mean(y ** 2)), float(np.mean((y - pr) ** 2))
        out.append({"hops": h, "paths": a["paths"], "obs": int(len(y)),
                    "skill": round(1 - mm / mz, 4),
                    "median_path_skill": round(float(np.median(a["ps"])), 4),
                    "share_beating_zero": round(a["beat"] / a["paths"], 3)})
    return {"damping": DAMPEN_PER_HOP, "by_depth": out}


def summarise_edges(rows: list) -> dict:
    def share(rs, v): return round(sum(r["verdict"] == v for r in rs) / len(rs), 3) if rs else None
    by_conf = {}
    for c in (1, 2, 3):
        rs = [r for r in rows if r.get("confidence") == c]
        if rs:
            by_conf[str(c)] = {"n": len(rs), "validated": share(rs, "validated"),
                               "fails": share(rs, "fails")}
    lifts = [r["regime_lift"] for r in rows if r["regime_coverage"] >= 0.3]
    return {
        "n_edges_tested": len(rows),
        "validated": sum(r["verdict"] == "validated" for r in rows),
        "weak":      sum(r["verdict"] == "weak" for r in rows),
        "fails":     sum(r["verdict"] == "fails" for r in rows),
        "sign_contradicts_direction": sum(not r["sign_ok"] for r in rows),
        "median_oos_r2": round(float(np.median([r["oos_r2"] for r in rows])), 4) if rows else None,
        "by_edge_confidence": by_conf,
        "regime_layer": {
            "edges_with_regime_betas": len(lifts),
            "median_lift": round(float(np.median(lifts)), 4) if lifts else None,
            "share_improved": round(float(np.mean([l > 0 for l in lifts])), 3) if lifts else None,
        },
    }


def run_all(write: bool = True) -> dict:
    edge_rows = walk_forward_edges()
    episodes  = [backtest_episode(*ep) for ep in EPISODES]
    result = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "params": {"min_train_months": MIN_TRAIN, "min_oos_months": MIN_OOS,
                   "r2_cutoff": R2_CUTOFF, "hit_z_cutoff": HIT_Z_CUTOFF},
        "summary":  summarise_edges(edge_rows),
        "edges":    sorted(edge_rows, key=lambda r: -r["oos_r2"]),
        "episodes": episodes,
        "hop_depth": hop_depth_skill(),
    }
    if write:
        with open(RESULT_PATH, "w") as f:
            json.dump(result, f, indent=2)
    return result


def _print(result: dict, saved: bool = True) -> None:
    s = result["summary"]
    print("\n=== Edge-level walk-forward ===")
    print(f"Edges tested: {s['n_edges_tested']}   validated {s['validated']}   "
          f"weak {s['weak']}   fails {s['fails']}   "
          f"(sign contradicts stated direction: {s['sign_contradicts_direction']})")
    print(f"Median out-of-sample R²: {s['median_oos_r2']}")
    print("Validated / failing share by the edge's own confidence score:")
    for c, v in s["by_edge_confidence"].items():
        print(f"   confidence {c}: n={v['n']}  validated={v['validated']}  fails={v['fails']}")
    rl = s["regime_layer"]
    print(f"Regime layer: {rl['edges_with_regime_betas']} edges with regime betas; "
          f"median OOS-R² lift {rl['median_lift']}; improved on {rl['share_improved']} of them")

    hd = result.get("hop_depth")
    if hd:
        print("\n=== Skill by hop depth (1 - MSE/MSE(zero); >0 beats predicting nothing) ===")
        for r in hd["by_depth"]:
            print(f"   {r['hops']} hop(s): paths={r['paths']}  obs={r['obs']}  skill={r['skill']}  median-path={r['median_path_skill']}  "
                  f"beat-zero share={r['share_beating_zero']}")

    print("\nBest 8 edges (by out-of-sample R²):")
    for r in result["edges"][:8]:
        print(f"  {r['source']:>16} -> {r['target']:<18} oos_r2={r['oos_r2']:>7}  "
              f"hit={r['hit_rate']}  z={r['hit_z']:>5}  n={r['n_oos']}  {r['verdict']}")
    print("\nWorst 5:")
    for r in result["edges"][-5:]:
        print(f"  {r['source']:>16} -> {r['target']:<18} oos_r2={r['oos_r2']:>7}  "
              f"hit={r['hit_rate']}  sign_ok={r['sign_ok']}  {r['verdict']}")

    print("\n=== Episode replays (betas known only before each episode) ===")
    for e in result["episodes"]:
        if "error" in e:
            print(f"\n{e['name']}: {e['error']}")
            continue
        print(f"\n{e['name']}  [{e['source']} {e['source_move']:+.1f}{e['unit']}, "
              f"{e['window']}, betas through {e['betas_through']}]")
        print(f"   scored {e['n_scored']} nodes ({e['n_empirical']} on empirical betas)   "
              f"sign hit: all={e['hit_rate_all']}  empirical-only={e['hit_rate_empirical']}")
        print(f"   corr(pred, realised)={e['corr_pred_realised']}   median scale={e['median_scale']}x   "
              f"by hops: {e['by_hop']}")
        for r in e["nodes"][:4]:
            print(f"     {r['node']:<18} predicted {r['predicted']:>8}{r['unit']}  "
                  f"realised {r['realised']:>8}{r['unit']}  hops={r['n_hops']}")
    if saved:
        print(f"\nSaved to {RESULT_PATH}")


if __name__ == "__main__":
    _print(run_all(write=True))