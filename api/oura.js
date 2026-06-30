// Route /api/oura : renvoie tes métriques Oura "daily" — enregistrements COMPLETS
// (score + contributors + timestamp + tout ce que l'API fournit).
// Token Oura (Personal Access Token) en variable d'env OURA_TOKEN, jamais dans le code.
//
//   GET /api/oura          -> dernier enregistrement COMPLET par métrique :
//                             { sleep:{...}, readiness:{...}, activity:{...}, ... }
//   GET /api/oura?days=7   -> tableaux bruts par métrique (récent d'abord) :
//                             { sleep:[...], readiness:[...], ... }
//
// On interroge toutes les routes "daily_*". Celles que le token n'autorise pas (ou
// sans donnée) sont ignorées et listées dans "_unavailable".
// PAT à créer sur https://cloud.ouraring.com/personal-access-tokens
const OURA = "https://api.ouraring.com/v2/usercollection";

const DAILY = {
  sleep:              "daily_sleep",
  readiness:          "daily_readiness",
  activity:           "daily_activity",
  spo2:               "daily_spo2",
  stress:             "daily_stress",
  resilience:         "daily_resilience",
  cardiovascular_age: "daily_cardiovascular_age",
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

function byDayDesc(a, b) {
  return a.day < b.day ? 1 : (a.day > b.day ? -1 : 0);
}

// Supprime les gros tableaux de séries temporelles (clé "items", ex. met.items
// de daily_activity = une valeur par minute) pour alléger la réponse.
function stripHeavy(node) {
  if (Array.isArray(node)) { node.forEach(stripHeavy); return; }
  if (node && typeof node === "object") {
    for (const k of Object.keys(node)) {
      if (k === "items") { delete node[k]; }
      else { stripHeavy(node[k]); }
    }
  }
}

export default async function handler(req, res) {
  // Secret partagé : si API_SECRET est défini, exiger ?k=<secret>. 404 = route "invisible".
  const SECRET = process.env.API_SECRET;
  if (SECRET && (!req.query || req.query.k !== SECRET)) {
    res.status(404).end();
    return;
  }

  const token = process.env.OURA_TOKEN;
  if (!token) {
    res.status(500).json({ err: "no OURA_TOKEN env" });
    return;
  }

  let days = parseInt((req.query && req.query.days) || "1", 10);
  if (isNaN(days) || days < 1) { days = 1; }
  if (days > 30) { days = 30; }

  // fenêtre large pour rattraper le dernier connu même si aujourd'hui manque
  const lookback = Math.max(days + 1, 5);
  const end = new Date();
  const start = new Date(end.getTime() - lookback * 86400000);
  const s = fmtDate(start);
  const e = fmtDate(end);

  const keys = Object.keys(DAILY);
  const settled = await Promise.allSettled(
    keys.map((k) => fetchType(DAILY[k], token, s, e))
  );

  const data = {};
  const errors = {};
  keys.forEach((k, i) => {
    const r = settled[i];
    if (r.status === "fulfilled") { data[k] = r.value; }
    else { errors[k] = r.reason ? String(r.reason.message || r.reason) : "error"; }
  });

  if (Object.keys(data).length === 0) {
    res.status(502).json({ err: "oura", detail: errors });
    return;
  }

  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1800");

  const out = {};
  for (const k of keys) {
    const arr = data[k];
    if (!arr || !arr.length) { continue; }
    const sorted = arr.slice().sort(byDayDesc);
    // days===1 : dernier enregistrement complet ; sinon : tableau brut récent d'abord
    out[k] = (days === 1) ? sorted[0] : sorted;
  }
  stripHeavy(out);
  if (Object.keys(errors).length) { out._unavailable = Object.keys(errors); }

  res.status(200).json(out);
}
