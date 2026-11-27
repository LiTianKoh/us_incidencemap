import AIIngestion from "./components/AIIngestion"
import Simulator from "./components/Simulator"
import Portfolio from "./components/Portfolio"
import EventPanel from "./components/EventPanel"
import { useState, useEffect, useRef } from "react"
import TabBar from "./components/TabBar"
import { useUndo } from "./useUndo"
import { api } from "./api/client"
import GraphCanvas from "./components/GraphCanvas"
import NodeInspector from "./components/NodeInspector"
import PathFinder from "./components/PathFinder"

const LEGEND = [
  { type: "actor",     colour: "#3B82F6", label: "Actor"     },
  { type: "market",    colour: "#10B981", label: "Market"    },
  { type: "indicator", colour: "#F59E0B", label: "Indicator" },
  { type: "sector",    colour: "#8B5CF6", label: "Sector"    },
]

export default function App() {
  const [graphData,       setGraphData]       = useState(null)
  const [nodes,           setNodes]           = useState([])
  const [selectedNode,    setSelectedNode]    = useState(null)
  const [neighbours,      setNeighbours]      = useState(null)
  const [highlightedPath, setHighlightedPath] = useState(null)
  const [activePanel,     setActivePanel]     = useState("inspector") // "inspector" | "paths"
  const [summary,         setSummary]         = useState(null)
  const [loading,         setLoading]         = useState(true)
  const [error,           setError]           = useState(null)
  const [minConf,         setMinConf]         = useState(1)
  const [events,        setEvents]        = useState([])
  const [edges,         setEdges]         = useState([])
  const [currentRegime, setCurrentRegime] = useState(null)

  // ── Undo / redo ───────────────────────────────────────────────────────────
  const { push: pushUndo, undo, redo, toast, canUndo, canRedo, undoLabel, redoLabel } = useUndo()

  // Cmd/Ctrl+Z = undo, Shift+Cmd/Ctrl+Z or Ctrl+Y = redo.
  // Ignored while typing so text fields keep their own native undo.
  useEffect(() => {
    function onKey(e) {
      if (!(e.metaKey || e.ctrlKey)) return
      const tag = (e.target?.tagName ?? "").toLowerCase()
      if (tag === "input" || tag === "textarea" || tag === "select" || e.target?.isContentEditable) return
      const k = e.key.toLowerCase()
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo() }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo() }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [undo, redo])

  // Reload everything that edits can change (used after an undo/redo of an edit)
  async function refreshData() {
    const [g, n, s, e] = await Promise.all([
      api.graph(minConf), api.nodes(), api.summary(), api.edges(),
    ])
    setGraphData(g); setNodes(n); setSummary(s); setEdges(e)
    // Re-point the selection at the refreshed node; this also reloads neighbours
    setSelectedNode((sel) => (sel ? (n.find((x) => x.id === sel.id) ?? sel) : sel))
  }

  // ── Resizable sidebar ─────────────────────────────────────────────────────
  const SIDEBAR_DEFAULT = 384, SIDEBAR_MIN = 300
  const [sidebarW, setSidebarW] = useState(() => {
    try {
      const v = parseInt(localStorage.getItem("incidence-sidebar-width"), 10)
      return Number.isFinite(v) ? v : SIDEBAR_DEFAULT
    } catch { return SIDEBAR_DEFAULT }
  })
  const dragging = useRef(false)

  useEffect(() => {
    try { localStorage.setItem("incidence-sidebar-width", String(sidebarW)) } catch { /* ignore */ }
  }, [sidebarW])

  function startResize(e) {
    e.preventDefault()
    dragging.current = true
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    const move = (ev) => {
      if (!dragging.current) return
      const max = Math.max(SIDEBAR_MIN, Math.min(900, window.innerWidth - 320))
      setSidebarW(Math.min(max, Math.max(SIDEBAR_MIN, ev.clientX)))
    }
    const up = () => {
      dragging.current = false
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  // Load graph on mount
  useEffect(() => {
    async function load() {
      try {
        const [g, n, s, ev, regime, edgeList] = await Promise.all([
          api.graph(minConf),
          api.nodes(),
          api.summary(),
          api.events(),
          api.regimeCurrent(),
          api.edges(),
        ])
        setGraphData(g)
        setNodes(n)
        setSummary(s)
        setEvents(ev)
        setCurrentRegime(regime)
        setEdges(edgeList)
      } catch (e) {
        setError(e.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [minConf])

  // Load neighbours when a node is selected
  useEffect(() => {
    if (!selectedNode) { setNeighbours(null); return }
    api.neighbours(selectedNode.id).then(setNeighbours)
  }, [selectedNode])

  if (loading) return (
    <div className="flex items-center justify-center h-screen text-slate-400">
      Loading graph…
    </div>
  )

  if (error) return (
    <div className="flex items-center justify-center h-screen text-red-400">
      Error: {error} — is the FastAPI backend running on port 8000?
    </div>
  )

  return (
    <div className="flex h-screen overflow-hidden bg-slate-900">

      {/* ── Left sidebar ── */}
      <div style={{ width: sidebarW }} className="flex-shrink-0 bg-slate-800 border-r border-slate-700 flex flex-col overflow-hidden">

        {/* Header */}
        <div className="p-4 border-b border-slate-700 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-white font-bold text-lg">US Market Causal Map</h1>
            {summary && (
              <p className="text-slate-400 text-xs mt-1">
                {summary.total_nodes} nodes · {summary.total_edges} edges
              </p>
            )}
          </div>
          <div className="flex gap-1 flex-shrink-0">
            <button
              onClick={undo} disabled={!canUndo}
              title={canUndo ? `Undo: ${undoLabel}  (⌘/Ctrl+Z)` : "Nothing to undo"}
              className="px-2 py-1 rounded border border-slate-600 text-sm text-slate-300 hover:bg-slate-700 hover:text-white disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent"
            >↶</button>
            <button
              onClick={redo} disabled={!canRedo}
              title={canRedo ? `Redo: ${redoLabel}  (⇧⌘/Ctrl+Z)` : "Nothing to redo"}
              className="px-2 py-1 rounded border border-slate-600 text-sm text-slate-300 hover:bg-slate-700 hover:text-white disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent"
            >↷</button>
          </div>
        </div>

        {/* Confidence filter */}
        <div className="px-4 py-3 border-b border-slate-700">
          <label className="text-slate-400 text-xs block mb-1">
            Min edge confidence: {minConf === 1 ? "all" : minConf === 2 ? "moderate+" : "high only"}
          </label>
          <input
            type="range" min={1} max={3} value={minConf}
            onChange={(e) => setMinConf(Number(e.target.value))}
            className="w-full accent-blue-500"
          />
        </div>

        {/* Panel tabs — scrollable, with arrows when they overflow */}
        <TabBar
          tabs={["inspector", "paths", "events", "ai", "sim", "portfolio"]}
          active={activePanel}
          onChange={setActivePanel}
        />

        {/* Panel content */}
        <div className="flex-1 overflow-y-auto">
          {activePanel === "inspector" && (
            <NodeInspector
              node={selectedNode}
              neighbours={neighbours}
              onClose={() => setSelectedNode(null)}
              currentRegime={currentRegime?.regime}
              pushUndo={pushUndo}
              onRefresh={refreshData}
              onNodeUpdated={(updatedNode) => {
                // If updatedNode is passed, update selected node immediately
                if (updatedNode) {
                  setSelectedNode(updatedNode)
                }
                // Reload neighbours and graph data
                if (selectedNode) {
                  api.neighbours(selectedNode.id).then(setNeighbours)
                }
                api.graph(minConf).then(setGraphData)
                api.nodes().then(setNodes)
                api.summary().then(setSummary)
              }}
            />
          )}
          {activePanel === "paths" && (
            <PathFinder
              nodes={nodes}
              onPathSelect={(path) => {
                setHighlightedPath({ ...path, sourceNode: path.path[0] })
                setActivePanel("inspector")
              }}
            />
          )}
          {activePanel === "events" && (
            <EventPanel
              events={events}
              selectedEvent={null}
              onEventSelect={(event) => {
                if (!event) {
                  setHighlightedPath(null)
                  return
                }
                // Highlight affected nodes on the graph
                // Find all edges where both endpoints are affected
                const affectedSet = new Set(event.affected_nodes)
                const affectedEdges = edges.filter(e =>
                  affectedSet.has(e.source) && affectedSet.has(e.target)
                )
                setHighlightedPath({
                  path: event.affected_nodes,
                  edges: affectedEdges,
                  sourceNode: event.affected_nodes[0],
                  net_direction: event.primary_direction,
                  total_lag_days: 0,
                  isEvent: true,
                  label: event.label,
                  date: event.date,
                })
              }}
            />
          )}
          {activePanel === "ai" && (
            <AIIngestion
              onCommit={() => {
                // Clear saved positions so new nodes get placed by auto-layout
                Promise.all([
                  api.events(),
                  api.summary(),
                  api.graph(minConf),
                  api.nodes(),
                ]).then(([ev, sum, g, n]) => {
                  setEvents(ev)
                  setSummary(sum)
                  setGraphData(g)
                  setNodes(n)
                })
                setActivePanel("events")
              }}
            />
          )}
          {activePanel === "portfolio" && (
            <Portfolio
              nodes={nodes}
              currentRegime={currentRegime?.regime}
              onSimResult={(path) => setHighlightedPath(path)}
            />
          )}
          {activePanel === "sim" && (
            <Simulator
              nodes={nodes}
              edges={edges}
              currentRegime={currentRegime?.regime}
              onSimResult={(path) => {
                setHighlightedPath(path)
              }}
            />
          )}
        </div>

        {/* Legend */}
        <div className="p-4 border-t border-slate-700 space-y-3">
          <div>
            <p className="text-slate-500 text-xs mb-2">Node types</p>
            <div className="grid grid-cols-2 gap-1">
              {LEGEND.map((l) => (
                <div key={l.type} className="flex items-center gap-1.5 text-xs text-slate-400">
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: l.colour }} />
                  {l.label}
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="text-slate-500 text-xs mb-2">Arrow direction</p>
            <div className="space-y-1 text-xs text-slate-400">
              <div className="flex items-center gap-2">
                <span className="w-4 h-0.5 bg-emerald-500 inline-block"/>
                <span>positive — A↑ causes B↑</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-4 h-0.5 bg-red-400 inline-block"/>
                <span>negative — A↑ causes B↓</span>
              </div>
            </div>
          </div>
          <p className="text-slate-600 text-xs">Hover an arrow to see its label</p>
        </div>

      </div> {/* ← closes left sidebar */}

      {/* ── Drag handle: resize the sidebar (double-click to reset) ── */}
      <div
        onPointerDown={startResize}
        onDoubleClick={() => setSidebarW(SIDEBAR_DEFAULT)}
        title="Drag to resize · double-click to reset"
        className="w-1.5 flex-shrink-0 cursor-col-resize bg-slate-700 hover:bg-blue-500 active:bg-blue-500 transition-colors"
      />

      {/* ── Main graph canvas ── */}
      <div className="flex-1 relative">
        <GraphCanvas
          graphData={graphData}
          nodes={nodes}
          selectedNode={selectedNode}
          onNodeClick={(node) => {
            setSelectedNode(node)
            if (node) setActivePanel("inspector")
          }}
          onBackgroundClick={() => setHighlightedPath(null)}
          highlightedPath={highlightedPath}
          currentRegime={currentRegime}
          pushUndo={pushUndo}
        />

        {/* Undo / redo toast */}
        {toast && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-slate-800 border border-slate-600 text-slate-200 text-sm rounded-lg px-4 py-2 shadow-lg">
            {toast}
          </div>
        )}

        {/* Highlighted path banner */}
        {highlightedPath && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-slate-800 border border-slate-600 rounded-lg px-4 py-2 flex items-center gap-3 text-sm shadow-lg max-w-2xl">
            {highlightedPath.isEvent ? (
              <>
                <span className="text-amber-400 font-medium">{highlightedPath.label}</span>
                <span className="text-slate-500">·</span>
                <span className="text-slate-400">{highlightedPath.date}</span>
                <span className="text-slate-500">·</span>
                <span className="text-slate-400">{highlightedPath.path.length} nodes affected</span>
              </>
            ) : (
              <>
                <span className="text-slate-300">
                  {highlightedPath.path.join(" → ")}
                </span>
                <span className="text-slate-500">·</span>
                <span className={highlightedPath.net_direction === 1 ? "text-emerald-400" : "text-red-400"}>
                  {highlightedPath.net_direction === 1 ? "↑ positive" : "↓ negative"}
                </span>
                <span className="text-slate-500">{highlightedPath.total_lag_days}d lag</span>
              </>
            )}
            <button
              onClick={() => setHighlightedPath(null)}
              className="text-slate-400 hover:text-white ml-1"
            >×</button>
          </div>
        )}
      </div>

    </div>
  )
}