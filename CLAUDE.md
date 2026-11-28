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
  data/    nodes.json, edges.json, events.json, ticker_map.json (ticker -> node),
           db.py, ingest.py, market_data.duckdb
  graph/   loader, queries, enrichment (edge stats), regimes, regime_tagger,
           simulator, portfolio (holdings shock P&L), coverage (report),
           backtest (walk-forward validation)
  api/     main.py (FastAPI)
frontend/src/
  api/client.js            fetch wrappers for every endpoint
  useUndo.js               shared undo/redo history hook
  App.jsx                  7-tab sidebar: inspector / paths / events / ai / sim / portfolio / validation
  components/              GraphCanvas, NodeInspector, PathFinder, EventPanel,
                           AIIngestion, Simulator, Portfolio, Validation, MiniChart,
                           TabBar (scrollable tabs with arrows)
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
  (dampening is a heuristic; tested and NOT tunable — multi-hop chains show no
  out-of-sample skill for any damping value. Results carry reliability: direct /
  chained (UI "chain" tag, indicative only) / guess ("est.")). Shocks are entered in natural units
  (bps for rate nodes, % for the rest) and propagated in the same native units the
  betas were estimated in. Only monthly betas are used, and a beta must pass a
  quality gate (R2 >= 0.02, n >= 20, sign agrees with the edge direction), else the
  flagged fallback (direction x 0.10) is used. Each result reports its own unit
  (% or bps), `fallback_hops` and `empirical`; the UI shows "est." for fallbacks.
- Multi-shock scenarios (simulator.simulate_scenario, POST /simulate/scenario; portfolio
  /portfolio/shock also takes `shocks`): several simultaneous shocks are propagated
  separately and ADDED per node (betas are linear). Each shock is an extra independent
  move, so if one shock also reaches another shocked node, that node's total includes
  both; `linked_shocks` flags this. Each result lists per-shock `contributions`. The
  Simulator and Portfolio tabs have "+ Add a simultaneous shock" rows.
- Portfolio shock (portfolio.py): holdings (ticker, value) map to nodes via
  data/ticker_map.json or an explicit node override. Equity-like holdings take the
  node's simulated return; bond holdings carry a duration (P&L% = -duration x yield
  change). Each line reports its causal path and whether it is empirical; est_share
  is the share of gross P&L resting on guessed betas. Unmapped holdings and holdings
  with no modelled path are reported, never dropped ("no path" is not "safe").
- Undo/redo (useUndo.js, ⌘/Ctrl+Z, Shift+⌘/Ctrl+Z, header buttons): node moves,
  Auto-layout (runs in place, no reload) and node/edge edits (label, description,
  notes, direction, confidence, lag, regimes — undo PATCHes the old values back).
  Not covered: colour edits and AI-ingestion commits. History is per session.
- Backtest (backtest.py): everything point-in-time — a month is predicted only from
  betas fitted on strictly earlier months (min 60 training months). Edge-level:
  out-of-sample R² vs. the expanding mean, sign hit rate (z vs. coin flip), beta
  sign flips, sign vs. stated direction, regime-matched-beta lift; verdict
  validated / weak / fails. Episode-level: replays Lehman, 2018 Q4, COVID, 2022
  hikes/long-end surge and SVB through the full simulator using only betas known
  before each episode. Source shocks are the realised source move over the window.
  The Validation tab shows the results (run/re-run button, edge table, episode
  replays; clicking an episode card highlights every affected node on the graph; a hop-depth
  table shows skill by path length — typical 1-hop paths beat predicting nothing, 2-3 hop chains do not) and the Inspector shows a validated/weak/fails badge on each edge.
- Sidebar: drag the handle to resize (width saved in localStorage, double-click to
  reset); the tab strip scrolls with ‹ › arrows when tabs overflow.
- Hub layout (hubLayout.js, "◎ Hub layout" button, undoable): hubs = best-connected ~12% of
  nodes (min 6 neighbours), spread apart so their rings never overlap; every other node sits
  on concentric rings around its most-connected hub, angled toward the other hubs it links
  to. Tunables are constants at the top of the file. Auto-layout (force-directed) remains.
- Positions persist in localStorage. With nothing saved (first run / Auto-layout) a
  one-off force-directed layout runs and is saved; afterwards new nodes are placed
  near neighbours and existing positions are never re-laid-out.

## Run
- One terminal: ./start.sh (or .\start.ps1 on Windows)
- Backend only: cd backend && source venv/bin/activate && uvicorn api.main:app --reload
- Frontend only: cd frontend && npm run dev
- Re-ingest data: cd backend && python -m data.ingest
- Re-enrich edges: cd backend && python -m graph.enrichment
- Coverage report: cd backend && python -m graph.coverage
- Walk-forward backtest: cd backend && python -m graph.backtest  (writes
  data/backtest_results.json, served at GET /backtest; POST /backtest/run re-runs it)
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
- Regime monitor (tentative): the regime is rule-based on FEDFUNDS + VIX only (no
  news). Add a daily 'nowcast' (latest VIX + DFF, labelled provisional until month
  close), an as-of date / staleness warning on the badge, incremental refresh (button
  + on backend start), optional hysteresis around the VIX threshold. Caveat: the
  backtest shows regime-matched betas do not yet beat all-history betas out of sample.
- Risk-desk layer, remaining: reverse stress tests, path-level P&L attribution
  (portfolio shock P&L itself is built)