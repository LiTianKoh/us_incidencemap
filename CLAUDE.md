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
- Edge stats (enrichment.py): monthly + daily OLS per regime. Rate nodes
  (fed_rate, yield_10y, yield_2y) use level changes in percentage points; every
  other node uses % change — percent-changes of a yield near 0% are meaningless.
  Monthly lag = round(lag_days/21) months (0 = same-month), stored as ~days.
  edge_stats PK is (source, target, lag_days, freq, regime); db.init_db() rebuilds
  an older table with the legacy 3-column PK (which made each regime overwrite the
  last). After any change to enrichment, run `python -m graph.enrichment`.
- Simulator: BFS from the shocked node; at each hop change *= beta * 0.8
  (dampening is a heuristic, not measured). Shocks are entered in natural units
  (bps for rate nodes, % for the rest) and propagated in the same native units the
  betas were estimated in. Only monthly betas are used, and a beta must pass a
  quality gate (R2 >= 0.02, n >= 20, sign agrees with the edge direction), else the
  flagged fallback (direction x 0.10) is used. Each result reports its own unit
  (% or bps), `fallback_hops` and `empirical`; the UI shows "est." for fallbacks.
- Positions persist in localStorage; new nodes are placed near neighbours, never a
  full re-layout.

## Run
- One terminal: ./start.sh (or .\start.ps1 on Windows)
- Backend only: cd backend && source venv/bin/activate && uvicorn api.main:app --reload
- Frontend only: cd frontend && npm run dev
- Re-ingest data: cd backend && python -m data.ingest
- Re-enrich edges: cd backend && python -m graph.enrichment
- Coverage report: cd backend && python -m graph.coverage
- Validate: cd backend && python validate_data.py
- Endpoint list: open http://localhost:8000/docs (don't duplicate it here)

## Known issues / data caveats
- yield_2y now comes from FRED DGS2 (ingest.py); re-run ingest, then enrichment.
- Most edges still lack empirical betas (an edge needs price/macro data on BOTH
  ends) and use the flagged fallback; coverage is the main limit on reach.
- hy_spreads is the HYG ETF *price*, which moves opposite to spreads; edges written
  as "spreads up -> X" get a contradicting sign and are rejected by the gate. Needs
  a true spread series (FRED ICE BofA series may have only a few years of history).
- fed_rate is a sparse step series (flat most months), so linear monthly betas
  from it are weak; policy *surprises* would model it better than level changes.
- The 0.10 fallback beta is unit-naive for rate nodes (percentage points); treat
  "est." results as placeholders, not forecasts.

## Planned (not started)
- AI tab: edit buttons on each parsed node/edge/section before commit
- Events tab: chronological sort / filter
- Expandable, resizable left panel
- Buy-side risk-desk layer: holdings -> node mapping, portfolio shock P&L with
  causal-path attribution, walk-forward beta validation and simulator backtest,
  multi-shock and reverse stress tests