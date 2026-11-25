import json
from datetime import datetime, timedelta
from data.db import get_conn
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from graph.queries import (
    get_all_nodes,
    get_all_edges,
    get_node,
    find_paths,
    get_neighbours,
    get_most_connected_nodes,
    get_events,
    get_event,
)

app = FastAPI(
    title="Causal Map API",
    description="US market causal diagram — graph query API",
    version="1.0.0"
)

# Allow the Vite dev server to call this API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Health check ────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {"status": "ok", "message": "Causal Map API is running"}


# ── Nodes ───────────────────────────────────────────────────────────────────

@app.get("/nodes")
def nodes():
    """Return all nodes."""
    return get_all_nodes()


@app.get("/nodes/{node_id}")
def node(node_id: str):
    """Return a single node by ID."""
    result = get_node(node_id)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")
    return result


@app.get("/nodes/{node_id}/neighbours")
def neighbours(node_id: str):
    """Return immediate upstream and downstream neighbours."""
    try:
        return get_neighbours(node_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── Edges ───────────────────────────────────────────────────────────────────

@app.get("/edges")
def edges():
    """Return all edges."""
    return get_all_edges()


# ── Paths ───────────────────────────────────────────────────────────────────

@app.get("/paths")
def paths(
    source: str = Query(..., description="Source node ID"),
    target: str = Query(..., description="Target node ID"),
    max_paths: int = Query(5, ge=1, le=20, description="Max number of paths to return")
):
    """
    Find all causal paths between two nodes.
    Returns paths sorted by total lag (fastest first).
    """
    try:
        result = find_paths(source, target, max_paths)
        return {
            "source": source,
            "target": target,
            "paths_found": len(result),
            "paths": result
        }
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── Graph summary ────────────────────────────────────────────────────────────

@app.get("/summary")
def summary():
    """Return high-level graph statistics."""
    nodes_list = get_all_nodes()
    edges_list = get_all_edges()

    type_counts = {}
    for n in nodes_list:
        t = n.get("type", "unknown")
        type_counts[t] = type_counts.get(t, 0) + 1

    return {
        "total_nodes": len(nodes_list),
        "total_edges": len(edges_list),
        "node_types": type_counts,
        "most_connected": get_most_connected_nodes(5)
    }


# ── Events ───────────────────────────────────────────────────────────────────

@app.get("/events")
def events():
    """Return all historical events."""
    return get_events()


@app.get("/events/{event_id}")
def event(event_id: str):
    """Return a single event by ID."""
    result = get_event(event_id)
    if result is None:
        raise HTTPException(status_code=404, detail=f"Event '{event_id}' not found")
    return result


# ── Graph export (for Cytoscape.js) ─────────────────────────────────────────

@app.get("/graph")
def graph(
    min_confidence: int = Query(1, ge=1, le=3, description="Filter edges by minimum confidence")
):
    """
    Export the full graph in Cytoscape.js format.
    Optionally filter edges by minimum confidence level.
    """
    nodes_list = get_all_nodes()
    edges_list = get_all_edges()

    filtered_edges = [
        e for e in edges_list
        if e.get("confidence", 1) >= min_confidence
    ]

    cy_nodes = [{"data": n} for n in nodes_list]
    cy_edges = [
        {
            "data": {
                "id": f"{e['source']}__{e['target']}",
                **e
            }
        }
        for e in filtered_edges
    ]

    return {
        "elements": {
            "nodes": cy_nodes,
            "edges": cy_edges
        },
        "total_nodes": len(cy_nodes),
        "total_edges": len(cy_edges)
    }


# ── Empirical edge stats ─────────────────────────────────────────────────────

@app.get("/edge-stats")
def edge_stats(regime: str = Query("all", description="Filter by regime")):
    """Return all computed empirical edge statistics, optionally filtered by regime."""
    conn = get_conn()
    result = conn.execute("""
        SELECT source, target, lag_days, freq, regime, correlation, beta, r_squared, n_obs
        FROM edge_stats
        WHERE regime = ?
        ORDER BY abs(correlation) DESC
    """, [regime]).fetchdf()
    conn.close()
    return result.to_dict(orient="records")


@app.get("/edge-stats/{source}/{target}")
def edge_stat(source: str, target: str):
    """Return all empirical stats for a specific edge across all freqs and regimes."""
    conn = get_conn()
    result = conn.execute("""
        SELECT source, target, lag_days, freq, regime, correlation, beta, r_squared, n_obs
        FROM edge_stats
        WHERE source = ? AND target = ?
        ORDER BY regime, freq, lag_days
    """, [source, target]).fetchdf()
    conn.close()
    if result.empty:
        raise HTTPException(status_code=404, detail=f"No stats for {source} → {target}")
    return result.to_dict(orient="records")


# ── Regime endpoints ──────────────────────────────────────────────────────────

@app.get("/regime/current")
def regime_current():
    """Return the current market regime and when it started."""
    from graph.regimes import get_current_regime
    return get_current_regime()


@app.get("/regime/history")
def regime_history():
    """Return the full monthly regime history as a list of {date, regime} dicts."""
    from graph.regimes import get_regime_dates
    series = get_regime_dates()
    return [
        {"date": d.strftime("%Y-%m-%d"), "regime": r}
        for d, r in series.items()
    ]


# ── Counterfactual simulator ─────────────────────────────────────────────────

@app.get("/node-sigmas")
def node_sigmas():
    """Return empirical monthly return σ + unit (bps or %) per node."""
    from graph.simulator import get_node_sigmas
    return get_node_sigmas()


@app.post("/simulate")
async def simulate(body: dict):
    """
    Propagate a shock through the causal graph using empirical betas.

    Body: {
      node_id:   str    — source node to shock
      shock_std: float  — shock size in standard deviations (default 1.0)
      regime:    str    — regime to use for betas (default "all")
      max_hops:  int    — max path depth (default 10)
    }
    """
    from graph.simulator import simulate_shock

    node_id    = body.get("node_id")
    shock_real = body.get("shock_real")          # preferred: real units (bps or %)
    shock_std  = body.get("shock_std")           # fallback: σ
    regime     = body.get("regime", "all")
    max_hops   = int(body.get("max_hops", 10))

    if not node_id:
        raise HTTPException(status_code=400, detail="node_id is required")
    if shock_real is None and shock_std is None:
        shock_std = 1.0

    try:
        result = simulate_shock(
            node_id,
            shock_real = float(shock_real) if shock_real is not None else None,
            shock_std  = float(shock_std)  if shock_std  is not None else None,
            regime     = regime,
            max_hops   = max_hops,
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))

    return result


@app.post("/regime/auto-tag")
def regime_auto_tag(preserve_manual: bool = True):
    """Auto-tag edges.json with active regimes based on R² lift from edge_stats."""
    from graph.regime_tagger import auto_tag_edges
    from graph.loader import load_graph
    import graph.loader as loader

    edges = auto_tag_edges(preserve_manual=preserve_manual)
    loader.G = load_graph()

    tagged = sum(1 for e in edges if e.get("regimes"))
    return {
        "status":       "tagged",
        "total_edges":  len(edges),
        "tagged_edges": tagged,
    }


# ── Price history ─────────────────────────────────────────────────────────────

@app.get("/prices/{node_id}")
def prices(
    node_id: str,
    days: int = Query(365, ge=30, le=9000, description="Number of recent days to return")
):
    """Return recent price history for a node."""
    conn = get_conn()
    result = conn.execute("""
        SELECT date, close
        FROM prices
        WHERE node_id = ?
        ORDER BY date DESC
        LIMIT ?
    """, [node_id, days]).fetchdf()
    conn.close()
    if result.empty:
        raise HTTPException(status_code=404, detail=f"No price data for '{node_id}'")
    result["date"] = result["date"].astype(str)
    return result.sort_values("date").to_dict(orient="records")

# ── Price window around an event ─────────────────────────────────────────────

@app.get("/prices/{node_id}/window")
def price_window(
    node_id: str,
    date: str = Query(..., description="Centre date YYYY-MM-DD"),
    days_before: int = Query(90, ge=7, le=365),
    days_after:  int = Query(90, ge=7, le=365),
):
    """Return price history for a node around a specific event date."""
    centre     = datetime.strptime(date, "%Y-%m-%d")
    date_from  = (centre - timedelta(days=days_before)).strftime("%Y-%m-%d")
    date_to    = (centre + timedelta(days=days_after)).strftime("%Y-%m-%d")

    conn = get_conn()
    result = conn.execute("""
        SELECT date, close
        FROM prices
        WHERE node_id = ?
          AND date >= ?
          AND date <= ?
        ORDER BY date
    """, [node_id, date_from, date_to]).fetchdf()
    conn.close()

    if result.empty:
        raise HTTPException(status_code=404, detail=f"No price data for '{node_id}' around {date}")
    result["date"] = result["date"].astype(str)
    return result.to_dict(orient="records")

# ── AI context export ─────────────────────────────────────────────────────────

@app.get("/ai/context")
def ai_context():
    """Export graph context formatted for pasting into Claude."""
    nodes_list  = get_all_nodes()
    node_map    = {n["id"]: f"{n['label']} ({n['type']})" for n in nodes_list}
    events_list = get_events()
    event_ids   = [e["id"] for e in events_list]

    context = f"""You are helping maintain a causal diagram of the US financial system.

EXISTING NODES:
{json.dumps(node_map, indent=2)}

EXISTING EVENT IDs (don't duplicate these):
{json.dumps(event_ids, indent=2)}

Given a news article, return ONLY a JSON object with this structure:
{{
  "event": {{
    "id": "snake_case_unique_id",
    "label": "Short event title",
    "date": "YYYY-MM-DD",
    "type": "macro_shock|monetary_policy|financial_shock|geopolitical|trade_policy|fiscal_policy",
    "description": "1-2 sentence description",
    "affected_nodes": ["existing_node_id_1", "existing_node_id_2"],
    "primary_direction": 1
  }},
  "new_nodes": [],
  "new_edges": [],
  "reasoning": "Brief explanation"
}}

RULES:
- affected_nodes must only use ids from EXISTING NODES above, or new node ids you define in new_nodes
- Propose new nodes whenever the article involves an actor, market, indicator, or sector not already in the graph
- Propose new edges whenever the article clearly implies a causal relationship not already captured
- It is better to propose and let the human review than to miss a real relationship
- new_nodes schema: {{ "id": "snake_case", "label": "Display name", "type": "actor|market|indicator|sector", "description": "One sentence" }}
- new_edges schema: {{ "source": "node_id", "target": "node_id", "direction": 1, "label": "short label", "lag_days": 5, "confidence": 2, "notes": "explanation" }}
- direction: 1 means source↑ causes target↑, -1 means source↑ causes target↓
- confidence: 1 (speculative), 2 (moderate), 3 (well established)
- Return ONLY valid JSON, no markdown, no explanation outside the JSON"""

    return {"context": context}

# ── AI commit event ───────────────────────────────────────────────────────────

@app.post("/ai/commit-event")
async def commit_event(body: dict):
    """Commit an approved event proposal to events.json (and optionally nodes/edges)."""
    from pathlib import Path

    DATA_DIR = Path(__file__).parent.parent / "data"

    event     = body.get("event")
    new_nodes = body.get("new_nodes", [])
    new_edges = body.get("new_edges", [])

    if not event:
        raise HTTPException(status_code=400, detail="No event provided")

    # Append to events.json
    events_path = DATA_DIR / "events.json"
    with open(events_path) as f:
        events = json.load(f)
    if any(e["id"] == event["id"] for e in events):
        raise HTTPException(status_code=400, detail=f"Event id '{event['id']}' already exists")
    events.append(event)
    with open(events_path, "w") as f:
        json.dump(events, f, indent=2)

    # Append new nodes if any
    if new_nodes:
        nodes_path = DATA_DIR / "nodes.json"
        with open(nodes_path) as f:
            nodes = json.load(f)
        existing_ids = {n["id"] for n in nodes}
        for node in new_nodes:
            if node["id"] not in existing_ids:
                nodes.append(node)
        with open(nodes_path, "w") as f:
            json.dump(nodes, f, indent=2)

    # Append new edges if any
    if new_edges:
        edges_path = DATA_DIR / "edges.json"
        with open(edges_path) as f:
            edges = json.load(f)
        for edge in new_edges:
            exists = any(
                e["source"] == edge["source"] and e["target"] == edge["target"]
                for e in edges
            )
            if not exists:
                edge.setdefault("magnitude", None)
                edges.append(edge)
        with open(edges_path, "w") as f:
            json.dump(edges, f, indent=2)

    # Reload graph in memory
    from graph.loader import load_graph, load_events
    import graph.loader as loader
    loader.G      = load_graph()
    loader.EVENTS = load_events()

    return {
        "status":      "committed",
        "event_id":    event["id"],
        "nodes_added": len(new_nodes),
        "edges_added": len(new_edges),
    }
# ── Edit nodes and edges ──────────────────────────────────────────────────────

@app.patch("/nodes/{node_id}")
async def update_node(node_id: str, body: dict):
    """Update a node's label and/or description."""
    from pathlib import Path
    DATA_DIR = Path(__file__).parent.parent / "data"

    nodes_path = DATA_DIR / "nodes.json"
    with open(nodes_path) as f:
        nodes = json.load(f)

    node = next((n for n in nodes if n["id"] == node_id), None)
    if not node:
        raise HTTPException(status_code=404, detail=f"Node '{node_id}' not found")

    # Only allow updating label and description
    if "label" in body:
        node["label"] = body["label"]
    if "description" in body:
        node["description"] = body["description"]

    with open(nodes_path, "w") as f:
        json.dump(nodes, f, indent=2)

    # Reload graph
    from graph.loader import load_graph
    import graph.loader as loader
    loader.G = load_graph()

    return node


@app.patch("/edges/{source}/{target}")
async def update_edge(source: str, target: str, body: dict):
    """Update an edge's label and/or notes."""
    from pathlib import Path
    DATA_DIR = Path(__file__).parent.parent / "data"

    edges_path = DATA_DIR / "edges.json"
    with open(edges_path) as f:
        edges = json.load(f)

    edge = next(
        (e for e in edges if e["source"] == source and e["target"] == target),
        None
    )
    if not edge:
        raise HTTPException(status_code=404, detail=f"Edge '{source} → {target}' not found")

    if "label" in body:
        edge["label"] = body["label"]
    if "notes" in body:
        edge["notes"] = body["notes"]
    if "direction" in body:
        edge["direction"] = body["direction"]
    if "confidence" in body:
        edge["confidence"] = body["confidence"]
    if "lag_days" in body:
        edge["lag_days"] = body["lag_days"]
    if "regimes" in body:
        edge["regimes"] = body["regimes"]

    with open(edges_path, "w") as f:
        json.dump(edges, f, indent=2)

    # Reload graph
    from graph.loader import load_graph
    import graph.loader as loader
    loader.G = load_graph()

    return edge