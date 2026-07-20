// Logique commune aux routes /api/rer (montre) et /api/debug/rer (comparaison
// visuelle avec l'écran RATP). Les deux routes DOIVENT voir exactement les mêmes
// trains : tout le filtrage/tri/troncature vit ici, les routes ne font que
// formater la sortie. Le préfixe "_" empêche Vercel d'exposer ce fichier.
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
export const DIRS = {
  out: { ref: REF_RUEIL, keep: null, drop: ["Germain", "Rueil", "Nanterre", "Pecq"] },
  in: { ref: REF_GDL, keep: ["Germain", "Rueil", "Pecq"], drop: null },
};

// Normalise ?dir= vers une clé de DIRS ("out" par défaut).
export function parseDir(req) {
  return req.query && req.query.dir === "in" ? "in" : "out";
}

export function getVal(n) {
  if (n == null) return null;
  if (Array.isArray(n)) return n.length ? getVal(n[0]) : null;
  if (typeof n === "object") return getVal(n.value);
  return n;
}

export function shortDest(d) {
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

// Code mission (ex. UZEL59, ZCAR61) : SIRI/PRIM ne le range pas toujours au même
// endroit selon le transporteur, donc on renvoie tous les candidats bruts et on
// retient le premier non vide. `fields` sert à repérer lequel colle à l'écran RATP.
export function missionFields(mvj) {
  return {
    JourneyNote: getVal(mvj.JourneyNote),
    VehicleJourneyName: getVal(mvj.VehicleJourneyName),
    TrainNumberRef: getVal(mvj.TrainNumbers && mvj.TrainNumbers.TrainNumberRef),
    DatedVehicleJourneyRef: getVal(
      mvj.FramedVehicleJourneyRef && mvj.FramedVehicleJourneyRef.DatedVehicleJourneyRef
    ),
  };
}

// Ordre confirmé sur PRIM (juillet 2026) : VehicleJourneyName porte le code
// complet affiché par la RATP ("ZEUS75"), JourneyNote seulement les 4 lettres
// ("ZEUS") -> on tente le complet d'abord.
function firstNonEmpty(fields) {
  for (const k of ["VehicleJourneyName", "TrainNumberRef", "JourneyNote", "DatedVehicleJourneyRef"]) {
    const v = fields[k];
    if (v != null && String(v).length) return String(v);
  }
  return null;
}

// Interroge PRIM et renvoie { deps: [...] } ou { err: "..." }.
// Chaque dep : { t (epoch s), dest (libellé court), mission, fields }.
export async function fetchDeps(dir, key) {
  const cfg = DIRS[dir];
  const r = await fetch(PRIM_BASE + cfg.ref, {
    headers: { apikey: key, Accept: "application/json" },
  });
  if (!r.ok) return { err: "prim " + r.status };

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
    const fields = missionFields(mvj);
    // t = heure de départ absolue en epoch UTC (s). La montre calcule le
    // compte à rebours elle-même -> jamais périmé, peu importe le moment du fetch.
    out.push({
      t: Math.floor(ms / 1000),
      dest: shortDest(dest),
      mission: firstNonEmpty(fields),
      fields: fields,
    });
  }
  out.sort((a, b) => a.t - b.t);
  return { deps: out.slice(0, 5) };
}
