import os
import json
from pathlib import Path
from datetime import datetime, timedelta

import pandas as pd
import yfinance as yf
from fredapi import Fred
from dotenv import load_dotenv
from data.db import get_conn, init_db

load_dotenv(Path(__file__).parent.parent / ".env")

FRED_KEY = os.getenv("FRED_API_KEY")

# ── Ticker mappings ──────────────────────────────────────────────────────────
# node_id → Yahoo Finance ticker
YFINANCE_MAP = {
    "spx":            "^GSPC",
    "vix":            "^VIX",
    "xauusd":         "GC=F",
    "wti":            "CL=F",
    "dxy":            "DX-Y.NYB",
    "yield_10y":      "^TNX",
    "eurusd":         "EURUSD=X",
    "gbpusd":         "GBPUSD=X",
    "usdjpy":         "JPY=X",
    "sec_energy":     "XLE",
    "sec_financials": "XLF",
    "sec_tech":       "XLK",
    "sec_utilities":  "XLU",
    "sec_realestate": "XLRE",
    "hy_spreads":     "HYG",
    # ── Coverage expansion: nodes that exist in the graph but had no data ──
    "bitcoin":        "BTC-USD",
    "ethereum":       "ETH-USD",
    "coinbase_stock": "COIN",
    "nvidia_stock":   "NVDA",
    "intel_stock":    "INTC",
    "tsmc_stock":     "TSM",
    "apple_stock":    "AAPL",
    "micron_stock":   "MU",
    "samsung_stock":  "005930.KS",
    "sk_hynix_stock": "000660.KS",
    "kospi_index":    "^KS11",
    "brent_crude":    "BZ=F",
    "cadusd":         "CADUSD=X",
    "brlusd":         "BRLUSD=X",
    "defense_sector": "ITA",
    "yield_30y":      "^TYX",
}

# node_id → FRED series ID
FRED_MAP = {
    "fed_rate":     "FEDFUNDS",
    "yield_2y":     "DGS2",      # true 2Y Treasury (was ^IRX, a 13-week bill)
    "cpi":          "CPIAUCSL",
    "pce":          "PCEPI",
    "nfp":          "PAYEMS",
    "unemployment": "UNRATE",
    "gdp":          "GDP",
    # ── Coverage expansion ──
    "real_yield_10y":             "DFII10",         # 10Y TIPS yield, %
    "yield_curve":                "T10Y2Y",         # 10Y-2Y spread, pp
    "consumer_sent":              "UMCSENT",        # U. Michigan sentiment
    "housing":                    "HOUST",          # housing starts
    "us_retail_spending":         "RSAFS",          # retail sales
    "us_retail_gasoline":         "GASREGW",        # regular gasoline, weekly
    "labour_force_participation": "CIVPART",
}

START_DATE = "2000-01-01"
END_DATE   = datetime.today().strftime("%Y-%m-%d")


def ingest_prices() -> None:
    """Pull price data from Yahoo Finance and store in DuckDB."""
    conn = get_conn()
    print(f"\nPulling {len(YFINANCE_MAP)} price series from Yahoo Finance...")

    for node_id, ticker in YFINANCE_MAP.items():
        try:
            df = yf.download(ticker, start=START_DATE, end=END_DATE,
                           auto_adjust=True, progress=False)
            if df.empty:
                print(f"  SKIP {node_id} ({ticker}) — no data")
                continue

            # Flatten MultiIndex columns if present
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = df.columns.get_level_values(0)

            close = df[["Close"]].copy()
            close.index = pd.to_datetime(close.index).date
            close.columns = ["close"]
            close["node_id"] = node_id
            close = close.reset_index().rename(columns={"index": "date"})

            conn.execute("DELETE FROM prices WHERE node_id = ?", [node_id])
            conn.execute(
                "INSERT INTO prices SELECT node_id, date, close FROM close"
            )
            print(f"  OK  {node_id:20} ({ticker}) — {len(close)} rows")

        except Exception as e:
            print(f"  ERR {node_id} ({ticker}) — {e}")

    conn.close()


def ingest_macro() -> None:
    """Pull macro series from FRED and store in DuckDB."""
    if not FRED_KEY:
        print("ERROR: FRED_API_KEY not set in .env")
        return

    fred = Fred(api_key=FRED_KEY)
    conn = get_conn()
    print(f"\nPulling {len(FRED_MAP)} macro series from FRED...")

    for node_id, series_id in FRED_MAP.items():
        try:
            series = fred.get_series(
                series_id,
                observation_start=START_DATE,
                observation_end=END_DATE
            )
            df = series.dropna().reset_index()
            df.columns = ["date", "value"]
            df["series_id"] = series_id
            df["date"] = pd.to_datetime(df["date"]).dt.date

            conn.execute("DELETE FROM macro WHERE series_id = ?", [series_id])
            # Drop any stale price-table rows for this node (e.g. old ^IRX
            # yield_2y data) — prices take precedence over macro in enrichment.
            conn.execute("DELETE FROM prices WHERE node_id = ?", [node_id])
            conn.execute(
                "INSERT INTO macro SELECT series_id, date, value FROM df"
            )
            print(f"  OK  {node_id:20} ({series_id}) — {len(df)} rows")

        except Exception as e:
            print(f"  ERR {node_id} ({series_id}) — {e}")

    conn.close()


if __name__ == "__main__":
    init_db()
    ingest_prices()
    ingest_macro()
    print("\nIngestion complete.")