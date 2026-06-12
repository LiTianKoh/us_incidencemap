import duckdb
from pathlib import Path

DB_PATH = Path(__file__).parent / "market_data.duckdb"


def get_conn() -> duckdb.DuckDBPyConnection:
    """Return a connection to the local DuckDB database."""
    return duckdb.connect(str(DB_PATH))


def init_db() -> None:
    """Create tables if they don't exist."""
    conn = get_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS prices (
            node_id   VARCHAR,
            date      DATE,
            close     DOUBLE,
            PRIMARY KEY (node_id, date)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS macro (
            series_id VARCHAR,
            date      DATE,
            value     DOUBLE,
            PRIMARY KEY (series_id, date)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS edge_stats (
            source       VARCHAR,
            target       VARCHAR,
            lag_days     INTEGER,
            freq         VARCHAR DEFAULT 'daily',
            regime       VARCHAR DEFAULT 'all',
            correlation  DOUBLE,
            beta         DOUBLE,
            r_squared    DOUBLE,
            n_obs        INTEGER,
            computed_at  TIMESTAMP DEFAULT current_timestamp,
            PRIMARY KEY (source, target, lag_days, freq, regime)
        )
    """)
    # Migrations: add new columns to existing table if not present
    for col, ddl in [
        ("freq",   "ALTER TABLE edge_stats ADD COLUMN freq   VARCHAR DEFAULT 'daily'"),
        ("regime", "ALTER TABLE edge_stats ADD COLUMN regime VARCHAR DEFAULT 'all'"),
    ]:
        try:
            conn.execute(ddl)
            print(f"Migrated edge_stats: added {col} column")
        except Exception:
            pass  # Column already exists
    conn.close()
    print("DB initialised at", DB_PATH)


if __name__ == "__main__":
    init_db()