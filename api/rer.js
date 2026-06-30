// Proxy PRIM -> mini-JSON pour la montre Garmin.
// Le FR255 ne peut pas avaler les ~58 Ko bruts de PRIM (erreur -402) : ce proxy
// filtre la direction Paris et ne renvoie que les 3 prochains départs (~300 o).
// La clé PRIM vit dans la variable d'env PRIM_KEY (jamais renvoyée au client).
const PRIM_URL =
  "https://prim.iledefrance-mobilites.fr/marketplace/stop-monitoring?MonitoringRef=STIF:StopArea:SP:58875:";
const WEST = ["Germain", "Rueil", "Nanterre"]; // terminus côté opposé à Paris

function getVal(n) {
  if (n == null) return null;
  if (Array.isArray(n)) return n.length ? getVal(n[0]) : null;
  if (typeof n === "object") return getVal(n.value);
  return n;
}
function shortDest(d) {
  if (!d) return "";
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
  try {
    const r = await fetch(PRIM_URL, {
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
      if (WEST.some((w) => dest.indexOf(w) >= 0)) continue;
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
