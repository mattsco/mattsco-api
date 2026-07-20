// Proxy PRIM -> mini-JSON pour la montre Garmin.
// Le FR255 ne peut pas avaler les ~58 Ko bruts de PRIM (erreur -402) : ce proxy
// filtre la bonne direction et ne renvoie que les prochains départs (~300 o).
// La clé PRIM vit dans la variable d'env PRIM_KEY (jamais renvoyée au client).
//
// Le filtrage vit dans _rer-core.js, partagé avec /api/debug/rer : les deux
// routes voient donc exactement les mêmes trains. Ici on ne garde que {t,dest}
// pour rester léger côté montre.
import { fetchDeps, parseDir } from "./_rer-core.js";

export default async function handler(req, res) {
  const key = process.env.PRIM_KEY;
  if (!key) {
    res.status(500).json({ err: "no PRIM_KEY env" });
    return;
  }
  try {
    const r = await fetchDeps(parseDir(req), key);
    if (r.err) {
      res.status(502).json({ err: r.err });
      return;
    }
    const deps = r.deps.map((d) => ({ t: d.t, dest: d.dest }));
    res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=40");
    res.status(200).json({ deps: deps });
  } catch (e) {
    res.status(502).json({ err: "fetch" });
  }
}
