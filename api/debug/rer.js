// Route de debug : mêmes trains que /api/rer (même module, même filtrage), mais
// en lisible pour comparer d'un coup d'œil avec l'écran RATP du quai.
//   - "min"  : minutes arrondies avant départ, ou "à l'approche" sous 30 s
//   - "dest" : identique à ce que reçoit la montre
//   - "id"   : code mission (ex. ZEUS75) si PRIM le fournit
// Rendu HTML pour un navigateur (usage téléphone sur le quai), JSON pour curl
// ou ?json=1. Pas de cache : on veut l'état réel au moment du chargement.
import { fetchDeps, parseDir } from "../_rer-core.js";

function label(secs) {
  return secs < 30 ? "à l'approche" : Math.round(secs / 60);
}

// Le navigateur veut du HTML ; curl/la montre veulent du JSON.
function wantsHtml(req) {
  if (req.query && req.query.json === "1") return false;
  if (req.query && req.query.html === "1") return true;
  const accept = (req.headers && req.headers.accept) || "";
  return accept.indexOf("text/html") >= 0;
}

// Les libellés viennent de PRIM (source externe) -> toujours échapper.
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

const TITLES = {
  in: { t: "Retour", sub: "Gare de Lyon → Rueil" },
  out: { t: "Aller", sub: "Rueil → Paris" },
};

function renderRow(d) {
  const approaching = typeof d.min !== "number";
  const big = approaching ? "→" : esc(d.min);
  const unit = approaching ? "à l'approche" : "min";
  return (
    '<li class="row' + (approaching ? " now" : "") + '">' +
    '<div class="when"><span class="big">' + big + "</span>" +
    '<span class="unit">' + unit + "</span></div>" +
    '<div class="info"><span class="dest">' + esc(d.dest) + "</span>" +
    '<span class="id">' + esc(d.id || "—") + "</span></div>" +
    "</li>"
  );
}

function renderHtml(dir, now, deps) {
  const other = dir === "in" ? "out" : "in";
  const meta = TITLES[dir];
  const rows = deps.length
    ? deps.map(renderRow).join("")
    : '<li class="empty">Aucun train dans les 2 h.</li>';
  return (
    "<!doctype html><html lang=fr><head><meta charset=utf-8>" +
    '<meta name=viewport content="width=device-width,initial-scale=1">' +
    "<title>RER A — " + esc(meta.t) + "</title>" +
    "<style>" +
    ":root{--bg:#fff;--fg:#111;--dim:#666;--line:#e5e5e5;--accent:#0b5cff;--chip:#f2f2f4}" +
    "@media(prefers-color-scheme:dark){:root{--bg:#111;--fg:#f5f5f5;--dim:#999;--line:#2a2a2a;--accent:#5b9bff;--chip:#1e1e20}}" +
    "*{box-sizing:border-box}" +
    "body{margin:0;padding:1.25rem 1rem 2rem;background:var(--bg);color:var(--fg);" +
    "font:16px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
    "-webkit-text-size-adjust:100%}" +
    "header{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;margin-bottom:.25rem}" +
    "h1{font-size:1.35rem;margin:0;font-weight:650}" +
    ".sub{color:var(--dim);font-size:.9rem;margin:0 0 1.25rem}" +
    "a{color:var(--accent);text-decoration:none;font-size:.9rem;white-space:nowrap}" +
    "ul{list-style:none;margin:0;padding:0}" +
    ".row{display:flex;align-items:center;gap:1rem;padding:.85rem 0;border-bottom:1px solid var(--line)}" +
    ".when{flex:0 0 4.5rem;text-align:right}" +
    ".big{display:block;font-size:2rem;font-weight:600;font-variant-numeric:tabular-nums;line-height:1}" +
    ".unit{display:block;color:var(--dim);font-size:.7rem;margin-top:.15rem}" +
    ".row.now .big,.row.now .unit{color:var(--accent)}" +
    ".info{display:flex;flex-direction:column;gap:.3rem;min-width:0}" +
    ".dest{font-size:1.05rem;font-weight:550}" +
    ".id{font:500 .8rem/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);" +
    "background:var(--chip);padding:.28rem .45rem;border-radius:5px;align-self:flex-start;letter-spacing:.03em}" +
    ".empty{color:var(--dim);padding:2rem 0;text-align:center}" +
    "footer{margin-top:1.5rem;color:var(--dim);font-size:.8rem;display:flex;" +
    "justify-content:space-between;align-items:center;gap:1rem}" +
    "</style></head><body>" +
    "<header><h1>RER A — " + esc(meta.t) + "</h1>" +
    '<a href="?dir=' + other + '">' + esc(TITLES[other].t) + " →</a></header>" +
    '<p class="sub">' + esc(meta.sub) + "</p>" +
    "<ul>" + rows + "</ul>" +
    '<footer><span>Màj ' + esc(now) + "</span>" +
    '<a href="?dir=' + dir + '&amp;json=1">JSON</a></footer>' +
    // Rechargement auto : on compare avec l'écran du quai, une page figée
    // induirait en erreur. Uniquement quand l'onglet est visible.
    "<script>setInterval(function(){if(!document.hidden)location.reload()},30000)</script>" +
    "</body></html>"
  );
}

export default async function handler(req, res) {
  const key = process.env.PRIM_KEY;
  const html = wantsHtml(req);
  if (!key) {
    res.status(500).json({ err: "no PRIM_KEY env" });
    return;
  }
  const dir = parseDir(req);
  try {
    const r = await fetchDeps(dir, key);
    if (r.err) {
      res.status(502).json({ err: r.err });
      return;
    }
    const nowMs = Date.now();
    const now = new Date(nowMs).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris" });
    const deps = r.deps.map((d) => ({
      min: label(d.t - Math.floor(nowMs / 1000)),
      dest: d.dest,
      id: d.mission,
      fields: d.fields,
    }));
    res.setHeader("Cache-Control", "no-store");
    if (html) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(renderHtml(dir, now, deps));
      return;
    }
    res.status(200).json({ dir: dir, now: now, deps: deps });
  } catch (e) {
    res.status(502).json({ err: "fetch" });
  }
}
