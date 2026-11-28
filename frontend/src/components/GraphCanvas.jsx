import { computeHubOrbitLayout } from "../hubLayout"
import { useEffect, useRef, useState, useCallback } from "react"
import cytoscape from "cytoscape"

// ── Default colours (overridable via colour editor) ───────────────────────
const DEFAULT_COLOURS = {
  actor:                  "#3B82F6",
  market:                 "#10B981",
  indicator:              "#F59E0B",
  sector:                 "#8B5CF6",
  highlight:              "#FBBF24",
  sourceHighlight:        "#FFFFFF",
  arrowPositive:          "#10B981",
  arrowNegative:          "#F87171",
  arrowHighlightPositive: "#34D399",
  arrowHighlightNegative: "#FCA5A5",
}

const COLOURS_KEY    = "causal-map-colours"
const NODE_COLS_KEY  = "causal-map-node-colours"

function loadColours() {
  try { return { ...DEFAULT_COLOURS, ...JSON.parse(localStorage.getItem(COLOURS_KEY) ?? "{}") } }
  catch { return { ...DEFAULT_COLOURS } }
}
function loadNodeColours() {
  try { return JSON.parse(localStorage.getItem(NODE_COLS_KEY) ?? "{}") }
  catch { return {} }
}

// ── Regime badge config ───────────────────────────────────────────────────
const REGIME_COLOURS = {
  zirp:     { bg: "bg-blue-900",    text: "text-blue-300",    label: "ZIRP"     },
  hiking:   { bg: "bg-red-900",     text: "text-red-300",     label: "Hiking"   },
  easing:   { bg: "bg-emerald-900", text: "text-emerald-300", label: "Easing"   },
  risk_off: { bg: "bg-orange-900",  text: "text-orange-300",  label: "Risk-Off" },
  normal:   { bg: "bg-slate-700",   text: "text-slate-300",   label: "Normal"   },
}

/**
 * Compute final positions for every node.
 * - Existing nodes (already in savedPositions) keep their exact position.
 * - New nodes are placed near the average position of their already-positioned
 *   neighbours (upstream + downstream), with a small jitter to avoid exact overlap.
 * - New isolated nodes (no positioned neighbours) fall back to a staging point
 *   near the bottom-right of the current bounding box, stacked diagonally.
 */
function computeNodePositions(nodeList, edgeList, savedPositions) {
  const positions = {}
  const newNodeIds = []

  // 1. Keep existing positions
  for (const n of nodeList) {
    const id = n.data.id
    if (savedPositions[id]) {
      positions[id] = { ...savedPositions[id] }
    } else {
      newNodeIds.push(id)
    }
  }

  if (newNodeIds.length === 0) return positions

  // 2. Build adjacency (undirected) restricted to positioned nodes
  const neighbourMap = {} // id -> [positioned neighbour ids]
  for (const e of edgeList) {
    const { source, target } = e.data
    if (positions[source]) {
      (neighbourMap[target] ??= []).push(source)
    }
    if (positions[target]) {
      (neighbourMap[source] ??= []).push(target)
    }
  }

  // 3. Bounding box of existing positions, for fallback staging point
  const existingCoords = Object.values(positions)
  const maxX = existingCoords.length ? Math.max(...existingCoords.map(p => p.x)) : 0
  const maxY = existingCoords.length ? Math.max(...existingCoords.map(p => p.y)) : 0
  const minY = existingCoords.length ? Math.min(...existingCoords.map(p => p.y)) : 0

  const STAGING_X = maxX + 150
  const STAGING_Y_START = minY
  const STAGING_STEP = 70

  let stagingIndex = 0

  // 4. Place new nodes — neighbour-anchored first, isolated nodes fall back to staging
  // Iterate a few times in case a new node's only neighbours are also new
  // (resolved once those get a position in an earlier pass)
  let remaining = [...newNodeIds]
  let lastRemainingLength = -1

  while (remaining.length > 0 && remaining.length !== lastRemainingLength) {
    lastRemainingLength = remaining.length
    const stillRemaining = []

    for (const id of remaining) {
      const neighbours = (neighbourMap[id] ?? []).filter(nid => positions[nid])
      if (neighbours.length > 0) {
        const avgX = neighbours.reduce((s, nid) => s + positions[nid].x, 0) / neighbours.length
        const avgY = neighbours.reduce((s, nid) => s + positions[nid].y, 0) / neighbours.length
        // Small jitter so multiple new nodes near the same neighbour don't overlap exactly
        const jitter = 40
        positions[id] = {
          x: avgX + (Math.random() - 0.5) * jitter,
          y: avgY + (Math.random() - 0.5) * jitter,
        }
      } else {
        stillRemaining.push(id)
      }
    }

    remaining = stillRemaining
  }

  // 5. Any nodes left (fully isolated from positioned graph) → staging diagonal
  for (const id of remaining) {
    positions[id] = {
      x: STAGING_X + stagingIndex * STAGING_STEP,
      y: STAGING_Y_START + stagingIndex * STAGING_STEP,
    }
    stagingIndex += 1
  }

  return positions
}

const POS_KEY = "causal-map-positions"

function readSavedPositions() {
  try { return JSON.parse(localStorage.getItem(POS_KEY) ?? "{}") } catch { return {} }
}

/** Move nodes to the given {id: {x, y}} positions and persist them (merged). */
function applyPositions(cy, map) {
  if (!cy) return
  cy.batch(() => {
    cy.nodes().forEach(n => {
      const p = map[n.data("id")]
      if (p) n.position({ x: p.x, y: p.y })
    })
  })
  try {
    localStorage.setItem(POS_KEY, JSON.stringify({ ...readSavedPositions(), ...map }))
  } catch { /* ignore */ }
}

export default function GraphCanvas({
  graphData, nodes, selectedNode, onNodeClick, onBackgroundClick,
  highlightedPath, currentRegime, pushUndo
}) {
  const containerRef = useRef(null)
  const cyRef        = useRef(null)
  const pushUndoRef  = useRef(pushUndo)
  pushUndoRef.current = pushUndo

  const [colours,     setColours]     = useState(loadColours)
  const [nodeColours, setNodeColours] = useState(loadNodeColours)
  const [showEditor,  setShowEditor]  = useState(false)
  const [editingNode, setEditingNode] = useState(null) // node being colour-edited

  // When colour editor is open and a node is selected, set it for per-node editing
  useEffect(() => {
    if (showEditor && selectedNode) setEditingNode(selectedNode)
  }, [selectedNode, showEditor])

  // Persist colours to localStorage whenever they change
  useEffect(() => {
    localStorage.setItem(COLOURS_KEY, JSON.stringify(colours))
  }, [colours])
  useEffect(() => {
    localStorage.setItem(NODE_COLS_KEY, JSON.stringify(nodeColours))
  }, [nodeColours])

  // Build Cytoscape style array from current colours
  const buildStyles = useCallback((cols, nodeCols) => [
    {
      selector: "node",
      style: {
        "background-color": (el) =>
          nodeCols[el.data("id")] ?? cols[el.data("type")] ?? "#94a3b8",
        "label":          "data(label)",
        "color":          "#f1f5f9",
        "font-size":      "11px",
        "text-valign":    "bottom",
        "text-margin-y":  "6px",
        "text-wrap":      "wrap",
        "text-max-width": "80px",
        "width":          "36px",
        "height":         "36px",
        "border-width":   "2px",
        "border-color":   "rgba(255,255,255,0.15)",
      }
    },
    {
      selector: "edge[direction = 1]",
      style: {
        "line-color":         cols.arrowPositive,
        "target-arrow-color": cols.arrowPositive,
      }
    },
    {
      selector: "edge[direction = -1]",
      style: {
        "line-color":         cols.arrowNegative,
        "target-arrow-color": cols.arrowNegative,
      }
    },
    {
      selector: "edge",
      style: {
        "width":              "2px",
        "target-arrow-shape": "triangle",
        "curve-style":        "bezier",
        "opacity":            0.7,
        "arrow-scale":        1.2,
        "label":              "data(label)",
        "font-size":          "9px",
        "color":              "#94a3b8",
        "text-rotation":      "autorotate",
        "text-margin-y":      "-8px",
        "text-opacity":       0,
      }
    },
    {
      selector: "edge.hovered",
      style: { "text-opacity": 1, "width": "3px", "opacity": 1 }
    },
    {
      selector: "node.newly-placed",
      style: {
        "border-width": "3px",
        "border-style": "dashed",
        "border-color": "#FBBF24",
      }
    },
    {
      selector: "node.highlighted",
      style: {
        "border-width": "4px",
        "border-color": cols.highlight,
        "width":        "44px",
        "height":       "44px",
      }
    },
    {
      selector: "node.source-highlighted",
      style: {
        "border-width": "4px",
        "border-color": cols.sourceHighlight,
        "width":        "48px",
        "height":       "48px",
      }
    },
    {
      selector: "edge.highlighted[direction = 1]",
      style: {
        "line-color":         cols.arrowHighlightPositive,
        "target-arrow-color": cols.arrowHighlightPositive,
      }
    },
    {
      selector: "edge.highlighted[direction = -1]",
      style: {
        "line-color":         cols.arrowHighlightNegative,
        "target-arrow-color": cols.arrowHighlightNegative,
      }
    },
    {
      selector: "edge.highlighted",
      style: { "width": "4px", "opacity": 1 }
    },
    {
      selector: "edge.regime-inactive",
      style: {
        "opacity":            0.12,
        "line-color":         "#475569",
        "target-arrow-color": "#475569",
      }
    },
    {
      selector: "node:selected",
      style: { "border-width": "4px", "border-color": "#ffffff" }
    },
  ], [])

  // Build graph when data arrives
  useEffect(() => {
    if (!graphData || !containerRef.current) return
    if (cyRef.current) cyRef.current.destroy()

    const savedPositions = (() => {
      try { return JSON.parse(localStorage.getItem("causal-map-positions") ?? "{}") }
      catch { return {} }
    })()

    const computedPositions = computeNodePositions(
      graphData.elements.nodes,
      graphData.elements.edges,
      savedPositions
    )

    // Nothing saved for any current node (first run, new browser, or after
    // "Auto-layout" cleared storage): run one real force-directed layout instead
    // of staging every node on the diagonal, then persist the result.
    const freshStart = !graphData.elements.nodes.some(n => savedPositions[n.data.id])

    const newNodeIds = new Set(
      freshStart
        ? []
        : graphData.elements.nodes
            .filter(n => !savedPositions[n.data.id])
            .map(n => n.data.id)
    )

    const elements = {
      nodes: graphData.elements.nodes.map(n => {
        const existingClasses = Array.isArray(n.classes)
          ? n.classes.join(" ")
          : (n.classes ?? "")
        return {
          ...n,
          position: freshStart ? undefined : computedPositions[n.data.id],
          // Tag newly-placed nodes so they can be styled distinctly
          classes: newNodeIds.has(n.data.id)
            ? `${existingClasses} newly-placed`.trim()
            : n.classes,
        }
      }),
      edges: graphData.elements.edges
    }

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: buildStyles(colours, nodeColours),
      // Every node now has an explicit position — always preset.
      // cose is never run automatically, so existing node positions
      // are never disturbed by newly-added nodes.
      layout: freshStart
        ? { name: "cose", animate: false, randomize: true,
            nodeRepulsion: 8000, idealEdgeLength: 120, padding: 40 }
        : { name: "preset" },
      userZoomingEnabled:  true,
      userPanningEnabled:  true,
      boxSelectionEnabled: false,
    })

    if (freshStart) {
      const saveAll = () => {
        const all = {}
        cy.nodes().forEach(n => { all[n.data("id")] = { ...n.position() } })
        try { localStorage.setItem("causal-map-positions", JSON.stringify(all)) } catch { /* ignore */ }
      }
      saveAll()   // animate:false layout has already finished inside the constructor
    }

    // Persist positions for any newly-placed nodes immediately, so a
    // reload doesn't re-trigger placement (and won't touch existing entries)
    if (newNodeIds.size > 0) {
      const merged = { ...savedPositions }
      newNodeIds.forEach(id => {
        if (computedPositions[id]) merged[id] = { ...computedPositions[id] }
      })
      localStorage.setItem("causal-map-positions", JSON.stringify(merged))
    }

    // Remember where a node was when picked up, so a move can be undone
    let grabbed = null
    cy.on("grab", "node", (evt) => {
      grabbed = { id: evt.target.data("id"), pos: { ...evt.target.position() } }
    })

    // Save only the dragged node's position — never touch others
    cy.on("dragfree", "node", (evt) => {
      const node = evt.target
      const current = (() => {
        try { return JSON.parse(localStorage.getItem("causal-map-positions") ?? "{}") }
        catch { return {} }
      })()
      current[node.data("id")] = { ...node.position() }
      localStorage.setItem("causal-map-positions", JSON.stringify(current))
      // Once manually placed, it's no longer "newly-placed"
      node.removeClass("newly-placed")

      // Record the move for undo (ignore taps / sub-pixel jitter)
      const id = node.data("id")
      if (grabbed && grabbed.id === id) {
        const before = grabbed.pos
        const after  = { ...node.position() }
        grabbed = null
        if (Math.hypot(after.x - before.x, after.y - before.y) > 1) {
          pushUndoRef.current?.({
            label: `Moved ${node.data("label") ?? id}`,
            undo:  () => applyPositions(cyRef.current, { [id]: before }),
            redo:  () => applyPositions(cyRef.current, { [id]: after }),
          })
        }
      }
    })

    cy.on("tap", "node", (evt) => {
      onNodeClick?.(evt.target.data())
    })
    cy.on("tap", (evt) => {
      if (evt.target === cy) {
        onNodeClick?.(null)
        onBackgroundClick?.()
      }
    })
    cy.on("mouseover", "edge", (evt) => { evt.target.addClass("hovered") })
    cy.on("mouseout",  "edge", (evt) => { evt.target.removeClass("hovered") })

    cyRef.current = cy
  }, [graphData])

  // Re-apply styles when colours change (without rebuilding graph)
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    cy.style(buildStyles(colours, nodeColours))
  }, [colours, nodeColours, buildStyles])

  // Regime-inactive edge fading
  useEffect(() => {
    const cy = cyRef.current
    if (!cy || !currentRegime) return
    const regime = currentRegime.regime
    cy.edges().forEach(edge => {
      const regimes = edge.data("regimes")
      const isInactive = Array.isArray(regimes) && regimes.length > 0 && !regimes.includes(regime)
      if (isInactive) edge.addClass("regime-inactive")
      else            edge.removeClass("regime-inactive")
    })
  }, [currentRegime, graphData])

  // Highlight path / event / sim results
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return

    cy.elements().removeClass("highlighted source-highlighted")

    if (!highlightedPath) return

    // Source node (sim) — distinct white ring
    if (highlightedPath.sourceNode) {
      cy.$(`#${highlightedPath.sourceNode}`).addClass("source-highlighted")
    }

    // All affected nodes
    highlightedPath.path.forEach(nodeId => {
      cy.$(`#${nodeId}`).addClass("highlighted")
    })

    // All edges
    highlightedPath.edges.forEach(edge => {
      cy.$(`#${edge.source}__${edge.target}`).addClass("highlighted")
    })
  }, [highlightedPath])

  // Update node labels live without rebuilding
  useEffect(() => {
    const cy = cyRef.current
    if (!cy || !graphData) return
    graphData.elements.nodes.forEach(n => {
      const cyNode = cy.$(`#${n.data.id}`)
      if (cyNode.length) {
        cyNode.data("label",       n.data.label)
        cyNode.data("description", n.data.description)
      }
    })
  }, [graphData])

  function resetView()      { cyRef.current?.fit(undefined, 40) }
  // Re-run the force layout in place (no page reload) so it can be undone
  function autoLayout() {
    const cy = cyRef.current
    if (!cy) return
    const snapshot = () => {
      const m = {}
      cy.nodes().forEach(n => { m[n.data("id")] = { ...n.position() } })
      return m
    }
    const before = snapshot()
    cy.layout({ name: "cose", animate: false, randomize: true,
                nodeRepulsion: 8000, idealEdgeLength: 120, padding: 40 }).run()
    cy.nodes().removeClass("newly-placed")
    const after = snapshot()
    try { localStorage.setItem(POS_KEY, JSON.stringify(after)) } catch { /* ignore */ }
    cy.fit(undefined, 40)
    pushUndoRef.current?.({
      label: "Auto-layout",
      undo:  () => applyPositions(cyRef.current, before),
      redo:  () => applyPositions(cyRef.current, after),
    })
  }

  // Hub-and-orbit layout: big nodes spread apart, their neighbours ring around them
  function hubLayout() {
    const cy = cyRef.current
    if (!cy) return
    const before = {}
    cy.nodes().forEach(n => { before[n.data("id")] = { ...n.position() } })
    const ids   = cy.nodes().map(n => n.data("id"))
    const edges = cy.edges().map(e => ({ source: e.data("source"), target: e.data("target") }))
    const { positions } = computeHubOrbitLayout(ids, edges)
    applyPositions(cy, positions)
    cy.nodes().removeClass("newly-placed")
    try { localStorage.setItem(POS_KEY, JSON.stringify(positions)) } catch { /* ignore */ }
    cy.fit(undefined, 40)
    pushUndoRef.current?.({
      label: "Hub layout",
      undo:  () => applyPositions(cyRef.current, before),
      redo:  () => applyPositions(cyRef.current, positions),
    })
  }

  // Keep Cytoscape's canvas in sync when the sidebar is resized
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => cyRef.current?.resize())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  function updateTypeColour(type, hex) {
    setColours(prev => ({ ...prev, [type]: hex }))
  }
  function updateNodeColour(nodeId, hex) {
    setNodeColours(prev => ({ ...prev, [nodeId]: hex }))
  }
  function clearNodeColour(nodeId) {
    setNodeColours(prev => { const next = { ...prev }; delete next[nodeId]; return next })
  }
  function resetAllColours() {
    setColours({ ...DEFAULT_COLOURS })
    setNodeColours({})
  }

  const regimeStyle = currentRegime
    ? (REGIME_COLOURS[currentRegime.regime] ?? REGIME_COLOURS.normal)
    : null

  // Node list for per-node colour editor
  const nodeList = (nodes ?? []).filter(n => nodeColours[n.id] || editingNode?.id === n.id)

  return (
    <div className="w-full h-full relative">
      <div
        ref={containerRef}
        className="w-full h-full rounded-lg"
        style={{ background: "#1e293b" }}
      />

      {/* Regime badge — top-left */}
      {regimeStyle && (
        <div className={`absolute top-4 left-4 flex items-center gap-2
                         ${regimeStyle.bg} ${regimeStyle.text}
                         rounded-lg px-3 py-1.5 text-xs font-medium
                         border border-white/10 shadow-lg`}>
          <span className="w-2 h-2 rounded-full bg-current opacity-80" />
          <span>{regimeStyle.label} regime</span>
          {currentRegime.since && (
            <span className="opacity-50 font-normal">since {currentRegime.since}</span>
          )}
        </div>
      )}

      {/* Bottom-right controls */}
      <div className="absolute bottom-4 right-4 flex gap-2">
        <button onClick={hubLayout}
          title="Spread the best-connected nodes apart and orbit their neighbours around them (undo with ⌘/Ctrl+Z)"
          className="bg-slate-700 hover:bg-slate-600 text-slate-400 hover:text-white
                     rounded-lg px-3 py-2 text-xs transition-colors border border-slate-600 shadow-lg">
          ◎ Hub layout
        </button>
        <button onClick={autoLayout}
          title="Re-run the layout (undo with ⌘/Ctrl+Z)"
          className="bg-slate-700 hover:bg-slate-600 text-slate-400 hover:text-white
                     rounded-lg px-3 py-2 text-xs transition-colors border border-slate-600 shadow-lg">
          ↺ Auto-layout
        </button>
        <button onClick={resetView}
          className="bg-slate-700 hover:bg-slate-600 text-slate-300 hover:text-white
                     rounded-lg px-3 py-2 text-xs font-medium transition-colors border border-slate-600 shadow-lg">
          ⊞ Reset view
        </button>
      </div>

      {/* Colour editor toggle — bottom-left */}
      <div className="absolute bottom-4 left-4">
        <button
          onClick={() => setShowEditor(e => !e)}
          title="Edit colours"
          className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors
                      border shadow-lg ${showEditor
                        ? "bg-blue-600 border-blue-500 text-white"
                        : "bg-slate-700 border-slate-600 text-slate-400 hover:text-white hover:bg-slate-600"
                      }`}
        >
          🎨 Colours
        </button>
      </div>

      {/* Floating colour editor panel */}
      {showEditor && (
        <div className="absolute bottom-16 left-4 w-72 bg-slate-800 border border-slate-600
                        rounded-xl shadow-2xl p-4 space-y-4 z-10">

          {/* Header */}
          <div className="flex items-center justify-between">
            <p className="text-white text-xs font-semibold">Colour Editor</p>
            <div className="flex gap-2">
              <button onClick={resetAllColours}
                className="text-slate-500 hover:text-red-400 text-xs transition-colors">
                Reset all
              </button>
              <button onClick={() => setShowEditor(false)}
                className="text-slate-500 hover:text-white text-sm leading-none">
                ✕
              </button>
            </div>
          </div>

          {/* Node type colours */}
          <div>
            <p className="text-slate-400 text-xs mb-2">Node types</p>
            <div className="grid grid-cols-2 gap-2">
              {["actor","market","indicator","sector"].map(type => (
                <label key={type}
                  className="flex items-center gap-2 bg-slate-700 rounded px-2 py-1.5 cursor-pointer">
                  <input
                    type="color"
                    value={colours[type]}
                    onChange={e => updateTypeColour(type, e.target.value)}
                    className="w-6 h-6 rounded cursor-pointer bg-transparent border-0"
                  />
                  <span className="text-slate-300 text-xs capitalize">{type}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Arrow colours */}
          <div>
            <p className="text-slate-400 text-xs mb-2">Arrow colours</p>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex items-center gap-2 bg-slate-700 rounded px-2 py-1.5 cursor-pointer">
                <input type="color" value={colours.arrowPositive}
                  onChange={e => updateTypeColour("arrowPositive", e.target.value)}
                  className="w-6 h-6 rounded cursor-pointer bg-transparent border-0"/>
                <span className="text-slate-300 text-xs">Positive ↑</span>
              </label>
              <label className="flex items-center gap-2 bg-slate-700 rounded px-2 py-1.5 cursor-pointer">
                <input type="color" value={colours.arrowNegative}
                  onChange={e => updateTypeColour("arrowNegative", e.target.value)}
                  className="w-6 h-6 rounded cursor-pointer bg-transparent border-0"/>
                <span className="text-slate-300 text-xs">Negative ↓</span>
              </label>
            </div>
          </div>

          {/* Highlight colours */}
          <div>
            <p className="text-slate-400 text-xs mb-2">Highlight colours</p>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex items-center gap-2 bg-slate-700 rounded px-2 py-1.5 cursor-pointer">
                <input type="color" value={colours.highlight}
                  onChange={e => updateTypeColour("highlight", e.target.value)}
                  className="w-6 h-6 rounded cursor-pointer bg-transparent border-0"/>
                <span className="text-slate-300 text-xs">Node ring</span>
              </label>
              <label className="flex items-center gap-2 bg-slate-700 rounded px-2 py-1.5 cursor-pointer">
                <input type="color" value={colours.sourceHighlight}
                  onChange={e => updateTypeColour("sourceHighlight", e.target.value)}
                  className="w-6 h-6 rounded cursor-pointer bg-transparent border-0"/>
                <span className="text-slate-300 text-xs">Source node</span>
              </label>
              <label className="flex items-center gap-2 bg-slate-700 rounded px-2 py-1.5 cursor-pointer">
                <input type="color" value={colours.arrowHighlightPositive}
                  onChange={e => updateTypeColour("arrowHighlightPositive", e.target.value)}
                  className="w-6 h-6 rounded cursor-pointer bg-transparent border-0"/>
                <span className="text-slate-300 text-xs">Arrow ↑ lit</span>
              </label>
              <label className="flex items-center gap-2 bg-slate-700 rounded px-2 py-1.5 cursor-pointer">
                <input type="color" value={colours.arrowHighlightNegative}
                  onChange={e => updateTypeColour("arrowHighlightNegative", e.target.value)}
                  className="w-6 h-6 rounded cursor-pointer bg-transparent border-0"/>
                <span className="text-slate-300 text-xs">Arrow ↓ lit</span>
              </label>
            </div>
          </div>

          {/* Per-node colour override */}
          <div>
            <p className="text-slate-400 text-xs mb-2">
              Individual nodes
              <span className="text-slate-600 ml-1">(click a node on canvas to add)</span>
            </p>

            {/* Currently overridden nodes */}
            {Object.keys(nodeColours).length === 0 && !editingNode && (
              <p className="text-slate-600 text-xs italic">No overrides yet</p>
            )}
            <div className="space-y-1">
              {[
                // Show overridden nodes
                ...Object.keys(nodeColours).map(id => ({ id, colour: nodeColours[id] })),
                // Show currently editing node if not already overridden
                ...(editingNode && !nodeColours[editingNode.id]
                  ? [{ id: editingNode.id, colour: colours[editingNode.type] ?? "#94a3b8", isNew: true }]
                  : [])
              ].map(({ id, colour, isNew }) => {
                const nodeInfo = (nodes ?? []).find(n => n.id === id)
                return (
                  <div key={id} className="flex items-center gap-2 bg-slate-700 rounded px-2 py-1.5">
                    <input type="color"
                      value={colour}
                      onChange={e => updateNodeColour(id, e.target.value)}
                      className="w-6 h-6 rounded cursor-pointer bg-transparent border-0"/>
                    <span className="text-slate-300 text-xs flex-1 truncate">
                      {nodeInfo?.label ?? id}
                    </span>
                    <button onClick={() => clearNodeColour(id)}
                      className="text-slate-600 hover:text-red-400 text-xs transition-colors">
                      ✕
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}