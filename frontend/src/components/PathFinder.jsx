import { useState } from "react"
import { api } from "../api/client"

const DIRECTION_LABEL = { "1": "↑ positive", "-1": "↓ negative" }

export default function PathFinder({ nodes, onPathSelect }) {
  const [source, setSource]   = useState("")
  const [target, setTarget]   = useState("")
  const [results, setResults] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState(null)

  async function handleSearch() {
    if (!source || !target) return
    setLoading(true)
    setError(null)
    setResults(null)
    try {
      const data = await api.paths(source, target)
      setResults(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-4 space-y-4 text-sm">
      <h2 className="text-white font-semibold text-base">Path Finder</h2>

      {/* Source */}
      <div className="space-y-1">
        <label className="text-slate-400">From</label>
        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="w-full bg-slate-700 text-white rounded px-3 py-2 text-sm"
        >
          <option value="">Select source…</option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>{n.label}</option>
          ))}
        </select>
      </div>

      {/* Target */}
      <div className="space-y-1">
        <label className="text-slate-400">To</label>
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="w-full bg-slate-700 text-white rounded px-3 py-2 text-sm"
        >
          <option value="">Select target…</option>
          {nodes.map((n) => (
            <option key={n.id} value={n.id}>{n.label}</option>
          ))}
        </select>
      </div>

      {/* Search button */}
      <button
        onClick={handleSearch}
        disabled={!source || !target || loading}
        className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white rounded px-3 py-2 font-medium transition-colors"
      >
        {loading ? "Searching…" : "Find paths"}
      </button>

      {/* Error */}
      {error && <p className="text-red-400">{error}</p>}

      {/* Results */}
      {results && (
        <div className="space-y-2">
          <p className="text-slate-400">
            {results.paths_found} path{results.paths_found !== 1 ? "s" : ""} found
          </p>
          {results.paths_found === 0 && (
            <p className="text-slate-500">No causal path exists between these nodes.</p>
          )}
          {results.paths.map((p, i) => (
            <div
              key={i}
              onClick={() => onPathSelect?.(p)}
              className="bg-slate-700 hover:bg-slate-600 rounded p-3 cursor-pointer space-y-1 transition-colors"
            >
              {/* Path chain */}
              <div className="text-slate-200 text-xs flex flex-wrap gap-1 items-center">
                {p.path.map((nodeId, j) => (
                  <span key={nodeId} className="flex items-center gap-1">
                    <span className="bg-slate-600 px-1.5 py-0.5 rounded">{nodeId}</span>
                    {j < p.path.length - 1 && <span className="text-slate-500">→</span>}
                  </span>
                ))}
              </div>
              {/* Stats */}
              <div className="flex gap-3 text-xs text-slate-400">
                <span className={p.net_direction === 1 ? "text-emerald-400" : "text-red-400"}>
                  {DIRECTION_LABEL[String(p.net_direction)]}
                </span>
                <span>{p.total_lag_days}d total lag</span>
                <span>{p.hop_count} hop{p.hop_count !== 1 ? "s" : ""}</span>
                <span>conf: {p.avg_confidence}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}