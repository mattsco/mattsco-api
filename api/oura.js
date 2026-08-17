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
  // Fenêtre de coucher idéale calculée par Oura (couchers des nuits les mieux
  // notées + vitesse de chute de la FC en début de nuit + réveil habituel).
  // Demandée par sco-life le 2026-08-11 (spec 17) : c'est la seule seconde
  // opinion disponible sur l'heure de coucher, et elle se décale toute seule
  // quand la dette monte. Un `Promise.allSettled` couvre déjà le cas où la
  // collection ne répond pas — elle atterrit dans `_unavailable`, comme spo2.
  sleep_time:         "sleep_time",
  // Les SESSIONS NON GUIDÉES (2026-08-18). C'est là que vivent les siestes que
  // Matt enregistre à la main dans l'app Oura — « unguided session », mais aussi
  // méditation et respiration. Rien à voir avec la collection `sleep` : celle-ci
  // ne contient que ce que la bague détecte SEULE.
  //
  // Mesuré avant de l'ajouter : la bague détecte déjà 47 sessions non-nuit sur
  // 75 jours (types `sleep`, `rest`, `late_nap`), donc l'essentiel passait. Ce
  // qui manquait, c'est précisément ce que Matt déclare lui-même — et une sieste
  // déclarée est le signal le plus fiable qui soit, puisqu'il ne dépend d'aucune
  // détection.
  session:            "session",
  // Les séances enregistrées côté Oura. Doublonnent souvent Strava, mais couvrent
  // ce que Strava ne voit pas (yoga, mobilité, marche déclarée).
  workout:            "workout",
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

  // FENÊTRE EXPLICITE, en plus de `days` (2026-08-18). Le plafond était
  // `if (days > 30) days = 30`, et il bloquait un usage précis : recalculer les
  // repères de sco-life sur la période sabbatique de Matt (20/01 → 05/06). Ces
  // 137 jours existent toujours chez Oura — vérifié, l'API les sert sans
  // broncher — mais aucun appel ne pouvait les demander.
  //
  //   ?days=N                       les N derniers jours (inchangé)
  //   ?start=YYYY-MM-DD&end=…       une fenêtre arbitraire, pour les backfills
  //
  // Le plafond passe à un an. Il ne disparaît pas : sans borne, un appel maladroit
  // demanderait dix ans de sessions minute par minute à neuf collections d'un coup.
  const qs = req.query || {};
  const MAX_DAYS = 366;

  let s;
  let e;
  let days;

  if (qs.start && qs.end) {
    s = String(qs.start).slice(0, 10);
    e = String(qs.end).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e) || s > e) {
      res.status(400).json({ err: "bad_range", detail: "start et end au format YYYY-MM-DD, start <= end" });
      return;
    }
    const span = Math.round((new Date(e) - new Date(s)) / 86400000);
    if (span > MAX_DAYS) {
      res.status(400).json({ err: "range_too_wide", detail: `${span} jours demandés, ${MAX_DAYS} au plus` });
      return;
    }
    // Une fenêtre explicite rend TOUJOURS des tableaux : demander une plage puis
    // recevoir un seul enregistrement serait le piège parfait.
    days = 2;
  } else {
    days = parseInt(qs.days || "1", 10);
    if (isNaN(days) || days < 1) { days = 1; }
    if (days > MAX_DAYS) { days = MAX_DAYS; }
    // fenêtre large pour rattraper le dernier connu même si aujourd'hui manque
    const lookback = Math.max(days + 1, 5);
    const end = new Date();
    const start = new Date(end.getTime() - lookback * 86400000);
    s = fmtDate(start);
    e = fmtDate(end);
  }

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
