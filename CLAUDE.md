# INCIDENCE — Causal Map of the US Financial Market

## What this is
A causal diagram tool linking US market actors, indicators, sectors and events.
Supports path tracing, event replay, empirical edge enrichment (daily + monthly,
per regime), regime detection, AI-assisted event ingestion, and a counterfactual
shock simulator.

The graph is open-ended: nodes and edges are added continuously through AI
ingestion as markets evolve. **Do not hard-code node/edge/event counts in docs or
code** — read them from `GET /summary` or the JSON files.

## Stack
- Backend: Python 3.11, FastAPI, NetworkX, DuckDB, pandas, yfinance, fredapi
- Frontend: React (Vite), Cytoscape.js, TailwindCSS v3, Recharts
- Data: JSON seed files in backend/data/ (the source of truth for the graph),
  price/macro/edge-stat tables in DuckDB

## Structure
backend/
  data/    nodes.json, edges.json, events.json, db.py, ingest.py, market_data.duckdb
  graph/   loader, queries, enrichment (edge stats), regimes, regime_tagger, simulator
  api/     main.py (FastAPI)
frontend/src/
  api/client.js            fetch wrappers for every endpoint
  App.jsx                  5-tab sidebar: inspector / paths / events / ai / sim
  components/              GraphCanvas, NodeInspector, PathFinder, EventPanel,
                           AIIngestion, Simulator, MiniChart
docs/                      logo + screenshots; README.md, UserGuide.md at root
start.sh / start.ps1       one-terminal launchers (Mac/Linux, Windows)

## Schemas
- Node: { id, label, type, description } — type: actor | market | indicator | sector
- Edge: { source, target, direction (1/-1), label, lag_days, confidence (1-3),
          magnitude, notes, regimes[] } — empty/missing regimes = active in all
- Event: { id, label, date, type, description, affected_nodes, primary_direction }
- DuckDB: prices, macro, edge_stats (PK source, target, lag_days, freq, regime)

## Core concepts
- Regimes (from FEDFUNDS + VIX): zirp, hiking, easing, risk_off (priority), normal.
  Auto-tagger tags an edge to a regime when regime R² >= 1.25x the 'all' baseline
  and n >= 20.
- Simulator: BFS from the shocked node; at each hop return *= beta * 0.8
  (dampening is a heuristic, not measured). Betas are regime-aware, falling back to
  'all', then direction x 0.10 (reported per result as `fallback_hops`).
  Shocks are entered in natural units (bps for fed_rate/yield_10y/yield_2y, % for the
  rest), converted to a decimal return on the source (bps via current level), and
  propagated in return space — the space the betas were estimated in. Output
  `impact_pct` is a real % return per node. σ is for display only.
- Positions persist in localStorage; new nodes are placed near neighbours, never a
  full re-layout.

## Run
- One terminal: ./start.sh (or .\start.ps1 on Windows)
- Backend only: cd backend && source venv/bin/activate && uvicorn api.main:app --reload
- Frontend only: cd frontend && npm run dev
- Re-ingest data: cd backend && python -m data.ingest
- Re-enrich edges: cd backend && python -m graph.enrichment
- Validate: cd backend && python validate_data.py
- Endpoint list: open http://localhost:8000/docs (don't duplicate it here)

## Known issues / data caveats
- yield_2y is sourced from ^IRX (13-week T-bill), not a true 2-year yield. Replace
  with FRED DGS2 before trusting rate-curve results.
- Most edges lack empirical betas and use the fallback; the simulator's reach and
  confidence are limited until enrichment coverage grows.
- fed_rate σ is inflated by ZIRP-era relative changes near zero.

## Planned (not started)
- AI tab: edit buttons on each parsed node/edge/section before commit
- Events tab: chronological sort / filter
- Expandable, resizable left panel
- Buy-side risk-desk layer: holdings -> node mapping, portfolio shock P&L with
  causal-path attribution, walk-forward beta validation and simulator backtest,
  multi-shock and reverse stress tests