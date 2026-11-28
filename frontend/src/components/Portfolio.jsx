import { useState, useEffect } from "react"
import { api } from "../api/client"

const LS_KEY = "incidence-holdings"
const EXAMPLE = `# ticker, value (USD; negative = short), optional node override
SPY, 100000
XLK, 50000
TLT, 40000
GLD, 20000
HYG, 10000
NVDA, 30000`

const STATUS_NOTE = {
  no_path:        "no modelled path from this shock",
  needs_duration: "rate node — add a duration",
  no_shock_size:  "shock size unknown",
}

function parseHoldings(text) {
  const out = []
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const [ticker, value, node] = line.split(/[,\t]+/).map(s => s.trim())
    if (!ticker || /^ticker$/i.test(ticker)) continue
    const v = parseFloat((value ?? "").replace(/[$,]/g, ""))
    out.push({ ticker, value: isNaN(v) ? null : v, ...(node ? { node } : {}) })
  }
  return out
}

const money = (x) =>
  (x < 0 ? "-" : x > 0 ? "+" : "") + "$" + Math.abs(Math.round(x)).toLocaleString()

export default function Portfolio({ nodes, currentRegime, onSimResult }) {
  const [text,     setText]     = useState(() => {
    try { return localStorage.getItem(LS_KEY) ?? EXAMPLE } catch { return EXAMPLE }
  })
  const [sourceId, setSourceId] = useState("")
  const [shock,    setShock]    = useState("")
  const [regime,   setRegime]   = useState(currentRegime ?? "all")
  const [sigmas,   setSigmas]   = useState({})
  const [extra,    setExtra]    = useState([])   // extra simultaneous shocks [{node, value}]
  const [running,  setRunning]  = useState(false)
  const [result,   setResult]   = useState(null)
  const [error,    setError]    = useState(null)

  useEffect(() => { api.nodeSigmas().then(setSigmas).catch(() => {}) }, [])
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, text) } catch { /* ignore */ }
  }, [text])

  const sorted = [...(nodes ?? [])].sort((a, b) =>
    (a.label ?? a.id).localeCompare(b.label ?? b.id))
  const unit   = sigmas[sourceId]?.unit ?? "%"
  const shockN = parseFloat(shock)

  async function run() {
    if (!sourceId || isNaN(shockN)) return
    const holdings = parseHoldings(text)
    if (holdings.length === 0) { setError("Add at least one holding."); return }
    setRunning(true); setError(null); setResult(null)
    try {
      const extras = extra.filter(x => x.node && x.value !== "" && !isNaN(parseFloat(x.value)))
      if (extras.some(x => x.node === sourceId) || new Set(extras.map(x => x.node)).size !== extras.length)
        throw new Error("Each node can only be shocked once — combine duplicates into one shock.")
      const payload = extras.length
        ? { holdings, regime, shocks: [{ node_id: sourceId, shock_real: shockN },
              ...extras.map(x => ({ node_id: x.node, shock_real: parseFloat(x.value) }))] }
        : { holdings, node_id: sourceId, shock_real: shockN, regime }
      const res = await fetch("http://localhost:8000/portfolio/shock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const data = await res.json()
      if (data.detail) throw new Error(typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail))
      setResult(data)
      onSimResult?.(null)
    } catch (e) {
      setError(e.message)
    } finally {
      setRunning(false)
    }
  }

  function highlight(h) {
    if (!h.path || h.path.length < 2) return
    const edges = h.path.slice(0, -1).map((s, i) => ({ source: s, target: h.path[i + 1] }))
    onSimResult?.({
      sourceNode: sourceId, path: h.path, edges,
      net_direction: 0, total_lag_days: h.lag_days, isSimulation: true,
    })
  }

  const maxPnl = result ? Math.max(...result.holdings.map(h => Math.abs(h.pnl)), 1) : 1

  return (
    <div className="p-4 space-y-4 text-sm">
      <div>
        <h2 className="text-white font-semibold text-base">Portfolio shock</h2>
        <p className="text-slate-500 text-xs mt-1">
          Apply a shock and see the P&amp;L it implies, with the causal path behind each line.
        </p>
      </div>

      <div className="space-y-1">
        <div className="flex justify-between">
          <label className="text-slate-400">Holdings</label>
          <button onClick={() => setText(EXAMPLE)}
                  className="text-xs text-slate-500 hover:text-slate-300">load example</button>
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={7}
          spellCheck={false}
          className="w-full bg-slate-700 text-slate-100 rounded px-3 py-2 text-xs font-mono"
          placeholder="ticker, value[, node]"
        />
        <p className="text-slate-600 text-xs">
          One per line: <span className="font-mono">ticker, USD value</span>. Optional third
          column overrides the graph node.
        </p>
      </div>

      <div className="space-y-1">
        <label className="text-slate-400">Shock this node</label>
        <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}
                className="w-full bg-slate-700 text-white rounded px-3 py-2 text-sm">
          <option value="">Select node…</option>
          {sorted.map(n => <option key={n.id} value={n.id}>{n.label ?? n.id}</option>)}
        </select>
      </div>

      <div className="flex gap-2 items-center">
        <input
          type="number" value={shock} onChange={(e) => setShock(e.target.value)}
          placeholder="e.g. 25"
          className="flex-1 bg-slate-700 text-white rounded px-3 py-2 text-sm"
        />
        <span className="text-slate-400 w-8">{unit}</span>
      </div>

      <div>
        {extra.map((x, i) => (
          <div key={i} className="flex items-center gap-1.5 mb-1.5">
            <select value={x.node}
              onChange={(e) => setExtra(ex => ex.map((y, j) => j === i ? { ...y, node: e.target.value } : y))}
              className="flex-1 min-w-0 bg-slate-700 text-white rounded px-2 py-1.5 text-xs">
              <option value="">Select node…</option>
              {sorted.map(n => <option key={n.id} value={n.id}>{n.label ?? n.id}</option>)}
            </select>
            <input type="number" value={x.value} placeholder={sigmas[x.node]?.unit ?? "%"}
              onChange={(e) => setExtra(ex => ex.map((y, j) => j === i ? { ...y, value: e.target.value } : y))}
              className="w-20 bg-slate-700 text-white rounded px-2 py-1.5 text-xs" />
            <span className="text-slate-500 text-xs w-6">{sigmas[x.node]?.unit ?? "%"}</span>
            <button onClick={() => setExtra(ex => ex.filter((_, j) => j !== i))}
              className="text-slate-500 hover:text-red-400 text-xs" title="Remove shock">✕</button>
          </div>
        ))}
        <button onClick={() => setExtra(ex => [...ex, { node: "", value: "" }])}
          className="text-blue-400 hover:text-blue-300 text-xs">+ Add a simultaneous shock</button>
      </div>

      <div className="flex flex-wrap gap-1">
        {["all", "zirp", "hiking", "easing", "risk_off", "normal"].map(r => (
          <button key={r} onClick={() => setRegime(r)}
                  className={`px-2 py-0.5 rounded text-xs border ${
                    regime === r ? "border-blue-500 text-white bg-slate-600"
                                 : "border-slate-600 text-slate-400 hover:text-slate-200"}`}>
            {r}
          </button>
        ))}
      </div>

      <button onClick={run} disabled={!sourceId || isNaN(shockN) || running}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white rounded px-3 py-2 font-medium transition-colors">
        {running ? "Running…" : "▶ Run portfolio shock"}
      </button>

      {error && <p className="text-red-400">{error}</p>}

      {result && (
        <div className="space-y-3">
          <div className="bg-slate-700 rounded p-3 space-y-1">
            <p className="text-slate-400 text-xs">
              {result.shocks
                ? result.shocks.map(x => `${x.node_id} ${x.shock_real > 0 ? "+" : ""}${x.shock_real}${x.unit}`).join(" · ")
                : <>{result.source} {result.shock_real > 0 ? "+" : ""}{result.shock_real}{result.unit}</>}
              {" · "}{result.regime} regime
            </p>
            <p className={`text-xl font-semibold ${result.total_pnl < 0 ? "text-red-400" : "text-emerald-400"}`}>
              {money(result.total_pnl)}
              {result.total_pnl_pct != null && (
                <span className="text-sm font-normal text-slate-400">
                  {"  "}({(result.total_pnl_pct * 100).toFixed(2)}%)
                </span>
              )}
            </p>
            {result.est_share != null && (
              <p className={`text-xs ${result.est_share > 0.5 ? "text-amber-400" : "text-slate-500"}`}>
                {Math.round(result.est_share * 100)}% of gross P&amp;L rests on guessed (non-empirical) betas
              </p>
            )}
          </div>

          <div className="space-y-1">
            {result.holdings.map((h, i) => (
              <div key={i} onClick={() => highlight(h)}
                   className="relative bg-slate-700 hover:bg-slate-600 rounded px-3 py-2 cursor-pointer overflow-hidden">
                <div className={`absolute inset-y-0 left-0 opacity-25 ${h.pnl < 0 ? "bg-red-500" : "bg-emerald-500"}`}
                     style={{ width: `${(Math.abs(h.pnl) / maxPnl) * 100}%` }} />
                <div className="relative flex justify-between items-center gap-2">
                  <span className="text-slate-100 text-xs font-mono">{h.ticker}</span>
                  <span className="text-slate-500 text-xs truncate flex-1">→ {h.node}</span>
                  {!h.empirical && <span className="text-amber-500 text-xs" title="path uses guessed betas">est.</span>}
                  <span className={`text-xs font-mono ${h.pnl < 0 ? "text-red-400" : h.pnl > 0 ? "text-emerald-400" : "text-slate-500"}`}>
                    {money(h.pnl)}
                  </span>
                </div>
                <div className="relative text-xs text-slate-500 mt-0.5">
                  {h.status !== "ok"
                    ? STATUS_NOTE[h.status] ?? h.status
                    : h.path.join(" → ") + (h.duration ? `  ·  duration ${h.duration}` : "")}
                </div>
              </div>
            ))}
          </div>

          {result.unmapped.length > 0 && (
            <div className="text-xs text-amber-400 space-y-0.5">
              <p>Not in the graph (excluded from P&amp;L):</p>
              {result.unmapped.map((u, i) => (
                <p key={i} className="text-slate-400 font-mono">{u.ticker} — {u.reason}</p>
              ))}
            </div>
          )}
          <p className="text-slate-600 text-xs">
            “No modelled path” means the graph has no route from this shock, not that the
            holding is safe. Click a row to highlight its path.
          </p>
        </div>
      )}
    </div>
  )
}