import { useEffect, useRef, useState } from "react"

/**
 * Horizontally scrollable tab strip with left/right arrows.
 * Arrows only appear when the tabs overflow the panel, and disable at the ends.
 * The active tab is scrolled into view when it changes.
 */
export default function TabBar({ tabs, active, onChange }) {
  const scrollRef = useRef(null)
  const [canLeft,  setCanLeft]  = useState(false)
  const [canRight, setCanRight] = useState(false)

  function measure() {
    const el = scrollRef.current
    if (!el) return
    setCanLeft(el.scrollLeft > 1)
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1)
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    measure()
    el.addEventListener("scroll", measure, { passive: true })
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null
    ro?.observe(el)
    return () => { el.removeEventListener("scroll", measure); ro?.disconnect() }
  }, [tabs.length])

  useEffect(() => {
    const el = scrollRef.current?.querySelector(`[data-tab="${active}"]`)
    el?.scrollIntoView?.({ inline: "nearest", block: "nearest", behavior: "smooth" })
  }, [active])

  function nudge(dir) {
    scrollRef.current?.scrollBy({ left: dir * 140, behavior: "smooth" })
  }

  const overflowing = canLeft || canRight
  const arrow = (dir, enabled) => (
    <button
      onClick={() => nudge(dir)}
      disabled={!enabled}
      aria-label={dir < 0 ? "Scroll tabs left" : "Scroll tabs right"}
      className={`flex-shrink-0 w-7 text-sm border-slate-700 transition-colors
        ${dir < 0 ? "border-r" : "border-l"}
        ${enabled ? "text-slate-300 hover:text-white hover:bg-slate-700"
                  : "text-slate-600 cursor-default"}`}
    >
      {dir < 0 ? "‹" : "›"}
    </button>
  )

  return (
    <div className="flex border-b border-slate-700">
      {overflowing && arrow(-1, canLeft)}
      <div ref={scrollRef} className="flex flex-1 overflow-x-auto no-scrollbar">
        {tabs.map((tab) => (
          <button
            key={tab}
            data-tab={tab}
            onClick={() => onChange(tab)}
            className={`[flex:1_0_auto] px-4 py-2 text-sm font-medium capitalize whitespace-nowrap transition-colors
              ${active === tab
                ? "text-white border-b-2 border-blue-500"
                : "text-slate-400 hover:text-slate-200"}`}
          >
            {tab}
          </button>
        ))}
      </div>
      {overflowing && arrow(1, canRight)}
    </div>
  )
}
