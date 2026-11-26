import duckdb
from pathlib import Path

DB_PATH = Path(__file__).parent / "market_data.duckdb"


def get_conn() -> duckdb.DuckDBPyConnection:
    """Return a connection to the local DuckDB database."""
    return duckdb.connect(str(DB_PATH))


EDGE_STATS_PK = ["source", "target", "lag_days", "freq", "regime"]

EDGE_STATS_DDL = """
    CREATE TABLE edge_stats (
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
"""


def _ensure_edge_stats(conn) -> None:
    """
    Create edge_stats with the current schema. If an older table exists whose
    primary key is (source, target, lag_days) — columns added later via ALTER
    cannot change a PK — drop and recreate it. Rows are derived data, so
    `python -m graph.enrichment` simply repopulates it. Without this, each
    freq/regime run overwrote the previous one.
    """
    exists = conn.execute(
        "SELECT count(*) FROM information_schema.tables WHERE table_name = 'edge_stats'"
    ).fetchone()[0]
    if exists:
        pk = conn.execute(
            "SELECT constraint_column_names FROM duckdb_constraints() "
            "WHERE table_name = 'edge_stats' AND constraint_type = 'PRIMARY KEY'"
        ).fetchone()
        if pk and list(pk[0]) == EDGE_STATS_PK:
            return
        print("edge_stats has an outdated primary key — rebuilding (re-run enrichment).")
        conn.execute("DROP TABLE edge_stats")
    conn.execute(EDGE_STATS_DDL)


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
    _ensure_edge_stats(conn)
    conn.close()
    print("DB initialised at", DB_PATH)


if __name__ == "__main__":
    init_db()