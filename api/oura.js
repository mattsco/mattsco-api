// Route /api/oura : renvoie tes métriques Oura "daily".
// Token Oura (Personal Access Token) en variable d'env OURA_TOKEN, jamais dans le code.
//
//   GET /api/oura          -> dernier connu PAR métrique : { sleep:{value,day}, ... }
//   GET /api/oura?days=7   -> historique fusionné par jour : { days:[ {day, sleep, ...} ] }
//
// On interroge toutes les routes "daily_*". Celles que le token n'autorise pas (ou
// qui n'existent pas pour ton compte) sont ignorées et listées dans "_unavailable".
// PAT à créer sur https://cloud.ouraring.com/personal-access-tokens
const OURA = "https://api.ouraring.com/v2/usercollection";

// métrique -> { route, comment extraire la valeur d'un enregistrement }
const DAILY = {
  sleep:              { path: "daily_sleep",               pick: (r) => r.score },
  readiness:          { path: "daily_readiness",           pick: (r) => r.score },
  activity:           { path: "daily_activity",            pick: (r) => r.score },
  spo2:               { path: "daily_spo2",                pick: (r) => (r.spo2_percentage ? r.spo2_percentage.average : null) },
  stress:             { path: "daily_stress",              pick: (r) => r.day_summary },
  resilience:         { path: "daily_resilience",          pick: (r) => r.level },
  cardiovascular_age: { path: "daily_cardiovascular_age",  pick: (r) => r.vascular_age },
};

async function fetchType(path, token, start, end) {
  const url = `${OURA}/${path}?start_date=${start}&end_date=${end}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(String(r.status));
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

  let days = parseInt((req.query && req.query.days) || "1", 10);
  if (isNaN(days) || days < 1) { days = 1; }
  if (days > 30) { days = 30; }

  // fenêtre : assez large pour rattraper le dernier connu même si aujourd'hui manque
  const lookback = Math.max(days + 1, 5);
  const end = new Date();
  const start = new Date(end.getTime() - lookback * 86400000);
  const s = fmtDate(start);
  const e = fmtDate(end);

  const keys = Object.keys(DAILY);
  const settled = await Promise.allSettled(
    keys.map((k) => fetchType(DAILY[k].path, token, s, e))
  );

  const data = {};
  const errors = {};
  keys.forEach((k, i) => {
    const r = settled[i];
    if (r.status === "fulfilled") { data[k] = r.value; }
    else { errors[k] = r.reason ? String(r.reason.message || r.reason) : "error"; }
  });

  // tout a échoué -> vraie erreur (probablement token invalide)
  if (Object.keys(data).length === 0) {
    res.status(502).json({ err: "oura", detail: errors });
    return;
  }

  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1800");

  if (days === 1) {
    // dernier enregistrement disponible PAR métrique (dates possiblement différentes)
    const out = {};
    for (const k of keys) {
      const arr = data[k];
      if (!arr || !arr.length) { continue; }
      const latest = arr.slice().sort((a, b) => (a.day < b.day ? 1 : -1))[0];
      const v = DAILY[k].pick(latest);
      if (v == null) { continue; }
      out[k] = { value: v, day: latest.day };
    }
    if (Object.keys(errors).length) { out._unavailable = Object.keys(errors); }
    res.status(200).json(out);
  } else {
    // historique fusionné par jour
    const byDay = {};
    for (const k of keys) {
      const arr = data[k] || [];
      for (const x of arr) {
        const d = x.day;
        if (!d) { continue; }
        if (!byDay[d]) { byDay[d] = { day: d }; }
        const v = DAILY[k].pick(x);
        if (v != null) { byDay[d][k] = v; }
      }
    }
    const list = Object.values(byDay).sort((a, b) => (a.day < b.day ? 1 : -1));
    const payload = { days: list };
    if (Object.keys(errors).length) { payload._unavailable = Object.keys(errors); }
    res.status(200).json(payload);
  }
}
