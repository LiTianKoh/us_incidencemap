import { useState } from "react"
import { api } from "../api/client"

const SHOCK_SIZES = [
  { value: 0.5, label: "0.5σ" },
  { value: 1.0, label: "1σ"   },
  { value: 2.0, label: "2σ"   },
  { value: 3.0, label: "3σ"   },
]

const REGIMES = ["all", "zirp", "hiking", "easing", "risk_off", "normal"]

const REGIME_COLOURS = {
  all:      "bg-slate-700 text-slate-300",
  zirp:     "bg-blue-900 text-blue-300",
  hiking:   "bg-red-900 text-red-300",
  easing:   "bg-emerald-900 text-emerald-300",
  risk_off: "bg-orange-900 text-orange-300",
  normal:   "bg-slate-700 text-slate-300",
}

const CONFIDENCE_LABEL = { 1: "low", 2: "mod", 3: "high" }

export default function Simulator({ nodes, edges, onSimResult, currentRegime }) {
  const [sourceId, setSourceId] = useState("")
  const [shockStd, setShockStd] = useState(1.0)
  const [regime,   setRegime]   = useState(currentRegime ?? "all")
  const [running,  setRunning]  = useState(false)
  const [results,  setResults]  = useState(null)
  const [error,    setError]    = useState(null)
  const [expanded, setExpanded] = useState(null)

  const sortedNodes = [...nodes].sort((a, b) => a.label.localeCompare(b.label))

  async function runSimulation() {
    if (!sourceId) return
    setRunning(true)
    setError(null)
    setResults(null)
    setExpanded(null)

    try {
      const data = await api.simulate(sourceId, shockStd, regime)
      if (data.detail) throw new Error(data.detail)
      setResults(data)

      // Auto-highlight: source node + all affected nodes + all edges connecting them
      const affectedIds = new Set(data.results.map(r => r.node_id))
      const affectedEdges = (edges ?? []).filter(e =>
        (affectedIds.has(e.source) || e.source === sourceId) &&
        (affectedIds.has(e.target) || e.target === sourceId) &&
        (affectedIds.has(e.source) || affectedIds.has(e.target))
      )

      onSimResult?.({
        sourceNode: sourceId,
        path:       [...affectedIds],
        edges:      affectedEdges,
        net_direction: 0,
        total_lag_days: 0,
        isSimulation: true,
      })
    } catch (e) {
      setError(e.message)
    } finally {
      setRunning(false)
    }
  }

  const maxImpact = results
    ? Math.max(...results.results.map(r => Math.abs(r.impact_pct)), 0.001)
    : 1

  return (
    <div className="pb-4 space-y-4 text-sm">

      {/* Header */}
      <div className="px-4 pt-4">
        <h2 className="text-white font-semibold text-base">Counterfactual Simulator</h2>
        <p className="text-slate-500 text-xs mt-0.5">
          Shock a node and trace downstream impact via empirical betas
        </p>
      </div>

      {/* Controls */}
      <div className="px-4 space-y-3">

        {/* Source node */}
        <div>
          <label className="text-slate-400 text-xs block mb-1">Source node</label>
          <select
            value={sourceId}
            onChange={e => setSourceId(e.target.value)}
            className="w-full bg-slate-700 text-white rounded px-2 py-1.5 text-xs
                       border border-slate-600 focus:border-blue-500 focus:outline-none"
          >
            <option value="">— select a node —</option>
            {sortedNodes.map(n => (
              <option key={n.id} value={n.id}>{n.label}</option>
            ))}
          </select>
        </div>

        {/* Shock size */}
        <div>
          <label className="text-slate-400 text-xs block mb-1">Shock size</label>
          <div className="flex gap-1.5">
            {SHOCK_SIZES.map(s => (
              <button key={s.value} onClick={() => setShockStd(s.value)}
                className={`flex-1 py-1 rounded text-xs font-medium border transition-colors ${
                  shockStd === s.value
                    ? "bg-blue-600 border-blue-500 text-white"
                    : "bg-slate-700 border-slate-600 text-slate-400 hover:border-slate-400"
                }`}>
                {s.label}
              </button>
            ))}
          </div>
        </div>

        {/* Regime */}
        <div>
          <label className="text-slate-400 text-xs block mb-1">Regime for betas</label>
          <div className="flex flex-wrap gap-1.5">
            {REGIMES.map(r => (
              <button key={r} onClick={() => setRegime(r)}
                className={`px-2 py-0.5 rounded text-xs font-medium border transition-colors ${
                  regime === r
                    ? "border-blue-500 " + REGIME_COLOURS[r]
                    : "bg-slate-800 border-slate-600 text-slate-500 hover:border-slate-400"
                }`}>
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* Run button */}
        <button onClick={runSimulation} disabled={!sourceId || running}
          className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-700
                     disabled:text-slate-500 text-white rounded px-3 py-2 text-xs
                     font-medium transition-colors">
          {running ? "Simulating…" : "▶ Run simulation"}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="mx-4 bg-red-900/40 border border-red-700 rounded px-3 py-2">
          <p className="text-red-400 text-xs">{error}</p>
        </div>
      )}

      {/* Results */}
      {results && (
        <div className="px-4 space-y-2">

          {/* Summary */}
          <div className="flex items-center justify-between">
            <p className="text-slate-400 text-xs">
              <span className="text-white font-medium">{results.affected}</span> nodes affected
              {" · "}
              <span className={`px-1.5 py-0.5 rounded text-xs ${REGIME_COLOURS[results.regime]}`}>
                {results.regime}
              </span>
              {" · "}
              {results.shock_std}σ shock
            </p>
          </div>
          <p className="text-slate-600 text-xs">
            Source and affected nodes highlighted on graph. Click canvas to clear.
          </p>

          {/* Impact list */}
          <div className="space-y-1">
            {results.results.map((r, i) => (
              <div key={r.node_id} className="bg-slate-700 rounded overflow-hidden">

                {/* Main row */}
                <div
                  className="relative px-3 py-1.5 cursor-pointer hover:bg-slate-600 transition-colors"
                  onClick={() => setExpanded(expanded === i ? null : i)}
                >
                  <div
                    className={`absolute left-0 top-0 h-full opacity-20 rounded ${
                      r.impact > 0 ? "bg-emerald-500" : "bg-red-500"
                    }`}
                    style={{ width: `${(Math.abs(r.impact_pct) / maxImpact) * 100}%` }}
                  />
                  <div className="relative flex items-center justify-between gap-2">
                    <span className="text-slate-200 text-xs truncate flex-1">{r.label}</span>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className={`text-xs font-mono font-medium ${
                        r.impact > 0 ? "text-emerald-400" : "text-red-400"
                      }`}>
                        {r.impact > 0 ? "+" : ""}{r.impact_pct.toFixed(2)}%
                      </span>
                      <span className="text-slate-500 text-xs">{r.lag_days}d</span>
                      <span className="text-slate-600 text-xs">{expanded === i ? "▲" : "▼"}</span>
                    </div>
                  </div>
                </div>

                {/* Expanded detail */}
                {expanded === i && (
                  <div className="border-t border-slate-600 px-3 py-2 space-y-1.5">
                    <div className="flex gap-3 text-xs">
                      <span className="text-slate-500">
                        Hops: <span className="text-slate-300">{r.n_hops}</span>
                      </span>
                      <span className="text-slate-500">
                        Confidence: <span className="text-slate-300">
                          {CONFIDENCE_LABEL[Math.round(r.confidence)] ?? r.confidence}
                        </span>
                      </span>
                      <span className="text-slate-500">
                        Via: <span className="text-slate-300">{r.via}</span>
                      </span>
                    </div>
                    <p className="text-slate-500 text-xs font-mono">
                      {r.path.join(" → ")}
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>

          {results.affected === 0 && (
            <p className="text-slate-500 text-xs text-center py-4">
              No downstream nodes reached — check if this node has outgoing edges with empirical data.
            </p>
          )}
        </div>
      )}

      {/* Empty state */}
      {!results && !running && !error && (
        <p className="text-slate-600 text-xs text-center px-4 py-6">
          Select a node and run a simulation to see downstream impact.
        </p>
      )}
    </div>
  )
}
