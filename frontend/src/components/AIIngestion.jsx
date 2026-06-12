import { useState, useEffect } from "react"
import { api } from "../api/client"

const TYPE_COLOURS = {
  macro_shock:      "bg-red-500",
  monetary_policy:  "bg-blue-500",
  financial_shock:  "bg-orange-500",
  geopolitical:     "bg-purple-500",
  trade_policy:     "bg-amber-500",
  fiscal_policy:    "bg-teal-500",
}

export default function AIIngestion({ onCommit }) {
  const [context,    setContext]    = useState("")
  const [jsonInput,  setJsonInput]  = useState("")
  const [proposal,   setProposal]   = useState(null)
  const [parseError, setParseError] = useState(null)
  const [committing, setCommitting] = useState(false)
  const [committed,  setCommitted]  = useState(false)
  const [error,      setError]      = useState(null)
  const [step,       setStep]       = useState(1) // 1: get context, 2: paste JSON

  useEffect(() => {
    fetch("http://localhost:8000/ai/context")
      .then(r => r.json())
      .then(d => setContext(d.context))
  }, [])

  function handleParseJSON() {
    setParseError(null)
    setProposal(null)
    let raw = jsonInput.trim()
    if (raw.startsWith("```")) {
      raw = raw.split("```")[1]
      if (raw.startsWith("json")) raw = raw.slice(4)
      raw = raw.trim()
    }
    try {
      const parsed = JSON.parse(raw)
      setProposal(parsed)
      setParseError(null)
    } catch (e) {
      setParseError(`Invalid JSON: ${e.message}`)
    }
  }

  async function handleCommit() {
    if (!proposal) return
    setCommitting(true)
    setError(null)
    try {
      const result = await api.commitEvent(proposal)
      if (result.detail) throw new Error(result.detail)
      setCommitted(true)
      onCommit?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setCommitting(false)
    }
  }

  return (
    <div className="p-4 space-y-4 text-sm">
      <div>
        <h2 className="text-white font-semibold text-base mb-1">AI Event Ingestion</h2>
        <p className="text-slate-400 text-xs leading-relaxed">
          Use Claude to analyse news and propose graph updates.
          No API key needed — paste the context into a Claude chat.
        </p>
      </div>

      {/* Step tabs */}
      <div className="flex border-b border-slate-600">
        {[
          { n: 1, label: "1. Get context" },
          { n: 2, label: "2. Paste result" },
        ].map(s => (
          <button
            key={s.n}
            onClick={() => setStep(s.n)}
            className={`flex-1 py-2 text-xs font-medium transition-colors
              ${step === s.n
                ? "text-white border-b-2 border-blue-500"
                : "text-slate-400 hover:text-slate-200"}`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Step 1 — copy context */}
      {step === 1 && (
        <div className="space-y-3">
          <p className="text-slate-400 text-xs leading-relaxed">
            Copy the context below, open a new Claude chat, paste it, then add your news article at the end.
          </p>

          {context ? (
            <>
              <div className="bg-slate-700 rounded p-3 text-xs text-slate-300 font-mono
                              max-h-48 overflow-y-auto whitespace-pre-wrap border border-slate-600">
                {context}
              </div>
              <button
                onClick={() => navigator.clipboard.writeText(
                  context + "\n\nNews article to analyse:\n"
                )}
                className="w-full bg-slate-600 hover:bg-slate-500 text-white rounded
                           px-3 py-2 font-medium transition-colors text-xs"
              >
                Copy context to clipboard
              </button>
              <div className="bg-slate-700 rounded p-3 text-xs text-slate-400 space-y-1">
                <p className="text-slate-300 font-medium">Then in Claude chat:</p>
                <p>1. Paste the copied context</p>
                <p>2. Add your news article below it</p>
                <p>3. Claude returns a JSON proposal</p>
                <p>4. Come back here → Step 2 → paste the JSON</p>
              </div>
              <button
                onClick={() => setStep(2)}
                className="w-full bg-blue-600 hover:bg-blue-500 text-white rounded
                           px-3 py-2 font-medium transition-colors text-xs"
              >
                Got the JSON → Go to Step 2
              </button>
            </>
          ) : (
            <p className="text-slate-500 text-xs">Loading context…</p>
          )}
        </div>
      )}

      {/* Step 2 — paste JSON */}
      {step === 2 && (
        <div className="space-y-3">
          <p className="text-slate-400 text-xs">
            Paste Claude's JSON response below.
          </p>
          <textarea
            value={jsonInput}
            onChange={(e) => { setJsonInput(e.target.value); setProposal(null); setParseError(null) }}
            placeholder='Paste JSON here… { "event": { ... } }'
            rows={8}
            className="w-full bg-slate-700 text-slate-200 rounded px-3 py-2 text-xs
                       placeholder-slate-500 resize-none border border-slate-600
                       focus:outline-none focus:border-blue-500 font-mono"
          />
          {parseError && (
            <p className="text-red-400 text-xs">{parseError}</p>
          )}
          <button
            onClick={handleParseJSON}
            disabled={!jsonInput.trim()}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-600
                       disabled:cursor-not-allowed text-white rounded px-3 py-2
                       font-medium transition-colors text-xs"
          >
            Parse JSON
          </button>
        </div>
      )}

      {/* Proposal preview */}
      {proposal && !committed && (
        <div className="space-y-3 border border-slate-600 rounded-lg p-3">
          <p className="text-slate-300 font-medium text-xs">Review before committing</p>

          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-xs px-2 py-0.5 rounded-full text-white
                ${TYPE_COLOURS[proposal.event?.type] ?? "bg-slate-500"}`}>
                {proposal.event?.type?.replace("_", " ")}
              </span>
              <span className="text-slate-400 text-xs">{proposal.event?.date}</span>
            </div>
            <p className="text-white font-medium">{proposal.event?.label}</p>
            <p className="text-slate-400 text-xs leading-relaxed">
              {proposal.event?.description}
            </p>
          </div>

          {/* Affected nodes */}
          <div>
            <p className="text-slate-500 text-xs mb-1">
              Affected nodes ({proposal.event?.affected_nodes?.length})
            </p>
            <div className="flex flex-wrap gap-1">
              {proposal.event?.affected_nodes?.map(id => (
                <span key={id}
                  className="text-xs bg-amber-500 bg-opacity-20 text-amber-300
                             border border-amber-500 border-opacity-40 px-2 py-0.5 rounded">
                  {id}
                </span>
              ))}
            </div>
          </div>

          {/* New nodes */}
          {proposal.new_nodes?.length > 0 && (
            <div>
              <p className="text-slate-500 text-xs mb-1">
                New nodes ({proposal.new_nodes.length})
              </p>
              {proposal.new_nodes.map(n => (
                <div key={n.id}
                  className="bg-slate-700 rounded px-2 py-1.5 text-xs text-slate-300">
                  <span className="text-white font-medium">{n.label}</span>
                  <span className="text-slate-500 ml-2">{n.type}</span>
                </div>
              ))}
            </div>
          )}

          {/* New edges */}
          {proposal.new_edges?.length > 0 && (
            <div>
              <p className="text-slate-500 text-xs mb-1">
                New edges ({proposal.new_edges.length})
              </p>
              {proposal.new_edges.map((e, i) => (
                <div key={i}
                  className="bg-slate-700 rounded px-2 py-1.5 text-xs
                             text-slate-300 flex items-center gap-2">
                  <span>{e.source}</span>
                  <span className={e.direction === 1 ? "text-emerald-400" : "text-red-400"}>
                    →
                  </span>
                  <span>{e.target}</span>
                  <span className="text-slate-500 ml-auto">{e.label}</span>
                </div>
              ))}
            </div>
          )}

          {/* Reasoning */}
          {proposal.reasoning && (
            <div className="bg-slate-700 rounded p-2">
              <p className="text-slate-500 text-xs mb-1">Reasoning</p>
              <p className="text-slate-300 text-xs leading-relaxed">
                {proposal.reasoning}
              </p>
            </div>
          )}

          {/* Error */}
          {error && (
            <p className="text-red-400 text-xs">{error}</p>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            <button
              onClick={handleCommit}
              disabled={committing}
              className="flex-1 bg-emerald-600 hover:bg-emerald-500
                         disabled:bg-slate-600 text-white rounded px-3 py-2
                         font-medium transition-colors text-xs"
            >
              {committing ? "Committing…" : "✓ Commit to graph"}
            </button>
            <button
              onClick={() => { setProposal(null); setJsonInput("") }}
              className="px-3 py-2 text-slate-400 hover:text-white
                         transition-colors text-xs"
            >
              Discard
            </button>
          </div>
        </div>
      )}

      {/* Success */}
      {committed && (
        <div className="bg-emerald-900 bg-opacity-30 border border-emerald-700
                        rounded p-3 text-emerald-400 text-xs text-center space-y-1">
          <p className="font-medium">✓ Committed to graph</p>
          <p>Reload the page to see the new event in the Events panel.</p>
          <button
            onClick={() => { setCommitted(false); setJsonInput(""); setProposal(null); setStep(1) }}
            className="text-emerald-300 underline"
          >
            Add another event
          </button>
        </div>
      )}
    </div>
  )
}