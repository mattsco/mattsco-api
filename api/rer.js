// Proxy PRIM -> mini-JSON pour la montre Garmin.
// Le FR255 ne peut pas avaler les ~58 Ko bruts de PRIM (erreur -402) : ce proxy
// filtre la bonne direction et ne renvoie que les prochains départs (~300 o).
// La clé PRIM vit dans la variable d'env PRIM_KEY (jamais renvoyée au client).
//
// Deux sens, choisis par le query param ?dir :
//   out (défaut) = matin  : départ Rueil-Malmaison  -> Paris
//                           (on garde tout SAUF les terminus ouest)
//   in           = soir   : départ Gare de Lyon     -> Rueil / St-Germain / Le Pecq
//                           (on ne garde QUE les trains branche ouest A1 : leurs
//                            terminus St-Germain, Rueil et Le Vésinet-Le Pecq
//                            desservent tous Rueil ; Cergy/Poissy exclus)
const REF_RUEIL = "STIF:StopArea:SP:58875:";   // Rueil-Malmaison RER (ZdA 58875)
const REF_GDL = "STIF:StopArea:SP:470195:";    // Paris Gare de Lyon RER A (ZdA 470195)
const PRIM_BASE =
  "https://prim.iledefrance-mobilites.fr/marketplace/stop-monitoring?MonitoringRef=";

// Config par sens. `keep` : ne garder QUE ces terminus (null = pas de whitelist).
// `drop` : exclure ces terminus (null = pas de blacklist).
const DIRS = {
  out: { ref: REF_RUEIL, keep: null, drop: ["Germain", "Rueil", "Nanterre", "Pecq"] },
  in: { ref: REF_GDL, keep: ["Germain", "Rueil", "Pecq"], drop: null },
};

function getVal(n) {
  if (n == null) return null;
  if (Array.isArray(n)) return n.length ? getVal(n[0]) : null;
  if (typeof n === "object") return getVal(n.value);
  return n;
}
function shortDest(d) {
  if (!d) return "";
  if (/Germain/.test(d)) return "St-Germain";
  if (/Rueil/.test(d)) return "Rueil";
  if (/Pecq|Vésinet|Vesinet/.test(d)) return "Le Pecq";
  if (/Marne|Chessy|Disney/.test(d)) return "Marne-Vallee";
  if (/Boissy/.test(d)) return "Boissy";
  if (/Vincennes/.test(d)) return "Vincennes";
  if (/Nation/.test(d)) return "Nation";
  if (/Torcy/.test(d)) return "Torcy";
  if (/Noisy/.test(d)) return "Noisy";
  if (/Lognes/.test(d)) return "Lognes";
  return d;
}

export default async function handler(req, res) {
  const key = process.env.PRIM_KEY;
  if (!key) {
    res.status(500).json({ err: "no PRIM_KEY env" });
    return;
  }
  const dir = req.query && req.query.dir === "in" ? "in" : "out";
  const cfg = DIRS[dir];
  try {
    const r = await fetch(PRIM_BASE + cfg.ref, {
      headers: { apikey: key, Accept: "application/json" },
    });
    if (!r.ok) {
      res.status(502).json({ err: "prim " + r.status });
      return;
    }
    const data = await r.json();
    const visits =
      (((((data || {}).Siri || {}).ServiceDelivery || {})
        .StopMonitoringDelivery || [])[0] || {}).MonitoredStopVisit || [];
    const now = Date.now();
    const out = [];
    for (const v of visits) {
      const mvj = v.MonitoredVehicleJourney;
      if (!mvj) continue;
      const line = getVal(mvj.LineRef);
      if (line && line.indexOf("C01742") < 0) continue;
      const dest = getVal(mvj.DestinationName) || "";
      if (cfg.keep && !cfg.keep.some((w) => dest.indexOf(w) >= 0)) continue;
      if (cfg.drop && cfg.drop.some((w) => dest.indexOf(w) >= 0)) continue;
      const call = mvj.MonitoredCall;
      if (!call) continue;
      const t = call.ExpectedDepartureTime || call.AimedDepartureTime;
      if (!t) continue;
      const ms = new Date(t).getTime();
      if (isNaN(ms)) continue;
      const diffMin = (ms - now) / 60000;
      if (diffMin < -1) continue;   // déjà parti
      if (diffMin > 120) continue;  // trop loin
      // t = heure de départ absolue en epoch UTC (s). La montre calcule le
      // compte à rebours elle-même -> jamais périmé, peu importe le moment du fetch.
      out.push({ t: Math.floor(ms / 1000), dest: shortDest(dest) });
    }
    out.sort((a, b) => a.t - b.t);
    res.setHeader("Cache-Control", "s-maxage=20, stale-while-revalidate=40");
    res.status(200).json({ deps: out.slice(0, 5) });
  } catch (e) {
    res.status(502).json({ err: "fetch" });
  }
}