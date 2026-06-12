# Causal Map — US Market

## What this is
A causal diagram tool mapping relationships between US market actors,
indicators, sectors, and events. Supports path tracing, event replay,
empirical edge enrichment, and AI-assisted event ingestion.

## Stack
- Backend: Python 3.11, FastAPI, NetworkX, DuckDB, pandas, yfinance, fredapi
- Frontend: React (Vite), Cytoscape.js, TailwindCSS v3, Recharts
- Data: JSON seed files in backend/data/, price/macro data in DuckDB

## Project structure
causal-map/
  backend/
    data/
      nodes.json            # 37 nodes: actors, markets, indicators, sectors
      edges.json            # 83 edges with direction, lag_days, confidence
      events.json           # 8+ historical events (growing via AI ingestion)
      db.py                 # DuckDB connection, init_db()
      ingest.py             # yfinance (16+ tickers) + FRED (6 series) ingestion
      market_data.duckdb    # 25 years price + macro data
    graph/
      __init__.py
      loader.py             # loads JSON into NetworkX DiGraph
      queries.py            # get_all_nodes, get_all_edges, find_paths,
                            # get_neighbours, get_most_connected_nodes,
                            # get_events, get_event (reads from disk each time)
      enrichment.py         # compute_edge_magnitude, enrich_all_edges
    api/
      __init__.py
      main.py               # FastAPI app with all endpoints
    validate_data.py
    test_graph.py
    venv/
  frontend/
    src/
      api/client.js         # all fetch wrappers incl. updateNode, updateEdge,
                            # commitEvent, priceWindow
      components/
        GraphCanvas.jsx     # Cytoscape.js, colour by type, edge hover labels,
                            # position persistence in localStorage,
                            # reset view + auto-layout buttons
        NodeInspector.jsx   # node detail + edit, EdgeRow expand/edit,
                            # MiniChart for market nodes
        MiniChart.jsx       # Recharts price chart, 1Y/3Y/5Y/All periods
        PathFinder.jsx      # path finder with lag/direction/confidence
        EventPanel.jsx      # events list, affected node highlight,
                            # price charts around event date
        AIIngestion.jsx     # 2-step: copy context → paste JSON → review → commit
      App.jsx               # 4-tab sidebar: inspector/paths/events/ai
      main.jsx
      index.css
    tailwind.config.js
    postcss.config.js
    vite.config.js
    package.json

## API endpoints (all working, backend on port 8000)
GET  /                                              # health check
GET  /summary                                       # node/edge counts
GET  /nodes                                         # all nodes
GET  /nodes/{node_id}                               # single node
GET  /nodes/{node_id}/neighbours                    # upstream + downstream
GET  /edges                                         # all edges
GET  /paths?source=X&target=Y&max_paths=5           # path finder
GET  /events                                        # all events
GET  /events/{event_id}                             # single event
GET  /graph?min_confidence=1                        # Cytoscape.js format
GET  /edge-stats                                    # empirical edge stats
GET  /edge-stats/{source}/{target}                  # stats for specific edge
GET  /prices/{node_id}?days=365                     # price history
GET  /prices/{node_id}/window?date=X&days_before=90&days_after=90
PATCH /nodes/{node_id}                              # update node label/description
PATCH /edges/{source}/{target}                      # update edge label/notes/direction/confidence/lag
GET  /ai/context                                    # export graph context for Claude chat
POST /ai/commit-event                               # commit AI proposal to JSON files

## Node schema
{ id, label, type, description }
Types: actor | market | indicator | sector

## Edge schema
{ source, target, direction, label, lag_days, confidence, magnitude, notes }
- direction: 1 (positive) or -1 (negative)
- lag_days: how long the causal effect takes
- confidence: 1 (low) | 2 (moderate) | 3 (high/empirical)

## Event schema
{ id, label, date, type, description, affected_nodes, primary_direction }

## Run commands
- Backend: cd backend && source venv/bin/activate && uvicorn api.main:app --reload
- Frontend: cd frontend && npm run dev
- Re-ingest data: cd backend && python -m data.ingest
- Re-enrich edges: cd backend && python -m graph.enrichment
- Validate data: cd backend && python validate_data.py

## Node type colours
- actor:     blue   (#3B82F6)
- market:    green  (#10B981)
- indicator: amber  (#F59E0B)
- sector:    purple (#8B5CF6)

## Known issues to fix later
- Node/edge label updates not reflected immediately in Cytoscape canvas
  (requires surgical Cytoscape re-render fix, not blocking)

## Completed phases
- Phase 1: Data model + seed data
- Phase 2: Graph engine (NetworkX + path finder)
- Phase 3: FastAPI backend
- Phase 4: React + Cytoscape.js frontend
- Phase 5: Empirical enrichment (DuckDB, yfinance, FRED, edge stats)
- Phase 5+: Event overlay, AI ingestion, node/edge editing, 83 edges

## Next phases
1. Edge magnitude display in NodeInspector (r, beta from edge_stats)
2. Monthly correlation enrichment (better R² than daily)
3. Regime layer (tag edges active only in ZIRP/hiking/risk-off regimes)
4. Counterfactual simulator (toggle event, propagate via betas)