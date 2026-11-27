import { useState } from "react"
import { api } from "../api/client"
import MiniChart from "./MiniChart"

const DIRECTION_LABEL = { "1": "positive ↑", "-1": "negative ↓" }
const CONFIDENCE_LABEL = { 1: "low", 2: "moderate", 3: "high" }
const CONFIDENCE_OPTIONS = [1, 2, 3]
const TYPE_COLOURS = {
  actor:     "bg-blue-500",
  market:    "bg-emerald-500",
  indicator: "bg-amber-500",
  sector:    "bg-purple-500",
}
const HAS_PRICES = new Set([
  "spx","vix","xauusd","wti","dxy","yield_2y","yield_10y",
  "eurusd","gbpusd","usdjpy","sec_energy","sec_financials",
  "sec_tech","sec_utilities","sec_realestate","hy_spreads",
  "bitcoin","ethereum","coinbase_stock"
])

const VERDICT_STYLE = {
  validated: "bg-emerald-900 text-emerald-300",
  weak:      "bg-amber-900 text-amber-300",
  fails:     "bg-red-900 text-red-300",
}

function EdgeRow({ label, edge, nodeLabel, source, target, currentRegime, onEdit, bt }) {
  const [expanded,     setExpanded]     = useState(false)
  const [stats,        setStats]        = useState(null)   // displayed row or false
  const [allRows,      setAllRows]      = useState(null)   // all fetched rows
  const [loadingStats, setLoadingStats] = useState(false)

  function pickBest(rows, regimeLabel) {
    if (!rows || rows.length === 0) return false
    // Prefer rows matching current regime; fall back to 'all'
    const regimeRows = regimeLabel
      ? rows.filter(r => r.regime === regimeLabel)
      : []
    const pool = regimeRows.length > 0 ? regimeRows : rows.filter(r => r.regime === 'all')
    if (pool.length === 0) return false
    const monthly = pool.filter(r => r.freq === 'monthly')
    const daily   = pool.filter(r => r.freq === 'daily')
    const bestM = monthly.length ? monthly.reduce((a,b) => b.r_squared > a.r_squared ? b : a) : null
    const bestD = daily.length   ? daily.reduce((a,b) => Math.abs(b.correlation) > Math.abs(a.correlation) ? b : a) : null
    if (bestM && bestD) return bestM.r_squared >= bestD.r_squared ? bestM : bestD
    return bestM ?? bestD ?? false
  }

  async function handleExpand() {
    const opening = !expanded
    setExpanded(opening)
    if (opening && allRows === null) {
      setLoadingStats(true)
      try {
        const rows = await api.edgeStat(source, target)
        setAllRows(rows)
        setStats(pickBest(rows, currentRegime))
      } catch {
        setAllRows([])
        setStats(false)
      } finally {
        setLoadingStats(false)
      }
    } else if (opening && allRows !== null) {
      // Re-pick if regime changed since last open
      setStats(pickBest(allRows, currentRegime))
    }
  }

  // Colour-code correlation: green positive, red negative, slate weak
  function corrColour(r) {
    if (r === null || r === undefined) return "text-slate-400"
    if (Math.abs(r) < 0.1) return "text-slate-400"
    return r > 0 ? "text-emerald-400" : "text-red-400"
  }

  return (
    <div className="bg-slate-700 rounded overflow-hidden">
      {/* Main row */}
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-slate-200 text-xs">{nodeLabel}</span>
        <div className="flex items-center gap-2">
          <span className={`text-xs ${edge.direction === 1
            ? "text-emerald-400" : "text-red-400"}`}>
            {DIRECTION_LABEL[String(edge.direction)]}
          </span>
          <span className="text-slate-500 text-xs">{edge.lag_days}d</span>
          {bt && (
            <span
              className={`text-xs px-1.5 py-0.5 rounded font-medium ${VERDICT_STYLE[bt.verdict] ?? ""}`}
              title={`Out-of-sample: R² ${bt.oos_r2} · hit rate ${Math.round(bt.hit_rate * 100)}% · ${bt.n_oos} months`}
            >
              {bt.verdict === "validated" ? "✓ valid" : bt.verdict}
            </span>
          )}
          <button
            onClick={handleExpand}
            className="text-slate-400 hover:text-white text-xs px-1
                       border border-slate-600 rounded transition-colors"
            title="View/edit edge"
          >
            {expanded ? "▲" : "▼"}
          </button>
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-slate-600 px-3 py-2 space-y-2">
          {/* Schema fields */}
          <div className="flex items-center justify-between">
            <p className="text-slate-500 text-xs">
              Label: <span className="text-slate-300">{edge.label ?? "—"}</span>
            </p>
            <p className="text-slate-500 text-xs">
              Confidence: <span className="text-slate-300">
                {CONFIDENCE_LABEL[edge.confidence] ?? "—"}
              </span>
            </p>
          </div>
          {edge.notes && (
            <p className="text-slate-400 text-xs leading-relaxed">{edge.notes}</p>
          )}

          {/* Out-of-sample validation (from the walk-forward backtest) */}
          {bt && (
            <div className="bg-slate-800 rounded px-2 py-1.5 space-y-0.5">
              <div className="flex items-center justify-between">
                <span className="text-slate-500 text-xs">out-of-sample</span>
                <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${VERDICT_STYLE[bt.verdict] ?? ""}`}>
                  {bt.verdict}
                </span>
              </div>
              <p className="text-slate-400 text-xs">
                R² {bt.oos_r2} · hit {Math.round(bt.hit_rate * 100)}% (z {bt.hit_z}) · {bt.n_oos} months
                {" · "}beta flipped sign {bt.beta_flips}×
                {!bt.sign_ok && <span className="text-red-400"> · sign contradicts stated direction</span>}
              </p>
            </div>
          )}

          {/* Empirical stats */}
          {loadingStats && (
            <p className="text-slate-500 text-xs italic">Loading empirical stats…</p>
          )}
          {!loadingStats && stats && (
            <div className="bg-slate-800 rounded px-2 py-1.5 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-slate-500 text-xs">empirical</span>
                <div className="flex items-center gap-1">
                  {stats.regime && stats.regime !== "all" && (
                    <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-orange-900 text-orange-300">
                      {stats.regime}
                    </span>
                  )}
                  <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                    stats.freq === "monthly"
                      ? "bg-violet-900 text-violet-300"
                      : "bg-slate-700 text-slate-400"
                  }`}>{stats.freq}</span>
                </div>
              </div>
              <div className="grid grid-cols-4 gap-1">
                <div className="text-center">
                  <p className="text-slate-500 text-xs">r</p>
                  <p className={`text-xs font-mono font-medium ${corrColour(stats.correlation)}`}>
                    {stats.correlation.toFixed(2)}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-slate-500 text-xs">β</p>
                  <p className="text-slate-200 text-xs font-mono font-medium">
                    {stats.beta.toFixed(3)}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-slate-500 text-xs">R²</p>
                  <p className="text-slate-200 text-xs font-mono font-medium">
                    {stats.r_squared.toFixed(2)}
                  </p>
                </div>
                <div className="text-center">
                  <p className="text-slate-500 text-xs">n</p>
                  <p className="text-slate-400 text-xs font-mono">
                    {stats.n_obs}
                  </p>
                </div>
              </div>
            </div>
          )}
          {!loadingStats && stats === false && (
            <p className="text-slate-600 text-xs italic">No empirical data for this edge</p>
          )}

          <button
            onClick={onEdit}
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
          >
            ✎ Edit this edge
          </button>
        </div>
      )}
    </div>
  )
}

export default function NodeInspector({ node, neighbours, onClose, onNodeUpdated, currentRegime, pushUndo, onRefresh, validation }) {
  const [editing,     setEditing]     = useState(false)
  const [editLabel,   setEditLabel]   = useState("")
  const [editDesc,    setEditDesc]    = useState("")
  const [saving,      setSaving]      = useState(false)
  const [saveError,   setSaveError]   = useState(null)

  const [editingEdge,  setEditingEdge]  = useState(null)
  const [edgeLabel,    setEdgeLabel]    = useState("")
  const [edgeNotes,    setEdgeNotes]    = useState("")
  const [edgeDir,      setEdgeDir]      = useState(1)
  const [edgeConf,     setEdgeConf]     = useState(2)
  const [edgeLag,      setEdgeLag]      = useState(0)
  const [edgeRegimes,  setEdgeRegimes]  = useState([])
  const [savingEdge,   setSavingEdge]   = useState(false)
  const [edgeSaveErr,  setEdgeSaveErr]  = useState(null)

  function startEdit() {
    setEditLabel(node.label)
    setEditDesc(node.description ?? "")
    setEditing(true)
    setSaveError(null)
  }

  async function saveNode() {
    setSaving(true)
    setSaveError(null)
    try {
      const updated = await api.updateNode(node.id, {
        label:       editLabel,
        description: editDesc,
      })
      if (updated.detail) throw new Error(updated.detail)

      const nodeId = node.id
      const before = { label: node.label, description: node.description ?? "" }
      const after  = { label: editLabel,  description: editDesc }
      if (before.label !== after.label || before.description !== after.description) {
        const apply = (body) => async () => {
          const r = await api.updateNode(nodeId, body)
          if (r.detail) throw new Error(r.detail)
          await onRefresh?.()
        }
        pushUndo?.({ label: `Edited “${before.label}”`, undo: apply(before), redo: apply(after) })
      }

      onNodeUpdated?.({ ...node, label: editLabel, description: editDesc })
      setEditing(false)
    } catch (e) {
      setSaveError(e.message)
    } finally {
      setSaving(false)
    }
  }

  function startEditEdge(n, isUpstream) {
    const edge = n.edge
    const source = isUpstream ? n.id : node.id
    const target = isUpstream ? node.id : n.id
    setEditingEdge({
      source, target, neighbourLabel: n.label,
      before: {                       // snapshot for undo
        label:      edge.label ?? "",
        notes:      edge.notes ?? "",
        direction:  edge.direction ?? 1,
        confidence: edge.confidence ?? 2,
        lag_days:   edge.lag_days ?? 0,
        regimes:    edge.regimes ?? [],
      },
    })
    setEdgeLabel(edge.label ?? "")
    setEdgeNotes(edge.notes ?? "")
    setEdgeDir(edge.direction ?? 1)
    setEdgeConf(edge.confidence ?? 2)
    setEdgeLag(edge.lag_days ?? 0)
    setEdgeRegimes(edge.regimes ?? [])
    setEdgeSaveErr(null)
  }

  async function saveEdge() {
    setSavingEdge(true)
    setEdgeSaveErr(null)
    try {
      const after = {
        label:      edgeLabel,
        notes:      edgeNotes,
        direction:  edgeDir,
        confidence: edgeConf,
        lag_days:   edgeLag,
        regimes:    edgeRegimes,
      }
      const { source: eSrc, target: eTgt, before } = editingEdge
      const updated = await api.updateEdge(eSrc, eTgt, after)
      if (updated.detail) throw new Error(updated.detail)

      if (before && JSON.stringify(before) !== JSON.stringify(after)) {
        const apply = (body) => async () => {
          const r = await api.updateEdge(eSrc, eTgt, body)
          if (r.detail) throw new Error(r.detail)
          await onRefresh?.()
        }
        pushUndo?.({ label: `Edited edge ${eSrc} → ${eTgt}`, undo: apply(before), redo: apply(after) })
      }
      onNodeUpdated?.(null)
      setEditingEdge(null)
    } catch (e) {
      setEdgeSaveErr(e.message)
    } finally {
      setSavingEdge(false)
    }
  }

  if (!node) return (
    <div className="text-slate-500 text-sm p-4">
      Click any node to inspect it.
    </div>
  )

  return (
    <div className="pb-4 space-y-4 text-sm">

      {/* Header */}
      <div className="flex items-start justify-between gap-2 px-4 pt-4">
        <div className="flex-1">
          <span className={`text-xs px-2 py-0.5 rounded-full text-white
            ${TYPE_COLOURS[node.type] ?? "bg-slate-500"}`}>
            {node.type}
          </span>
          {editing ? (
            <input
              value={editLabel}
              onChange={e => setEditLabel(e.target.value)}
              className="mt-1 w-full bg-slate-700 text-white rounded px-2 py-1
                         text-base font-semibold border border-blue-500 focus:outline-none"
            />
          ) : (
            <h2 className="text-white font-semibold text-base mt-1">{node.label}</h2>
          )}
        </div>
        <button onClick={onClose}
          className="text-slate-400 hover:text-white text-lg leading-none">×</button>
      </div>

      {/* Description */}
      <div className="px-4">
        {editing ? (
          <textarea
            value={editDesc}
            onChange={e => setEditDesc(e.target.value)}
            rows={3}
            className="w-full bg-slate-700 text-slate-200 rounded px-2 py-1.5
                       text-xs border border-blue-500 focus:outline-none resize-none"
          />
        ) : (
          node.description && (
            <p className="text-slate-400 leading-relaxed text-xs">{node.description}</p>
          )
        )}
      </div>

      {/* Edit / Save buttons */}
      <div className="px-4">
        {editing ? (
          <div className="flex gap-2">
            <button onClick={saveNode} disabled={saving}
              className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-600
                         text-white rounded px-3 py-1.5 text-xs font-medium transition-colors">
              {saving ? "Saving…" : "✓ Save"}
            </button>
            <button onClick={() => setEditing(false)}
              className="px-3 py-1.5 text-slate-400 hover:text-white text-xs">
              Cancel
            </button>
          </div>
        ) : (
          <button onClick={startEdit}
            className="text-xs text-slate-400 hover:text-white transition-colors
                       border border-slate-600 hover:border-slate-400 rounded px-2 py-1">
            ✎ Edit node
          </button>
        )}
        {saveError && <p className="text-red-400 text-xs mt-1">{saveError}</p>}
      </div>

      {/* Price chart */}
      {HAS_PRICES.has(node.id) && (
        <div className="border-t border-slate-700 pt-3">
          <MiniChart nodeId={node.id} />
        </div>
      )}

      {/* Edge editor */}
      {editingEdge && (
        <div className="mx-4 border border-blue-500 rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-slate-300 text-xs font-medium">
              {editingEdge.source} → {editingEdge.target}
            </p>
            <button onClick={() => setEditingEdge(null)}
              className="text-slate-500 hover:text-white text-xs">✕</button>
          </div>
          <div>
            <label className="text-slate-500 text-xs block mb-1">Label</label>
            <input value={edgeLabel} onChange={e => setEdgeLabel(e.target.value)}
              className="w-full bg-slate-700 text-white rounded px-2 py-1 text-xs
                         border border-slate-600 focus:border-blue-500 focus:outline-none"/>
          </div>
          <div>
            <label className="text-slate-500 text-xs block mb-1">Notes</label>
            <textarea value={edgeNotes} onChange={e => setEdgeNotes(e.target.value)}
              rows={3}
              className="w-full bg-slate-700 text-white rounded px-2 py-1 text-xs
                         border border-slate-600 focus:border-blue-500
                         focus:outline-none resize-none"/>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-slate-500 text-xs block mb-1">Direction</label>
              <select value={edgeDir} onChange={e => setEdgeDir(Number(e.target.value))}
                className="w-full bg-slate-700 text-white rounded px-2 py-1 text-xs
                           border border-slate-600 focus:outline-none">
                <option value={1}>+ positive</option>
                <option value={-1}>- negative</option>
              </select>
            </div>
            <div>
              <label className="text-slate-500 text-xs block mb-1">Confidence</label>
              <select value={edgeConf} onChange={e => setEdgeConf(Number(e.target.value))}
                className="w-full bg-slate-700 text-white rounded px-2 py-1 text-xs
                           border border-slate-600 focus:outline-none">
                {CONFIDENCE_OPTIONS.map(c => (
                  <option key={c} value={c}>{CONFIDENCE_LABEL[c]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-slate-500 text-xs block mb-1">Lag (days)</label>
              <input type="number" value={edgeLag}
                onChange={e => setEdgeLag(Number(e.target.value))}
                className="w-full bg-slate-700 text-white rounded px-2 py-1 text-xs
                           border border-slate-600 focus:outline-none"/>
            </div>
          </div>
          {/* Regime checkboxes */}
          <div>
            <label className="text-slate-500 text-xs block mb-1">
              Active in regimes
              <span className="text-slate-600 ml-1">(empty = all)</span>
            </label>
            <div className="flex flex-wrap gap-1.5">
              {["zirp","hiking","easing","risk_off","normal"].map(r => (
                <label key={r}
                  className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded cursor-pointer
                    border transition-colors ${
                    edgeRegimes.includes(r)
                      ? "bg-blue-900 border-blue-500 text-blue-200"
                      : "bg-slate-700 border-slate-600 text-slate-400 hover:border-slate-400"
                  }`}>
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={edgeRegimes.includes(r)}
                    onChange={e => setEdgeRegimes(prev =>
                      e.target.checked ? [...prev, r] : prev.filter(x => x !== r)
                    )}
                  />
                  {r}
                </label>
              ))}
            </div>
          </div>
          {edgeSaveErr && <p className="text-red-400 text-xs">{edgeSaveErr}</p>}
          <div className="flex gap-2">
            <button onClick={saveEdge} disabled={savingEdge}
              className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-600
                         text-white rounded px-3 py-1.5 text-xs font-medium transition-colors">
              {savingEdge ? "Saving…" : "✓ Save edge"}
            </button>
            <button onClick={() => setEditingEdge(null)}
              className="px-3 py-1.5 text-slate-400 hover:text-white text-xs">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Neighbours */}
      {neighbours && (
        <div className="px-4 space-y-3">
          {neighbours.upstream.length > 0 && (
            <div>
              <h3 className="text-slate-300 font-medium mb-2 text-xs">
                ← Driven by ({neighbours.upstream.length})
              </h3>
              <div className="space-y-1">
                {neighbours.upstream.map((n) => (
                  <EdgeRow
                    key={n.id}
                    nodeLabel={n.label}
                    edge={n.edge}
                    source={n.id}
                    target={node.id}
                    currentRegime={currentRegime}
                    bt={validation?.[`${n.id}__${node.id}`]}
                    onEdit={() => startEditEdge(n, true)}
                  />
                ))}
              </div>
            </div>
          )}

          {neighbours.downstream.length > 0 && (
            <div>
              <h3 className="text-slate-300 font-medium mb-2 text-xs">
                → Affects ({neighbours.downstream.length})
              </h3>
              <div className="space-y-1">
                {neighbours.downstream.map((n) => (
                  <EdgeRow
                    key={n.id}
                    nodeLabel={n.label}
                    edge={n.edge}
                    source={node.id}
                    target={n.id}
                    currentRegime={currentRegime}
                    bt={validation?.[`${node.id}__${n.id}`]}
                    onEdit={() => startEditEdge(n, false)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}