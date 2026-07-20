// Route de debug : mêmes trains que /api/rer (même module, même filtrage), mais
// en lisible pour comparer d'un coup d'œil avec l'écran RATP du quai.
//   - "min"  : minutes arrondies avant départ, ou "à l'approche" sous 30 s
//   - "dest" : identique à ce que reçoit la montre
//   - "id"   : code mission (ex. UZEL59) si PRIM le fournit
// Pas de cache : on veut l'état réel au moment du chargement.
import { fetchDeps, parseDir } from "../_rer-core.js";

// PRIM ne range pas le code mission au même endroit selon le transporteur.
// Tant qu'on n'a pas confirmé lequel colle à l'écran RATP, on expose tous les
// candidats sous "fields" -> à figer dans _rer-core.js une fois identifié.
function label(secs) {
  return secs < 30 ? "à l'approche" : Math.round(secs / 60);
}

export default async function handler(req, res) {
  const key = process.env.PRIM_KEY;
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
    const now = Date.now();
    const deps = r.deps.map((d) => ({
      min: label(d.t - Math.floor(now / 1000)),
      dest: d.dest,
      id: d.mission,
      fields: d.fields,
    }));
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      dir: dir,
      now: new Date(now).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris" }),
      deps: deps,
    });
  } catch (e) {
    res.status(502).json({ err: "fetch" });
  }
}
