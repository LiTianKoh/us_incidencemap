import { useRef, useState, useCallback, useEffect } from "react"

/**
 * Shared undo/redo history.
 * An entry is { label, undo: () => any | Promise, redo: () => any | Promise }.
 * Pushing a new entry clears the redo stack. `push` is referentially stable so
 * long-lived handlers (e.g. Cytoscape listeners) can hold on to it.
 */
export function useUndo(limit = 50) {
  const undoStack = useRef([])
  const redoStack = useRef([])
  const busy      = useRef(false)
  const [, bump]  = useState(0)
  const [toast, setToast] = useState(null)

  const push = useCallback((entry) => {
    undoStack.current.push(entry)
    if (undoStack.current.length > limit) undoStack.current.shift()
    redoStack.current = []
    bump(n => n + 1)
  }, [limit])

  async function run(from, to, key, verb) {
    if (busy.current) return
    const entry = from.current.pop()
    if (!entry) return
    busy.current = true
    try {
      await entry[key]()
      to.current.push(entry)
      setToast(`${verb}: ${entry.label}`)
    } catch (e) {
      from.current.push(entry)            // keep it so the user can retry
      setToast(`${verb} failed — ${e.message}`)
    } finally {
      busy.current = false
      bump(n => n + 1)
    }
  }

  const undo = () => run(undoStack, redoStack, "undo", "Undid")
  const redo = () => run(redoStack, undoStack, "redo", "Redid")

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 2500)
    return () => clearTimeout(t)
  }, [toast])

  const last = undoStack.current[undoStack.current.length - 1]
  const next = redoStack.current[redoStack.current.length - 1]

  return {
    push, undo, redo, toast,
    canUndo: !!last, canRedo: !!next,
    undoLabel: last?.label ?? null, redoLabel: next?.label ?? null,
  }
}