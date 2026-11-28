// Hub-and-orbit layout: highly connected nodes ("hubs") are spread far apart;
// every other node orbits the hub it is most attached to, in concentric rings,
// like electrons around a nucleus. Pure function: ids + edges in, positions out.

const HUB_MIN_DEGREE = 6      // floor: fewer distinct neighbours than this is never a hub
const HUB_TOP_SHARE  = 0.12   // ...and only the best-connected ~12% of nodes qualify
const RING_FIRST     = 120    // radius of a hub's first ring
const RING_STEP      = 85     // gap between rings
const SLOT_SPACING   = 78     // arc length reserved per satellite on a ring
const HUB_GAP        = 90     // minimum clear space between two hubs' outer rings

export function computeHubOrbitLayout(nodeIds, edgeList) {
  const nbrs = new Map(nodeIds.map(id => [id, new Set()]))
  edgeList.forEach(({ source, target }) => {
    if (source === target || !nbrs.has(source) || !nbrs.has(target)) return
    nbrs.get(source).add(target)
    nbrs.get(target).add(source)
  })
  const deg = id => nbrs.get(id).size

  // 1. hubs (always at least one if the graph has any edges)
  const degs = nodeIds.map(deg).sort((a, b) => b - a)
  const cut  = Math.max(HUB_MIN_DEGREE, degs[Math.max(0, Math.ceil(nodeIds.length * HUB_TOP_SHARE) - 1)] ?? 0)
  let hubs = nodeIds.filter(id => deg(id) >= cut)
  if (!hubs.length) {
    const top = [...nodeIds].sort((a, b) => deg(b) - deg(a))[0]
    if (top && deg(top) > 0) hubs = [top]
  }
  const hubSet = new Set(hubs)

  // 2. give every other node a home hub: the connected hub with most neighbours,
  //    else inherit through neighbours (multi-source BFS from the hubs)
  const home = new Map()
  hubs.forEach(h => home.set(h, h))
  nodeIds.forEach(id => {
    if (hubSet.has(id)) return
    const hn = [...nbrs.get(id)].filter(n => hubSet.has(n)).sort((a, b) => deg(b) - deg(a))
    if (hn.length) home.set(id, hn[0])
  })
  let frontier = [...home.keys()]
  while (frontier.length) {
    const next = []
    frontier.forEach(id => nbrs.get(id).forEach(n => {
      if (!home.has(n)) { home.set(n, home.get(id)); next.push(n) }
    }))
    frontier = next
  }
  const orphans = nodeIds.filter(id => !home.has(id))   // no path to any hub

  const sats = new Map(hubs.map(h => [h, []]))
  nodeIds.forEach(id => { if (!hubSet.has(id) && home.has(id)) sats.get(home.get(id)).push(id) })

  // 3. ring geometry per hub: how many rings its satellites need
  const hubR = new Map()
  const rings = new Map()          // hub -> [[ids...], ...] inner ring first
  hubs.forEach(h => {
    const list = sats.get(h)
    const rs = []
    let left = list.length, r = RING_FIRST, i = 0
    while (left > 0) {
      const cap = Math.max(4, Math.floor((2 * Math.PI * r) / SLOT_SPACING))
      rs.push({ r, take: Math.min(cap, left) })
      left -= cap; r += RING_STEP; i++
    }
    rings.set(h, rs)
    hubR.set(h, (rs.length ? rs[rs.length - 1].r : 40) + 40)
  })

  // 4. place hubs: attract hubs that share neighbours / edges, but keep rings apart
  const pos = new Map()
  const n = hubs.length
  const link = new Map()          // "a|b" -> weight
  const key = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  hubs.forEach(a => hubs.forEach(b => {
    if (a >= b) return
    let w = nbrs.get(a).has(b) ? 2 : 0
    nbrs.get(a).forEach(x => { if (nbrs.get(b).has(x)) w += 1 })
    // satellites of one hub that touch the other also tie them together
    sats.get(a).forEach(s => { if (nbrs.get(s).has(b)) w += 1 })
    sats.get(b).forEach(s => { if (nbrs.get(s).has(a)) w += 1 })
    if (w) link.set(key(a, b), w)
  }))
  hubs.forEach((h, i) => {                       // golden-angle spiral start
    const rad = 220 * Math.sqrt(i + 0.5), ang = i * 2.399963
    pos.set(h, { x: rad * Math.cos(ang), y: rad * Math.sin(ang) })
  })
  for (let it = 0; it < 900; it++) {
    const attract = it < 600      // last phase: pure separation so no two systems overlap
    const f = new Map(hubs.map(h => [h, { x: 0, y: 0 }]))
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = hubs[i], b = hubs[j]
      const pa = pos.get(a), pb = pos.get(b)
      let dx = pb.x - pa.x, dy = pb.y - pa.y
      let d = Math.hypot(dx, dy) || 0.01
      const min = hubR.get(a) + hubR.get(b) + HUB_GAP
      const w = link.get(key(a, b)) || 0
      let push = 0
      if (d < min) push = (d - min) * 0.5                       // overlap: push apart (negative)
      else if (w && attract) push = Math.min(0.02 * w * (d - min), 20)      // linked: gently pull together
      dx /= d; dy /= d
      f.get(a).x += dx * push; f.get(a).y += dy * push
      f.get(b).x -= dx * push; f.get(b).y -= dy * push
    }
    hubs.forEach(h => { const p = pos.get(h), v = f.get(h); p.x += v.x; p.y += v.y })
  }

  // 5. satellites onto rings; angle chosen to face the other hubs / neighbours they touch
  hubs.forEach(h => {
    const c = pos.get(h)
    const list = [...sats.get(h)].sort((a, b) => deg(b) - deg(a))   // busiest sit on inner rings
    pos.set(h, c)
    let idx = 0
    rings.get(h).forEach(({ r, take }, ringNo) => {
      const group = list.slice(idx, idx + take); idx += take
      // preferred angle: toward neighbours that live outside this hub's system
      const pref = group.map(id => {
        let sx = 0, sy = 0
        nbrs.get(id).forEach(m => {
          const mh = home.get(m)
          if (mh && mh !== h && pos.has(mh)) { sx += pos.get(mh).x - c.x; sy += pos.get(mh).y - c.y }
        })
        return { id, a: sx || sy ? Math.atan2(sy, sx) : null }
      })
      const aimed = pref.filter(p => p.a !== null).sort((p, q) => p.a - q.a)
      const free  = pref.filter(p => p.a === null)
      // evenly spaced slots; aimed nodes take the slots closest to their preferred angle
      const slots = Array.from({ length: group.length }, (_, k) =>
        (2 * Math.PI * k) / group.length + (ringNo % 2 ? Math.PI / group.length : 0))
      const used = new Set()
      aimed.forEach(p => {
        let best = -1, bd = Infinity
        slots.forEach((s, k) => {
          if (used.has(k)) return
          const d = Math.abs(Math.atan2(Math.sin(s - p.a), Math.cos(s - p.a)))
          if (d < bd) { bd = d; best = k }
        })
        used.add(best)
        pos.set(p.id, { x: c.x + r * Math.cos(slots[best]), y: c.y + r * Math.sin(slots[best]) })
      })
      let k = 0
      free.forEach(p => {
        while (used.has(k)) k++
        used.add(k)
        pos.set(p.id, { x: c.x + r * Math.cos(slots[k]), y: c.y + r * Math.sin(slots[k]) })
      })
    })
  })

  // 6. orphans (no link to any hub): a tidy row beneath everything
  if (orphans.length) {
    const ys = [...pos.values()].map(p => p.y)
    const xs = [...pos.values()].map(p => p.x)
    const y0 = (ys.length ? Math.max(...ys) : 0) + 180
    const x0 = xs.length ? Math.min(...xs) : 0
    orphans.forEach((id, i) => pos.set(id, { x: x0 + (i % 10) * 90, y: y0 + Math.floor(i / 10) * 80 }))
  }

  return { positions: Object.fromEntries(pos), hubs }
}
