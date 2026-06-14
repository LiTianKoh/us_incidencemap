# INCIDENCE — User Guide

INCIDENCE is a causal diagram tool for the US financial market. It lets you
explore how shocks propagate through the system, trace causal paths between
any two market nodes, replay historical events, and run counterfactual
simulations using empirically derived relationships.

---

## Getting Started

### Prerequisites
- Python 3.11+
- Node.js 18+
- A FRED API key (free at https://fred.stlouisfed.org/docs/api/api_key.html)

### Installation

```bash
# Clone the repo
git clone <repo-url>
cd causal-map

# Backend
cd backend
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install fastapi uvicorn networkx duckdb pandas yfinance fredapi python-dotenv

# Create .env file in backend/
echo "FRED_API_KEY=your_key_here" > .env

# Initialise database and ingest 25 years of data
python -m data.db
python -m data.ingest

# Run empirical enrichment (computes correlations + betas for all edges)
python -m graph.enrichment

# Auto-tag edges with regime activity
python -m graph.regime_tagger

# Start backend
uvicorn api.main:app --reload
```

```bash
# Frontend (new terminal)
cd frontend
npm install
npm run dev
```

Open http://localhost:5173 in your browser.

---

## Interface Overview

The interface has two areas: a left sidebar with five tabs, and the main
graph canvas on the right.

### The Graph Canvas

The canvas shows all nodes and edges of the causal map. Node colours
indicate type (blue = actor, green = market, amber = indicator, purple =
sector). Arrow colours indicate relationship direction (green = positive
causation, red = negative causation).

**Navigating the graph**
- Scroll to zoom, click and drag to pan
- Drag individual nodes to reposition them — positions are saved automatically
- Click a node to open it in the Inspector tab
- Click the canvas background to deselect and clear any active highlights
- ↺ Auto-layout — clears saved positions and re-runs the force-directed layout
- ⊞ Reset view — fits the entire graph to the screen

**Regime badge**
A coloured badge in the top-left corner shows the current market regime
(ZIRP, Hiking, Easing, Risk-Off, or Normal) and when it started. Edges that
are empirically inactive in the current regime are faded to near-invisible.

**Colour editor**
Click 🎨 Colours in the bottom-left to open the floating colour editor. From
here you can customise:
- Node type colours (affects all nodes of that type)
- Individual node colours (click a node while the panel is open to add an override)
- Positive and negative arrow colours
- Node highlight ring colour and source node highlight colour
- Highlighted arrow colours (separate for positive and negative)

All colour settings are saved to your browser's local storage and persist
across sessions. Click "Reset all" to restore defaults.

---

## The Five Tabs

### Inspector

Click any node on the canvas to inspect it. The Inspector shows the node's
type, label, description, and a price chart (for market nodes with price data).

**Editing a node** — click ✎ Edit node to change its label or description.
Changes are saved to `nodes.json` immediately.

**Exploring edges** — the Inspector lists all upstream (driven by) and
downstream (affects) neighbours. Click ▼ on any edge row to expand it and
see:
- Edge label, confidence level, and notes
- Empirical stats: **r** (correlation), **β** (beta), **R²** (explained
  variance), **n** (observations)
- A frequency badge (daily or monthly) indicating which data frequency
  produced the best fit
- A regime badge when the displayed stats are regime-specific rather than
  computed over the full history

**Editing an edge** — click ✎ Edit this edge inside the expanded row to
modify the label, notes, direction, confidence, lag, and which regimes the
edge is active in. Regime checkboxes let you manually override the
auto-tagged regime activity.

### Paths

Find all causal paths between any two nodes. Select a source and target node,
set a maximum number of paths, and click Find Paths. Results are sorted by
total lag (fastest paths first) and show the net direction, average
confidence, and hop count for each path. Click a path to highlight it on the
canvas.

### Events

A log of historical market events. Click any event to expand it and see:
- The affected nodes, highlighted on the canvas with their connecting edges
- Price charts for market nodes showing performance indexed to 100 at the
  event date

Click the canvas background to clear the event highlight.

Events are added via the AI tab and stored in `events.json`.

### AI

The AI tab lets you ingest new events from news articles using Claude.

1. Click **Copy context** — this copies a structured prompt to your clipboard
   containing the full graph schema and all existing nodes
2. Open a new Claude chat, paste the context, then paste the news article
   you want to ingest
3. Claude returns a JSON proposal containing the event, any new nodes, and
   any new edges
4. Paste the JSON into the text area in the AI tab
5. Review the proposal — inspect the event details, new nodes, and new edges
6. Click **Commit** to write everything to `events.json`, `nodes.json`, and
   `edges.json`

The graph reloads automatically after a commit.

### Sim (Counterfactual Simulator)

The simulator lets you ask: *if this node were shocked by N standard
deviations, what would happen downstream?*

1. Select a **source node** from the dropdown
2. Choose a **shock size** — 0.5σ, 1σ, 2σ, or 3σ
3. Select a **regime** for the betas to use — "all" uses the full historical
   relationship; a specific regime uses only data from that period
4. Click **▶ Run simulation**

The source node (white ring) and all affected nodes (amber ring) are
immediately highlighted on the canvas, along with all connecting edges.
Click the canvas background to clear the highlight.

Results appear as a ranked list sorted by absolute impact. Each row shows:
- Estimated percentage impact (signed — green for positive, red for negative)
- A proportional impact bar for quick visual comparison
- Total lag in days to feel the effect

Click any result row to expand it and see the number of hops, mean path
confidence, the immediate upstream node, and the full causal path taken.

---

## Understanding the Empirical Stats

When you expand an edge in the Inspector, you see four numbers:

| Stat | Meaning |
|------|---------|
| **r** | Pearson correlation between the two nodes' return series at the best lag. Range −1 to +1. Tells you whether and in which direction they move together. |
| **β** | Regression beta (slope). How many units the target moves per 1 unit move in the source. A β of 0.6 means a 1% move in the source historically produces a ~0.6% move in the target. |
| **R²** | Fraction of the target's variance explained by the source. R² = 0.25 means the source explains 25% of the target's moves. Low R² means the relationship is real but noisy. |
| **n** | Number of observations in the regression. Low n means less reliable — treat it with more scepticism. |

The **freq badge** (daily or monthly) tells you which data frequency produced
the best R². Monthly stats are generally more meaningful for macro
relationships since they filter out daily microstructure noise.

The **regime badge** (orange) appears when the displayed stats are specific
to a regime rather than the full history. Regime-specific betas are more
relevant when the current regime matches — for example, the relationship
between yields and equities behaves very differently in ZIRP versus a hiking
cycle.

---

## Understanding Regimes

INCIDENCE classifies each month in history into one of five regimes based on
FEDFUNDS and VIX data:

| Regime | Condition |
|--------|-----------|
| **Risk-Off** | VIX > 28 (takes priority over all rate regimes) |
| **Zero Interest-Rate Policy (ZIRP)** | Fed funds rate < 0.5% |
| **Hiking** | Fed funds 3-month delta > +0.25% |
| **Easing** | Fed funds 3-month delta < −0.25% |
| **Normal** | Everything else |

Edges are auto-tagged with the regimes in which they show a meaningfully
stronger relationship (≥25% R² lift over the full-history baseline). These
tags drive the canvas fading — edges whose `regimes` list doesn't include the
current regime are shown at very low opacity, indicating they are likely
dormant right now.

You can override any edge's regime tags manually via the edge editor in the
Inspector tab.

---

## Maintaining the Graph

### Adding nodes and edges manually

Edit `backend/data/nodes.json` and `backend/data/edges.json` directly.
Follow the existing schema. After editing, restart the backend or the graph
will reload automatically on the next API call.

### Re-ingesting price data

```bash
cd backend
python -m data.ingest
```

This pulls the latest data from Yahoo Finance and FRED. Run periodically to
keep the database current.

### Re-running enrichment

```bash
python -m graph.enrichment
```

Recomputes all edge statistics (daily + monthly, across all regimes). Run
after ingesting new data or adding new edges. Takes several minutes for 83
edges × 6 regimes.

### Re-tagging regimes

```bash
python -m graph.regime_tagger
```

Re-runs the auto-tagger and updates the `regimes` array on all edges in
`edges.json`. Run after re-enrichment. Use `preserve_manual=True` (default)
to keep any regime tags you have manually set.

---

## Data Sources

| Series | Source | Node |
|--------|--------|------|
| S&P 500 | Yahoo Finance (^GSPC) | spx |
| VIX | Yahoo Finance (^VIX) | vix |
| Gold | Yahoo Finance (GC=F) | xauusd |
| WTI Crude | Yahoo Finance (CL=F) | wti |
| US Dollar Index | Yahoo Finance (DX-Y.NYB) | dxy |
| 2Y Treasury Yield | Yahoo Finance (^IRX) | yield_2y |
| 10Y Treasury Yield | Yahoo Finance (^TNX) | yield_10y |
| EUR/USD | Yahoo Finance (EURUSD=X) | eurusd |
| GBP/USD | Yahoo Finance (GBPUSD=X) | gbpusd |
| USD/JPY | Yahoo Finance (JPY=X) | usdjpy |
| Energy (XLE) | Yahoo Finance | sec_energy |
| Financials (XLF) | Yahoo Finance | sec_financials |
| Technology (XLK) | Yahoo Finance | sec_tech |
| Utilities (XLU) | Yahoo Finance | sec_utilities |
| Real Estate (XLRE) | Yahoo Finance | sec_realestate |
| HY Spreads (HYG) | Yahoo Finance | hy_spreads |
| Fed Funds Rate | FRED (FEDFUNDS) | fed_rate |
| CPI | FRED (CPIAUCSL) | cpi |
| PCE | FRED (PCEPI) | pce |
| Non-Farm Payrolls | FRED (PAYEMS) | nfp |
| Unemployment Rate | FRED (UNRATE) | unemployment |
| GDP | FRED (GDP) | gdp |

---

## Keyboard & Interaction Reference

| Action | How |
|--------|-----|
| Select a node | Click it |
| Deselect / clear highlights | Click canvas background |
| Pan | Click and drag canvas |
| Zoom | Scroll wheel |
| Move a node | Click and drag the node |
| Reset layout | ↺ Auto-layout button |
| Fit graph to screen | ⊞ Reset view button |
| Open colour editor | 🎨 Colours button |
| Expand edge stats | ▼ button on any edge row |
| Edit a node | ✎ Edit node button in Inspector |
| Edit an edge | ✎ Edit this edge in expanded edge row |
