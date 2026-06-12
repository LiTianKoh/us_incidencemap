import { useState } from "react"
import { api } from "../api/client"
import {
  LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, ReferenceLine
} from "recharts"

const EVENT_TYPE_COLOURS = {
  macro_shock:      "bg-red-500",
  monetary_policy:  "bg-blue-500",
  financial_shock:  "bg-orange-500",
  geopolitical:     "bg-purple-500",
  trade_policy:     "bg-amber-500",
}

function EventChart({ nodeId, date, label }) {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(false)
  const [loaded,  setLoaded]  = useState(false)

  async function load() {
    if (loaded) return
    setLoading(true)
    try {
      const prices = await api.priceWindow(nodeId, date, 60, 120)
      if (prices.length === 0) return
      const base = prices.find(p => p.date >= date)?.close ?? prices[0].close
      setData(prices.map(p => ({
        date:  p.date,
        value: parseFloat(((p.close / base) * 100).toFixed(2))
      })))
      setLoaded(true)
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }

  // Load on mount
  useState(() => { load() }, [])
  if (!loaded && !loading) { load() }

  if (loading) return <p className="text-slate-600 text-xs">Loading…</p>
  if (!data)   return <p className="text-slate-600 text-xs">No data</p>

  const min = Math.min(...data.map(d => d.value))
  const max = Math.max(...data.map(d => d.value))

  return (
    <div>
      <p className="text-slate-500 text-xs mb-1">{label} (indexed to 100 at event)</p>
      <ResponsiveContainer width="100%" height={60}>
        <LineChart data={data}>
          <XAxis dataKey="date" hide />
          <YAxis domain={[min * 0.98, max * 1.02]} hide />
          <Tooltip
            contentStyle={{ background: "#1e293b", border: "1px solid #334155", fontSize: 10 }}
            labelStyle={{ color: "#94a3b8" }}
            itemStyle={{ color: "#10B981" }}
            formatter={(v) => [`${v}`, "indexed"]}
          />
          <ReferenceLine x={date} stroke="#FBBF24" strokeDasharray="3 3" />
          <Line
            type="monotone"
            dataKey="value"
            stroke="#10B981"
            dot={false}
            strokeWidth={1.5}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export default function EventPanel({ events, onEventSelect, selectedEvent }) {
  const [expanded, setExpanded] = useState(null)

  function handleClick(event) {
    const isExpanding = expanded?.id !== event.id
    setExpanded(isExpanding ? event : null)
    onEventSelect?.(isExpanding ? event : null)
  }

  if (!events || events.length === 0) return (
    <div className="text-slate-500 text-sm p-4">No events loaded.</div>
  )

  return (
    <div className="p-4 space-y-2 text-sm">
      <h2 className="text-white font-semibold text-base mb-3">Historical Events</h2>
      {events.map(event => (
        <div
          key={event.id}
          className={`rounded-lg border transition-colors cursor-pointer
            ${expanded?.id === event.id
              ? "border-amber-500 bg-slate-700"
              : "border-slate-600 bg-slate-750 hover:border-slate-500 hover:bg-slate-700"
            }`}
        >
          {/* Event header */}
          <div
            className="p-3 space-y-1"
            onClick={() => handleClick(event)}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-xs px-2 py-0.5 rounded-full text-white ${EVENT_TYPE_COLOURS[event.type] ?? "bg-slate-500"}`}>
                  {event.type.replace("_", " ")}
                </span>
                <span className="text-slate-500 text-xs">{event.date}</span>
              </div>
              <span className="text-slate-400 text-xs">
                {expanded?.id === event.id ? "▲" : "▼"}
              </span>
            </div>
            <p className="text-white font-medium">{event.label}</p>
            <p className="text-slate-400 text-xs leading-relaxed">{event.description}</p>
          </div>

          {/* Expanded: affected nodes + charts */}
          {expanded?.id === event.id && (
            <div className="px-3 pb-3 space-y-3 border-t border-slate-600 pt-3">
              <div>
                <p className="text-slate-400 text-xs mb-2">
                  Affected nodes ({event.affected_nodes.length})
                </p>
                <div className="flex flex-wrap gap-1">
                  {event.affected_nodes.map(nodeId => (
                    <span
                      key={nodeId}
                      className="text-xs bg-amber-500 bg-opacity-20 text-amber-300 border border-amber-500 border-opacity-40 px-2 py-0.5 rounded"
                    >
                      {nodeId}
                    </span>
                  ))}
                </div>
              </div>

              {/* Price charts for market nodes only */}
              <div className="space-y-3">
                {event.affected_nodes
                  .filter(id => ["spx","xauusd","wti","dxy","vix","hy_spreads",
                                 "yield_10y","yield_2y","sec_energy","sec_financials",
                                 "sec_tech","eurusd","usdjpy"].includes(id))
                  .map(nodeId => (
                    <EventChart
                      key={nodeId}
                      nodeId={nodeId}
                      date={event.date}
                      label={nodeId.toUpperCase()}
                    />
                  ))
                }
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}