// Route /api/oura : renvoie tes métriques Oura — enregistrements COMPLETS
// (score + contributors + timestamp + tout ce que l'API fournit).
//
//   GET /api/oura          -> dernier enregistrement COMPLET par métrique :
//                             { sleep:{...}, readiness:{...}, activity:{...}, ... }
//   GET /api/oura?days=7   -> tableaux bruts par métrique (récent d'abord) :
//                             { sleep:[...], readiness:[...], ... }
//
// AUTH OURA — OAuth2 (Oura a supprimé les Personal Access Tokens, 2026).
// L'access token dure ~30 j puis expire ; le refresh token est À USAGE UNIQUE
// (chaque refresh en renvoie un nouveau et invalide l'ancien). On stocke donc le
// couple {access_token, refresh_token, expires_at} dans Vercel KV et on le fait
// tourner tout seul. Bootstrap : au premier appel (KV vide), on part du seed
// OURA_REFRESH_TOKEN (obtenu une fois via scripts/oura-oauth.mjs), puis KV fait foi.
//
// Env attendues :
//   OURA_CLIENT_ID, OURA_CLIENT_SECRET  -> ton app OAuth Oura
//   OURA_REFRESH_TOKEN                  -> seed initial (ignoré une fois KV amorcé)
//   KV_REST_API_URL, KV_REST_API_TOKEN  -> injectées par Vercel KV (Storage → KV)
//   API_SECRET                          -> gate ?k=<secret> (inchangé)
const OURA = "https://api.ouraring.com/v2/usercollection";
const TOKEN_URL = "https://api.ouraring.com/oauth/token";
const KV_KEY = "oura:tokens";

const DAILY = {
  sleep:              "daily_sleep",
  sleep_sessions:     "sleep",
  readiness:          "daily_readiness",
  activity:           "daily_activity",
  spo2:               "daily_spo2",
  stress:             "daily_stress",
  resilience:         "daily_resilience",
  cardiovascular_age: "daily_cardiovascular_age",
};

// --- Stockage KV (Upstash REST, sans SDK) ---------------------------------
function kvEnv() {
  // Upstash injecte selon l'intégration soit KV_REST_API_* (compat Vercel KV),
  // soit UPSTASH_REDIS_REST_* : on accepte les deux.
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error("KV non configuré (KV_REST_API_URL/TOKEN ou UPSTASH_REDIS_REST_URL/TOKEN)");
  }
  return { url, token };
}

async function kvGet(key) {
  const { url, token } = kvEnv();
  const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Error(`KV get: HTTP ${r.status}`);
  const j = await r.json(); // { result: "<string>" | null }
  return j.result ? JSON.parse(j.result) : null;
}

async function kvSet(key, obj) {
  const { url, token } = kvEnv();
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(obj),
  });
  if (!r.ok) throw new Error(`KV set: HTTP ${r.status}`);
}

// --- Access token OAuth2 : cache KV + refresh + rotation ------------------
async function refreshTokens(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: process.env.OURA_CLIENT_ID || "",
      client_secret: process.env.OURA_CLIENT_SECRET || "",
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`refresh Oura: HTTP ${res.status} — ${text}`);
  const t = JSON.parse(text);
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token, // NOUVEAU — l'ancien est mort
    expires_at: Date.now() + (Number(t.expires_in) || 0) * 1000,
  };
}

async function getAccessToken() {
  let bundle = await kvGet(KV_KEY);

  // Access token encore valide (marge 60 s) → on le réutilise, pas de refresh.
  if (bundle && bundle.access_token && bundle.expires_at > Date.now() + 60_000) {
    return bundle.access_token;
  }

  // Sinon on rafraîchit : refresh token de KV, ou seed d'env au tout premier appel.
  const refreshToken = (bundle && bundle.refresh_token) || process.env.OURA_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error("aucun refresh token (KV vide et OURA_REFRESH_TOKEN absent — re-seed via scripts/oura-oauth.mjs)");
  }
  bundle = await refreshTokens(refreshToken);
  await kvSet(KV_KEY, bundle); // persiste le NOUVEAU refresh token avant tout usage
  return bundle.access_token;
}

// --- Fetch Oura ------------------------------------------------------------
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

  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    // Token cassé (chaîne de refresh rompue) ou KV indisponible : 502 explicite.
    res.status(502).json({ err: "oura_auth", detail: String(e.message || e) });
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
