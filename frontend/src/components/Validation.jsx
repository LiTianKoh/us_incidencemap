import { useState, useMemo } from "react"

const VERDICT_STYLE = {
  validated: "bg-emerald-900 text-emerald-300",
  weak:      "bg-amber-900 text-amber-300",
  fails:     "bg-red-900 text-red-300",
}
const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`)

function Stat({ label, value, tone = "text-white" }) {
  return (
    <div className="bg-slate-700 rounded px-3 py-2">
      <p className="text-slate-500 text-xs">{label}</p>
      <p className={`text-lg font-semibold ${tone}`}>{value}</p>
    </div>
  )
}

function EdgeTable({ edges, onHighlight }) {
  const [filter, setFilter] = useState("all")
  const [sort,   setSort]   = useState("oos_r2")
  const [open,   setOpen]   = useState(null)

  const rows = useMemo(() => {
    const f = filter === "all" ? edges : edges.filter(e => e.verdict === filter)
    return [...f].sort((a, b) => (b[sort] ?? -Infinity) - (a[sort] ?? -Infinity))
  }, [edges, filter, sort])

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1">
        {["all", "validated", "weak", "fails"].map(f => (
          <button key={f} onClick={() => setFilter(f)}
                  className={`px-2 py-0.5 rounded text-xs border ${
                    filter === f ? "border-blue-500 text-white bg-slate-600"
                                 : "border-slate-600 text-slate-400 hover:text-slate-200"}`}>
            {f}
          </button>
        ))}
        <select value={sort} onChange={(e) => setSort(e.target.value)}
                className="ml-auto bg-slate-700 text-slate-300 text-xs rounded px-2 py-0.5">
          <option value="oos_r2">sort: OOS R²</option>
          <option value="hit_z">sort: hit z-score</option>
          <option value="n_oos">sort: months tested</option>
        </select>
      </div>

      <div className="space-y-1">
        {rows.map((e) => {
          const key = `${e.source}__${e.target}`
          const isOpen = open === key
          return (
            <div key={key} className="bg-slate-700 rounded overflow-hidden">
              <div
                onClick={() => {
                  setOpen(isOpen ? null : key)
                  onHighlight?.({ path: [e.source, e.target] })
                }}
                className="px-3 py-1.5 cursor-pointer hover:bg-slate-600 flex items-center gap-2"
              >
                <span className="text-xs text-slate-200 flex-1 truncate">
                  {e.source} → {e.target}
                </span>
                <span className="text-xs text-slate-400 font-mono">R² {e.oos_r2}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${VERDICT_STYLE[e.verdict]}`}>
                  {e.verdict}
                </span>
              </div>
              {isOpen && (
                <div className="border-t border-slate-600 px-3 py-2 text-xs text-slate-400 space-y-0.5">
                  <p>Hit rate {pct(e.hit_rate)} (z {e.hit_z}) over {e.n_oos} months from {e.first_oos}
                    {e.hit_big != null && <> · on big source moves {pct(e.hit_big)}</>}</p>
                  <p>Fitted beta: median {e.beta_median}, latest {e.beta_last}; flipped sign {e.beta_flips}×</p>
                  <p>Regime-matched betas: OOS R² {e.oos_r2_regime}
                    {" "}({e.regime_lift >= 0 ? "+" : ""}{e.regime_lift} vs all-history)</p>
                  <p>Stated: {e.direction === 1 ? "positive" : "negative"}, confidence {e.confidence ?? "—"}
                    {!e.sign_ok && <span className="text-red-400"> · measured sign contradicts this</span>}</p>
                </div>
              )}
            </div>
          )
        })}
        {rows.length === 0 && <p className="text-slate-500 text-xs">No edges in this group.</p>}
      </div>
    </div>
  )
}

function Episode({ ep, onHighlight, onHighlightAll }) {
  const [open, setOpen] = useState(false)
  if (ep.error) {
    return (
      <div className="bg-slate-700 rounded px-3 py-2">
        <p className="text-slate-200 text-sm">{ep.name}</p>
        <p className="text-slate-500 text-xs">{ep.error}</p>
      </div>
    )
  }
  const scaleNote =
    ep.median_scale == null ? null
    : ep.median_scale < 0.8 ? "understates"
    : ep.median_scale > 1.25 ? "overstates" : "about right"

  return (
    <div className="bg-slate-700 rounded overflow-hidden">
      <div
        onClick={() => { setOpen(!open); onHighlightAll?.(ep) }}
        title="Click to highlight every affected node on the graph"
        className="px-3 py-2 cursor-pointer hover:bg-slate-600 space-y-1"
      >
        <div className="flex justify-between items-baseline gap-2">
          <span className="text-slate-100 text-sm font-medium">{ep.name}</span>
          <span className="text-slate-500 text-xs">{open ? "▲" : "▼"}</span>
        </div>
        <p className="text-slate-400 text-xs">
          {ep.source} {ep.source_move > 0 ? "+" : ""}{ep.source_move}{ep.unit} · {ep.window} ·
          betas known through {ep.betas_through}
        </p>
        {ep.n_affected != null && (
          <p className="text-slate-500 text-xs">
            {ep.n_affected} nodes affected · {ep.n_scored} have price data to score
          </p>
        )}
        <p className="text-xs text-slate-300">
          Signs right {pct(ep.hit_rate_all)} of {ep.n_scored} nodes
          {ep.hit_rate_empirical != null && <> ({pct(ep.hit_rate_empirical)} on {ep.n_empirical} empirical-beta nodes)</>}
          {ep.median_scale != null && <> · size {ep.median_scale}× realised — <span className={scaleNote === "about right" ? "text-emerald-400" : "text-amber-400"}>{scaleNote}</span></>}
        </p>
      </div>
      {open && (
        <div className="border-t border-slate-600 px-3 py-2 space-y-1">
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 text-xs text-slate-500">
            <span>node (hops)</span><span className="text-right">predicted</span><span className="text-right">actual</span>
          </div>
          {ep.nodes.map((n) => (
            <div key={n.node}
                 onClick={() => onHighlight?.({ path: n.path, sourceNode: ep.source })}
                 className="grid grid-cols-[1fr_auto_auto] gap-x-3 text-xs cursor-pointer hover:bg-slate-600 rounded px-1">
              <span className="text-slate-300 truncate">
                {n.node} ({n.n_hops}){!n.empirical && <span className="text-amber-500"> est.</span>}
              </span>
              <span className={`text-right font-mono ${n.sign_hit === false ? "text-red-400" : "text-slate-300"}`}>
                {n.predicted}{n.unit}
              </span>
              <span className="text-right font-mono text-slate-400">{n.realised}{n.unit}</span>
            </div>
          ))}
          <p className="text-slate-600 text-xs pt-1">
            Red = wrong sign. Source move is the realised move, so this tests propagation, not forecasting the source.
          </p>
        </div>
      )}
    </div>
  )
}

export default function Validation({ backtest, onRun, onHighlight }) {
  const [view,    setView]    = useState("edges")
  const [running, setRunning] = useState(false)
  const [error,   setError]   = useState(null)

  async function run() {
    setRunning(true); setError(null)
    try { await onRun() } catch (e) { setError(e.message) } finally { setRunning(false) }
  }

  const s = backtest?.summary
  const regimeHelps = s && s.regime_layer.median_lift > 0

  function highlight(h) {
    if (!h?.path || h.path.length < 2) return
    const edges = h.path.slice(0, -1).map((src, i) => ({ source: src, target: h.path[i + 1] }))
    onHighlight?.({ sourceNode: h.sourceNode ?? h.path[0], path: h.path, edges,
                    net_direction: 0, total_lag_days: 0, isSimulation: true })
  }

  // Highlight the whole episode: the shocked node, every affected node, every edge used
  function highlightEpisode(ep) {
    const items = ep.affected ?? ep.nodes ?? []
    const nodeSet = new Set([ep.source])
    const edgeSet = new Map()
    items.forEach((it) => {
      it.path.forEach((n) => nodeSet.add(n))
      it.path.slice(0, -1).forEach((src, i) => {
        edgeSet.set(`${src}__${it.path[i + 1]}`, { source: src, target: it.path[i + 1] })
      })
    })
    onHighlight?.({ sourceNode: ep.source, path: [...nodeSet], edges: [...edgeSet.values()],
                    net_direction: 0, total_lag_days: 0, isSimulation: true })
  }

  return (
    <div className="p-4 space-y-4 text-sm">
      <div>
        <h2 className="text-white font-semibold text-base">Validation</h2>
        <p className="text-slate-500 text-xs mt-1">
          Walk-forward backtest: each month is predicted from betas fitted on earlier months only.
        </p>
      </div>

      <button onClick={run} disabled={running}
              className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white rounded px-3 py-2 font-medium transition-colors">
        {running ? "Running backtest… (10–30 s)" : backtest ? "↻ Re-run backtest" : "▶ Run backtest"}
      </button>
      {error && <p className="text-red-400 text-xs">{error}</p>}

      {!backtest && !running && (
        <p className="text-slate-500 text-xs">
          No results yet. Run the backtest to see which edges hold up out of sample.
        </p>
      )}

      {backtest && s && (
        <>
          <p className="text-slate-600 text-xs">Last run {new Date(backtest.generated_at).toLocaleString()}</p>

          <div className="grid grid-cols-3 gap-2">
            <Stat label="validated" value={s.validated} tone="text-emerald-400" />
            <Stat label="weak"      value={s.weak}      tone="text-amber-400" />
            <Stat label="fails"     value={s.fails}     tone="text-red-400" />
          </div>

          <div className="bg-slate-700 rounded px-3 py-2 space-y-1 text-xs text-slate-300">
            <p>{s.n_edges_tested} edges tested · median out-of-sample R² {s.median_oos_r2}</p>
            <p>{s.sign_contradicts_direction} edges have a measured sign that contradicts the stated direction.</p>
            <p>
              Validated by your confidence score:{" "}
              {Object.entries(s.by_edge_confidence).map(([c, v]) =>
                `${c}: ${pct(v.validated)}`).join(" · ")}
            </p>
            <p className={regimeHelps ? "text-emerald-400" : "text-amber-400"}>
              Regime layer: regime-matched betas improved {pct(s.regime_layer.share_improved)} of edges
              (median OOS R² lift {s.regime_layer.median_lift}) —{" "}
              {regimeHelps ? "adds out-of-sample value." : "not yet adding out-of-sample value."}
            </p>
          </div>

          {backtest.hop_depth && (
            <div className="bg-slate-700 rounded px-3 py-2 text-xs text-slate-300 space-y-1">
              <p className="text-slate-100 font-medium">Skill by hop depth</p>
              <p className="text-slate-500">
                Out-of-sample, gated like the live simulator. Skill = 1 − error ÷ error of predicting no move; above 0 beats doing nothing.
              </p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500 text-left">
                    <th className="font-normal">Hops</th><th className="font-normal">Paths</th>
                    <th className="font-normal">Typical skill</th><th className="font-normal">Beat zero</th>
                  </tr>
                </thead>
                <tbody>
                  {backtest.hop_depth.by_depth.map((r) => (
                    <tr key={r.hops}>
                      <td>{r.hops}</td><td>{r.paths}</td>
                      <td className={r.median_path_skill > 0.02 ? "text-emerald-400" : "text-amber-400"}>
                        {r.median_path_skill == null ? "—" : `${(r.median_path_skill * 100).toFixed(1)}%`}
                      </td>
                      <td>{r.share_beating_zero == null ? "—" : pct(r.share_beating_zero)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-slate-500">
                Typical = median across paths (pooled skill is dragged by a few outlier paths). Results tagged “chain” in the Simulator are the 2+ hop rows.
              </p>
            </div>
          )}

          <div className="flex gap-1">
            {[["edges", "Edges"], ["episodes", "Episodes"]].map(([k, l]) => (
              <button key={k} onClick={() => setView(k)}
                      className={`flex-1 px-2 py-1 rounded text-xs border ${
                        view === k ? "border-blue-500 text-white bg-slate-600"
                                   : "border-slate-600 text-slate-400 hover:text-slate-200"}`}>
                {l}
              </button>
            ))}
          </div>

          {view === "edges" && <EdgeTable edges={backtest.edges} onHighlight={highlight} />}
          {view === "episodes" && (
            <div className="space-y-2">
              {backtest.episodes.map((ep) => <Episode key={ep.name} ep={ep} onHighlight={highlight} onHighlightAll={highlightEpisode} />)}
            </div>
          )}
        </>
      )}
    </div>
  )
}
