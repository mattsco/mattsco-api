// Route /api/oura : renvoie tes scores Oura (sleep / readiness / activity).
// Token Oura (Personal Access Token) en variable d'env OURA_TOKEN, jamais dans le code.
//
//   GET /api/oura            -> derniers scores connus { day, sleep, readiness, activity }
//   GET /api/oura?days=7     -> historique { days: [ {day, sleep, readiness, activity}, ... ] }
//
// Personal Access Token à créer sur https://cloud.ouraring.com/personal-access-tokens
const OURA = "https://api.ouraring.com/v2/usercollection";

async function fetchType(type, token, start, end) {
  const url = `${OURA}/${type}?start_date=${start}&end_date=${end}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${type} ${r.status}`);
  const j = await r.json();
  return j.data || [];
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  const token = process.env.OURA_TOKEN;
  if (!token) {
    res.status(500).json({ err: "no OURA_TOKEN env" });
    return;
  }

  // jours d'historique demandés (1 par défaut, borné 1..30)
  let days = parseInt((req.query && req.query.days) || "1", 10);
  if (isNaN(days) || days < 1) { days = 1; }
  if (days > 30) { days = 30; }

  const end = new Date();
  const start = new Date(end.getTime() - (days + 1) * 86400000); // +1 jour de marge fuseau
  const s = fmtDate(start);
  const e = fmtDate(end);

  try {
    const [sleep, readiness, activity] = await Promise.all([
      fetchType("daily_sleep", token, s, e),
      fetchType("daily_readiness", token, s, e),
      fetchType("daily_activity", token, s, e),
    ]);

    // Fusion par jour
    const byDay = {};
    const put = (arr, key) => {
      for (const x of arr) {
        const d = x.day;
        if (!d) continue;
        if (!byDay[d]) byDay[d] = { day: d };
        byDay[d][key] = x.score != null ? x.score : null;
      }
    };
    put(sleep, "sleep");
    put(readiness, "readiness");
    put(activity, "activity");

    const list = Object.values(byDay).sort((a, b) => (a.day < b.day ? 1 : -1)); // récent d'abord

    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1800");
    if (days === 1) {
      res.status(200).json(list[0] || { err: "no data" });
    } else {
      res.status(200).json({ days: list });
    }
  } catch (err) {
    res.status(502).json({ err: String((err && err.message) || err) });
  }
}
