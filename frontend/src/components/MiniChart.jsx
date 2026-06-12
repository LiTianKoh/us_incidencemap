import { useEffect, useState } from "react"
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts"
import { api } from "../api/client"

const PERIOD_OPTIONS = [
  { label: "1Y",  days: 365  },
  { label: "3Y",  days: 1095 },
  { label: "5Y",  days: 1825 },
  { label: "All", days: 9000 },
]

export default function MiniChart({ nodeId }) {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [period,  setPeriod]  = useState(365)

  useEffect(() => {
    if (!nodeId) return
    setLoading(true)
    setError(null)
    api.prices(nodeId, period)
      .then(prices => {
        if (prices.length === 0) { setError("no data"); return }
        setData(prices.map(p => ({
          date:  p.date,
          value: parseFloat(p.close.toFixed(2))
        })))
      })
      .catch(() => setError("no price data"))
      .finally(() => setLoading(false))
  }, [nodeId, period])

  if (loading) return <p className="text-slate-500 text-xs px-4">Loading chart…</p>
  if (error)   return <p className="text-slate-600 text-xs px-4">No price data available</p>

  const first = data[0]
  const last  = data[data.length - 1]
  const change = ((last.value - first.value) / first.value * 100).toFixed(1)
  const isUp  = parseFloat(change) >= 0

  // Sample to ~60 points max for performance
  const step    = Math.max(1, Math.floor(data.length / 60))
  const sampled = data.filter((_, i) => i % step === 0)

  return (
    <div className="px-4 pb-2 space-y-2">
      {/* Period selector */}
      <div className="flex items-center justify-between">
        <div>
          <span className="text-slate-200 text-xs font-medium">
            {last.value.toLocaleString()}
          </span>
          <span className={`text-xs ml-2 ${isUp ? "text-emerald-400" : "text-red-400"}`}>
            {isUp ? "▲" : "▼"} {Math.abs(change)}%
          </span>
        </div>
        <div className="flex gap-1">
          {PERIOD_OPTIONS.map(opt => (
            <button
              key={opt.label}
              onClick={() => setPeriod(opt.days)}
              className={`text-xs px-1.5 py-0.5 rounded transition-colors
                ${period === opt.days
                  ? "bg-blue-600 text-white"
                  : "text-slate-400 hover:text-slate-200"}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Date range */}
      <p className="text-slate-600 text-xs">
        {first.date} → {last.date}
      </p>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={80}>
        <LineChart data={sampled}>
          <XAxis dataKey="date" hide />
          <YAxis domain={["auto", "auto"]} hide />
          <Tooltip
            contentStyle={{
              background: "#1e293b",
              border: "1px solid #334155",
              fontSize: 11,
              borderRadius: 6
            }}
            labelStyle={{ color: "#94a3b8", marginBottom: 2 }}
            itemStyle={{ color: isUp ? "#10B981" : "#F87171" }}
            formatter={(v) => [v.toLocaleString(), "price"]}
            labelFormatter={(l) => l}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke={isUp ? "#10B981" : "#F87171"}
            dot={false}
            strokeWidth={1.5}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}