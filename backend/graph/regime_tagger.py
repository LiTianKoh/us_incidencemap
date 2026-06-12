"""
Regime tagger — auto-tags edges.json with which regimes they're active in.

Logic:
  For each edge, compare per-regime R² against the 'all' baseline.
  An edge is tagged as active in a regime if:
    - r²_regime >= r²_all * R2_LIFT_THRESHOLD  (meaningful lift over baseline)
    - n_obs >= MIN_OBS                          (enough data to trust)

  If an edge has no empirical data at all, regimes stays [] (active everywhere).
  If an edge has empirical data but no regime clears the threshold, regimes
  stays [] (relationship is regime-agnostic or too noisy to distinguish).

After auto-tagging, any manually set values are preserved if you pass
preserve_manual=True (default). Manual means the value was already non-empty
before this run.
"""

import json
from pathlib import Path

from data.db import get_conn

R2_LIFT_THRESHOLD = 1.25   # regime R² must be 25% higher than 'all' baseline
MIN_OBS           = 20     # minimum observations in regime slice
REGIMES           = ["zirp", "hiking", "easing", "risk_off", "normal"]

DATA_DIR   = Path(__file__).parent.parent / "data"
EDGES_PATH = DATA_DIR / "edges.json"


def _load_edge_stats() -> dict:
    """
    Load edge_stats from DuckDB into a nested dict:
      stats[source][target][regime][freq] = best R² row
    Uses the best (highest R²) row per (source, target, regime, freq) combo.
    """
    conn = get_conn()
    rows = conn.execute("""
        SELECT source, target, regime, freq, r_squared, n_obs, correlation
        FROM edge_stats
    """).fetchdf()
    conn.close()

    stats = {}
    for _, row in rows.iterrows():
        src = row["source"]
        tgt = row["target"]
        rgm = row["regime"]
        frq = row["freq"]

        stats.setdefault(src, {}).setdefault(tgt, {}).setdefault(rgm, {})

        existing = stats[src][tgt][rgm].get(frq)
        if existing is None or row["r_squared"] > existing["r_squared"]:
            stats[src][tgt][rgm][frq] = {
                "r_squared":   row["r_squared"],
                "n_obs":       row["n_obs"],
                "correlation": row["correlation"],
            }
    return stats


def _best_r2(regime_freqs: dict) -> tuple[float, int]:
    """Return (best_r2, n_obs) across daily/monthly for a regime."""
    best = max(regime_freqs.values(), key=lambda x: x["r_squared"])
    return best["r_squared"], best["n_obs"]


def auto_tag_edges(preserve_manual: bool = True) -> list[dict]:
    """
    Read edges.json, compute regime tags from edge_stats, write back.
    Returns the updated edges list.
    """
    with open(EDGES_PATH) as f:
        edges = json.load(f)

    stats = _load_edge_stats()

    tagged = 0
    skipped_no_data = 0
    skipped_no_lift = 0

    for edge in edges:
        src = edge["source"]
        tgt = edge["target"]

        # Preserve existing manual tags if requested
        existing = edge.get("regimes", [])
        if preserve_manual and existing:
            print(f"  KEEP {src:20} → {tgt:20} manual={existing}")
            continue

        edge_stats = stats.get(src, {}).get(tgt, {})

        if not edge_stats:
            edge["regimes"] = []
            skipped_no_data += 1
            continue

        # Get 'all' baseline
        all_data = edge_stats.get("all", {})
        if not all_data:
            edge["regimes"] = []
            skipped_no_data += 1
            continue

        baseline_r2, _ = _best_r2(all_data)

        active_regimes = []
        for regime in REGIMES:
            regime_data = edge_stats.get(regime, {})
            if not regime_data:
                continue
            r2, n_obs = _best_r2(regime_data)
            if n_obs < MIN_OBS:
                continue
            if r2 >= baseline_r2 * R2_LIFT_THRESHOLD:
                active_regimes.append(regime)

        edge["regimes"] = active_regimes

        if active_regimes:
            tagged += 1
            print(f"  TAG  {src:20} → {tgt:20} regimes={active_regimes} "
                  f"(baseline R²={baseline_r2:.3f})")
        else:
            skipped_no_lift += 1

    with open(EDGES_PATH, "w") as f:
        json.dump(edges, f, indent=2)

    print(f"\nTagged:          {tagged} edges with specific regimes")
    print(f"Regime-agnostic: {skipped_no_lift} edges (no regime showed clear lift)")
    print(f"No data:         {skipped_no_data} edges (no empirical stats)")
    return edges


if __name__ == "__main__":
    auto_tag_edges()
