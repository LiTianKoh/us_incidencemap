const BASE = "http://localhost:8000"

async function get(path) {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`API error: ${res.status} on ${path}`)
  return res.json()
}

export const api = {
  summary:     ()               => get("/summary"),
  nodes:       ()               => get("/nodes"),
  node:        (id)             => get(`/nodes/${id}`),
  neighbours:  (id)             => get(`/nodes/${id}/neighbours`),
  edges:       ()               => get("/edges"),
  graph:       (minConf = 1)    => get(`/graph?min_confidence=${minConf}`),
  paths:       (src, tgt, max)  => get(`/paths?source=${src}&target=${tgt}&max_paths=${max ?? 5}`),
  events:      ()               => get("/events"),
  event:       (id)             => get(`/events/${id}`),
  edgeStats:      (regime = "all") => get(`/edge-stats?regime=${regime}`),
  edgeStat:       (src, tgt)       => get(`/edge-stats/${src}/${tgt}`),
  regimeCurrent:  ()               => get("/regime/current"),
  regimeHistory:  ()               => get("/regime/history"),
  regimeAutoTag:  (preserveManual = true) => fetch(`${BASE}/regime/auto-tag?preserve_manual=${preserveManual}`, { method: "POST" }).then(r => r.json()),

  nodeSigmas: () => get("/node-sigmas"),

  simulate: (node_id, shock_real = null, shock_std = null, regime = "all", max_hops = 10) =>
    fetch(`${BASE}/simulate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ node_id, shock_real, shock_std, regime, max_hops }),
    }).then(r => r.json()),
  prices:      (id, days = 365) => get(`/prices/${id}?days=${days}`),
  priceWindow: (id, date, before=90, after=90) => get(`/prices/${id}/window?date=${date}&days_before=${before}&days_after=${after}`),

  proposeEvent: (text) => fetch(`${BASE}/ai/propose-event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  }).then(r => r.json()),

  commitEvent: (proposal) => fetch(`${BASE}/ai/commit-event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(proposal)
  }).then(r => r.json()),

  updateNode: (id, body)          => fetch(`${BASE}/nodes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }).then(r => r.json()),

  updateEdge: (source, target, body) => fetch(`${BASE}/edges/${source}/${target}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }).then(r => r.json()),
}