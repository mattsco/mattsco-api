// GET /api/seedtrain-sim · a simulated seed-train campaign (sim-core.js), for testing a live pipeline before real data.
//
//   kind     batches | online | counts            (required)
//   header x-api-key: the secret SEEDTRAIN_SECRET of this route only (404 without it, like the other private routes; the
//            route stays closed while SEEDTRAIN_SECRET is not set). A header, not a query parameter: query strings end up in
//            the logs of the caller (the DSS plugin logs them), headers set from a credential preset are masked.
//   limit    rows per page (default 5000), cursor: offset returned as next_cursor (absent on the last page)
//   batch, stage   optional filters
//   every other parameter: see DEFAULTS in sim-core.js (seed, start, prefix, floors, growth rates, noise, tz, speed...)
// Answer: { "now_local": ..., "data": [...], "next_cursor": n }. Stateless: the same parameters give the same answer,
// truncated at the current (simulated) time.
import { readParams, simNow, simulate } from "./_seedtrain-sim-core.js";

export default async function handler(req, res) {
  // local runs (server-local.mjs) set LOCAL_OPEN=1 and ask for no secret; on Vercel the route is closed without SEEDTRAIN_SECRET
  const SECRET = process.env.SEEDTRAIN_SECRET;
  const given = req.headers ? req.headers["x-api-key"] : undefined;
  if (!process.env.LOCAL_OPEN && (!SECRET || given !== SECRET)) { res.status(404).end(); return; }
  const q = req.query || {};
  try {
    const kind = String(q.kind || "");
    if (!["batches", "online", "counts"].includes(kind)) throw new Error("kind must be batches, online or counts");
    const p = readParams(q);
    const now = simNow(p);
    let rows = simulate(p, now)[kind];
    if (q.batch) rows = rows.filter((r) => r.batch === q.batch);
    if (q.stage) rows = rows.filter((r) => r.stage === q.stage);
    const limit = Math.max(1, Math.min(20000, Number(q.limit || 5000)));
    const from = Math.max(0, Number(q.cursor || 0));
    const page = rows.slice(from, from + limit);
    const body = { now_local: new Intl.DateTimeFormat("sv-SE", { timeZone: p.tz, dateStyle: "short", timeStyle: "medium" }).format(new Date(now)),
      total: rows.length, data: page };
    if (from + limit < rows.length) body.next_cursor = String(from + limit);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(body);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
}
