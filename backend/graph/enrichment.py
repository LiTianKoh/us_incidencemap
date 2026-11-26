import numpy as np
import pandas as pd
from data.db import get_conn


# Rate nodes are quoted in % points. Percent-changes of a yield near 0% explode
# (0.05 -> 0.10 is +100%), so these are modelled on level changes (pp) instead.
RATE_NODES = {"fed_rate", "yield_10y", "yield_2y"}


def _changes(series: pd.Series, node_id: str, rule: str) -> pd.Series:
    """Resample then convert to changes: pp diff for rate nodes, else pct_change."""
    s = series.resample(rule).last().ffill()
    out = s.diff() if node_id in RATE_NODES else s.pct_change()
    return out.dropna()


def _load_series(node_id: str) -> pd.Series | None:
    """
    Load a time series for a node from DuckDB.
    Tries prices table first, then macro table.
    """
    conn = get_conn()

    # Try prices first
    result = conn.execute(
        "SELECT date, close FROM prices WHERE node_id = ? ORDER BY date",
        [node_id]
    ).fetchdf()

    if result.empty:
        # Try macro table using FRED_MAP reverse lookup
        from data.ingest import FRED_MAP
        series_id = FRED_MAP.get(node_id)
        if series_id:
            result = conn.execute(
                "SELECT date, value as close FROM macro WHERE series_id = ? ORDER BY date",
                [series_id]
            ).fetchdf()

    conn.close()

    if result.empty:
        return None

    result["date"] = pd.to_datetime(result["date"])
    return result.set_index("date")["close"]


def _compute_stats(x: np.ndarray, y: np.ndarray) -> dict:
    """Run OLS and return r, beta, R², n."""
    correlation = float(np.corrcoef(x, y)[0, 1])
    beta        = float(np.cov(x, y)[0, 1] / np.var(x)) if np.var(x) > 0 else 0.0
    r_squared   = float(correlation ** 2)
    return {
        "correlation": round(correlation, 4),
        "beta":        round(beta, 4),
        "r_squared":   round(r_squared, 4),
        "n_obs":       len(x),
    }


def compute_edge_magnitude(
    source_id: str,
    target_id: str,
    lag_days: int = 5,
    regime_filter: pd.DatetimeIndex | None = None,
    regime_label: str = "all",
) -> list[dict]:
    """
    Estimate the empirical relationship between source and target at both
    daily and monthly frequency. Returns a list of stat dicts (0-2 entries).

    Daily:   resample to business day, change (pct, or pp for rate nodes), shift by lag_days
    Monthly: resample to month-end, pct_change, shift by lag_months
             (lag_months = round(lag_days / 21)   # 0 = same-month (contemporaneous))

    If regime_filter is provided (a DatetimeIndex of month-end dates),
    only months overlapping those dates are included in the regression.
    """
    src = _load_series(source_id)
    tgt = _load_series(target_id)

    if src is None or tgt is None:
        return []

    results = []
    MIN_OBS = 30

    # ── Daily ────────────────────────────────────────────────────────────────
    src_d = _changes(src, source_id, "B")
    tgt_d = _changes(tgt, target_id, "B")

    combined_d = pd.concat([src_d, tgt_d], axis=1, join="inner").dropna()
    combined_d.columns = ["source", "target"]

    # Filter to regime months if requested
    if regime_filter is not None and len(regime_filter) > 0:
        regime_months = regime_filter.to_period("M")
        mask = combined_d.index.to_period("M").isin(regime_months)
        combined_d = combined_d[mask]

    if len(combined_d) >= MIN_OBS:
        combined_d = combined_d.copy()
        combined_d["source_lagged"] = combined_d["source"].shift(lag_days)
        combined_d = combined_d.dropna()
        if len(combined_d) >= MIN_OBS:
            stats = _compute_stats(
                combined_d["source_lagged"].values,
                combined_d["target"].values,
            )
            results.append({
                "source": source_id, "target": target_id,
                "lag_days": lag_days, "freq": "daily",
                "regime": regime_label,
                **stats,
            })

    # ── Monthly ──────────────────────────────────────────────────────────────
    src_m = _changes(src, source_id, "ME")
    tgt_m = _changes(tgt, target_id, "ME")

    combined_m = pd.concat([src_m, tgt_m], axis=1, join="inner").dropna()
    combined_m.columns = ["source", "target"]

    if regime_filter is not None and len(regime_filter) > 0:
        regime_months = regime_filter.to_period("M")
        mask = combined_m.index.to_period("M").isin(regime_months)
        combined_m = combined_m[mask]

    lag_months = round(lag_days / 21)   # 0 = same-month (contemporaneous)

    if len(combined_m) >= MIN_OBS:
        combined_m = combined_m.copy()
        combined_m["source_lagged"] = combined_m["source"].shift(lag_months)
        combined_m = combined_m.dropna()
        if len(combined_m) >= MIN_OBS:
            stats = _compute_stats(
                combined_m["source_lagged"].values,
                combined_m["target"].values,
            )
            results.append({
                "source": source_id, "target": target_id,
                "lag_days": lag_months * 21,   # stored in (approx.) days
                "freq": "monthly",
                "regime": regime_label,
                **stats,
            })

    return results


def enrich_all_edges() -> list[dict]:
    """
    Compute empirical stats for all edges at daily + monthly frequency,
    for the full history ("all") and for each named regime.
    Saves results to DuckDB edge_stats table.
    """
    import json
    from pathlib import Path
    from graph.regimes import dates_for_regime, REGIMES

    with open(Path(__file__).parent.parent / "data" / "edges.json") as f:
        edges = json.load(f)

    # Pre-compute regime date sets once
    regime_dates = {r: dates_for_regime(r) for r in REGIMES}

    from data.db import init_db
    init_db()   # rebuilds edge_stats if it still has the old (source,target,lag_days) PK

    conn = get_conn()
    results = []

    # Full recompute: lag/unit conventions changed, so old rows must not linger
    conn.execute("DELETE FROM edge_stats")

    # Runs: full history first, then each regime
    runs = [("all", None)] + [(r, regime_dates[r]) for r in REGIMES]

    for regime_label, r_dates in runs:
        n_months = len(r_dates) if r_dates is not None else "all"
        print(f"\nEnriching {len(edges)} edges — regime={regime_label} ({n_months} months)...")

        for edge in edges:
            src = edge["source"]
            tgt = edge["target"]
            lag = edge.get("lag_days", 5)

            rows = compute_edge_magnitude(src, tgt, lag, r_dates, regime_label)

            if not rows:
                if regime_label == "all":
                    print(f"  SKIP {src:20} → {tgt:20} (no data)")
                continue

            for stats in rows:
                conn.execute("""
                    INSERT OR REPLACE INTO edge_stats
                    (source, target, lag_days, freq, regime,
                     correlation, beta, r_squared, n_obs)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, [
                    stats["source"], stats["target"],
                    stats["lag_days"], stats["freq"], stats["regime"],
                    stats["correlation"], stats["beta"],
                    stats["r_squared"], stats["n_obs"],
                ])
                print(
                    f"  OK  {src:20} → {tgt:20} "
                    f"[{stats['freq']:7}][{stats['regime']:8}] "
                    f"| r={stats['correlation']:+.3f} "
                    f"| β={stats['beta']:+.4f} "
                    f"| R²={stats['r_squared']:.3f} "
                    f"| n={stats['n_obs']}"
                )
                results.append(stats)

    conn.close()
    print(f"\nTotal: {len(results)} rows enriched.")
    return results


if __name__ == "__main__":
    enrich_all_edges()