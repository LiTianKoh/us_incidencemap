"""
Regime detection for the causal map.

Regimes (priority order — risk_off can overlap any rate regime):
  risk_off : VIX > 28  (≈ 90th percentile)
  zirp     : fed_funds < 0.5 %
  hiking   : fed_funds 3-month delta > +0.25 %
  easing   : fed_funds 3-month delta < -0.25 %
  normal   : everything else

All thresholds are monthly — FEDFUNDS is monthly, VIX is resampled to ME.
"""

import pandas as pd
from data.db import get_conn

REGIMES = ["zirp", "hiking", "easing", "risk_off", "normal"]

VIX_THRESHOLD        = 28.0
ZIRP_THRESHOLD       = 0.50   # %
HIKE_DELTA_THRESHOLD = 0.25   # % per 3-month window
EASE_DELTA_THRESHOLD = -0.25


def _load_fed_funds() -> pd.Series:
    """Monthly FEDFUNDS from macro table."""
    conn = get_conn()
    df = conn.execute("""
        SELECT date, value
        FROM macro
        WHERE series_id = 'FEDFUNDS'
        ORDER BY date
    """).fetchdf()
    conn.close()
    df["date"] = pd.to_datetime(df["date"])
    return df.set_index("date")["value"].resample("ME").last().ffill()


def _load_vix() -> pd.Series:
    """Monthly VIX (month-end) from prices table."""
    conn = get_conn()
    df = conn.execute("""
        SELECT date, close
        FROM prices
        WHERE node_id = 'vix'
        ORDER BY date
    """).fetchdf()
    conn.close()
    df["date"] = pd.to_datetime(df["date"])
    return df.set_index("date")["close"].resample("ME").last().ffill()


def get_regime_dates() -> pd.Series:
    """
    Return a monthly date-indexed Series of regime labels
    covering the full history in DuckDB.
    """
    fed   = _load_fed_funds()
    vix   = _load_vix()

    # Align on common months
    combined = pd.DataFrame({"fed": fed, "vix": vix}).dropna()

    # 3-month rolling delta for fed funds
    combined["fed_delta"] = combined["fed"].diff(3)

    labels = []
    for _, row in combined.iterrows():
        if row["vix"] > VIX_THRESHOLD:
            labels.append("risk_off")
        elif row["fed"] < ZIRP_THRESHOLD:
            labels.append("zirp")
        elif row["fed_delta"] > HIKE_DELTA_THRESHOLD:
            labels.append("hiking")
        elif row["fed_delta"] < EASE_DELTA_THRESHOLD:
            labels.append("easing")
        else:
            labels.append("normal")

    return pd.Series(labels, index=combined.index, name="regime")


def get_current_regime() -> dict:
    """
    Return the current regime and the date it started.
    """
    series = get_regime_dates()
    if series.empty:
        return {"regime": "unknown", "since": None}

    current = series.iloc[-1]

    # Walk back to find when this regime started
    since = series.index[-1]
    for date, label in series.iloc[::-1].items():
        if label != current:
            break
        since = date

    return {
        "regime": current,
        "since":  since.strftime("%Y-%m-%d"),
    }


def dates_for_regime(regime: str) -> pd.DatetimeIndex:
    """
    Return the set of month-end dates classified as `regime`.
    Used by enrichment to filter price series.
    """
    series = get_regime_dates()
    return series[series == regime].index


if __name__ == "__main__":
    print(get_current_regime())
    print(get_regime_dates().value_counts())
