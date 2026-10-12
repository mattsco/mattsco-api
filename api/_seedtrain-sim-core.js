// Seed-train campaign simulator: deterministic, stateless, generic.
//
// Every call rebuilds the whole campaign from its parameters and returns what exists up to "now": the same parameters
// always give the same batches, sensors and counts, so a flow that reads this API stays recomputable.
// Nothing here belongs to a client: the defaults are neutral, and the caller passes the real process values (floors,
// windows, growth rates, noise) as query parameters.
//
// A campaign: n_batches batches inoculated every every_h hours from `start`. Each batch runs stage 1, then stage 2 (names
// in stage_names). In a stage the cell density grows exponentially at a rate drawn per campaign and per batch. A sensor
// reads every step_min minutes an oxygen uptake linked to the density (density = c * uptake ^ gamma, with noise), plus
// pH, dissolved oxygen, temperature and weight. Lab counts follow a routine plan (one every routine_h hours from
// inoculation) and the operator's habit: when the last count projects the floor before the next routine count, a count
// is added just after the projected crossing. The first count at or above the floor triggers the transfer after a
// preparation delay; a count above the top of the window is a deviation (the transfer happens anyway).

// ---------- random numbers: one reproducible stream per (seed, entity, purpose) ----------

function hash(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function rng(...keys) {
  let a = hash(keys.join("|"))();
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => {
    const u = 1 - next(), v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return { next, normal };
}

// ---------- parameters ----------

export const DEFAULTS = {
  seed: "demo",
  prefix: "SM",             // campaign letters of the batch IDs (choose one no real campaign uses)
  first_number: 1000,
  n_batches: 8,
  every_h: 24,              // hours between two inoculations
  start: "",                // first inoculation, ISO 8601; empty: Monday 06:00 UTC of the current week
  speed: 1,                 // 1 = real time; 60 = one simulated hour per real minute, from `anchor`
  anchor: "",               // ISO instant where the accelerated clock starts (needed when speed != 1)
  tz: "UTC",                // time zone of the local times written in the output
  stage_names: "S1,S2",
  units_1: "A1,A2",
  units_2: "B1,B2",
  step_min: 5,              // sensor period
  routine_h: 24,            // routine lab count every routine_h hours from the start of the stage
  floor_1: 3, top_1: 5, floor_2: 4, top_2: 6,
  v0_1: 1, v0_sd_1: 0.15, v0_2: 1, v0_sd_2: 0.12,
  mu_1: 0.03, mu_2: 0.025,  // growth rate per hour
  mu_campaign_rel_sd: 0.09, // one draw per campaign (seed)
  mu_batch_rel_sd: 0.08,    // one draw per batch and stage
  gamma_1: 0.85, gamma_2: 0.85,
  c_1: 3, c_2: 4,           // density = c * uptake ^ gamma
  c_batch_rel_sd: 0.25,
  uptake_noise_rel: 0.012,
  count_noise_rel: 0.1,
  extra_lag_h: 1,           // the operator's extra count, this long after the projected crossing
  recount_h: 4,             // if that count still reads below the floor, the next one this long after
  prep_h_1: 3.5, prep_h_2: 2.5, prep_rel_sd: 0.35,
  ph_1: 7, ph_2: 6.8, do_pct: 35, temp_c: 37, weight_1: 360, weight_2: 1900,
  viab_0: 98, viab_drop_per_h: 0.02,
  glucose_0: 6, glucose_use: 0.012, lactate_0: 0.4, lactate_make: 0.01, osmo: 320, pco2: 30,
  anomalies: 1,             // 1: one batch with a count far from what the previous one expected, one sensor gap
  max_stage_h: 120,         // safety: a stage never runs longer
};

export function readParams(query) {
  const p = { ...DEFAULTS };
  for (const [k, v] of Object.entries(query || {})) {
    if (!(k in DEFAULTS) || v === undefined || v === "") continue;
    p[k] = typeof DEFAULTS[k] === "number" ? Number(v) : String(v);
    if (typeof DEFAULTS[k] === "number" && !Number.isFinite(p[k])) throw new Error("parameter " + k + " is not a number");
  }
  if (!p.start) {
    const d = new Date();
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7), 6));
    p.start = monday.toISOString();
  }
  if (Number.isNaN(Date.parse(p.start))) throw new Error("start is not an ISO date");
  if (p.speed !== 1 && Number.isNaN(Date.parse(p.anchor))) throw new Error("anchor is needed when speed is not 1");
  return p;
}

// the simulated instant, in ms
export function simNow(p, realNowMs = Date.now()) {
  if (p.speed === 1) return realNowMs;
  return Date.parse(p.anchor) + (realNowMs - Date.parse(p.anchor)) * p.speed;
}

// ---------- local time strings ----------

function localFormatter(tz) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  return (ms) => {
    const parts = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  };
}

// ---------- one stage of one batch ----------

const H = 3600 * 1000;

function runStage(p, batch, s, startMs, campaignFactor) {
  const r = rng(p.seed, batch.id, "stage" + s);
  const floor = p["floor_" + s], top = p["top_" + s];
  const mu = p["mu_" + s] * campaignFactor * Math.exp(p.mu_batch_rel_sd * r.normal());
  const v0 = Math.max(0.2, p["v0_" + s] + p["v0_sd_" + s] * r.normal());
  const c = p["c_" + s] * Math.exp(p.c_batch_rel_sd * r.normal());
  const gamma = p["gamma_" + s];
  const density = (h) => v0 * Math.exp(mu * h);
  // the operator projects with the stage's typical rate, not the batch's own
  const muTyp = p["mu_" + s];
  const counts = [];
  const noisy = (v) => v * Math.exp(p.count_noise_rel * r.normal());
  const surprise = batch.surprise && s === 2;   // one count reads far below what was expected

  let t = 0, rank = 0, transferH = null, deviation = false, extra = false;
  while (t <= p.max_stage_h) {
    let v = noisy(density(t));
    if (surprise && rank === 2) v *= 0.62;
    counts.push({ h: t, rank, vcc: v, extra });
    if (v >= floor) {   // the first count at or above the floor: transfer after the preparation
      deviation = v > top;
      transferH = t + Math.max(0.25, p["prep_h_" + s] * Math.exp(p.prep_rel_sd * r.normal()));
      break;
    }
    const nextRoutine = (Math.floor(t / p.routine_h + 1e-9) + 1) * p.routine_h;
    const projected = t + Math.log(floor / v) / muTyp;   // when the operator expects the floor
    let next = nextRoutine;
    if (extra) {
      next = Math.min(nextRoutine, t + p.recount_h);   // an extra count still below the floor: count again soon
    } else if (projected + p.extra_lag_h < nextRoutine) {
      next = Math.max(t + 0.5, projected + p.extra_lag_h);
    }
    extra = next < nextRoutine;
    t = next;
    rank += 1;
  }
  const endH = transferH ?? p.max_stage_h;
  return { s, startMs, endMs: startMs + endH * H, transferH, deviation, mu, v0, c, gamma, counts, density, floor, top };
}

// ---------- the campaign ----------

export function simulate(p, nowMs) {
  const campaignFactor = Math.exp(p.mu_campaign_rel_sd * rng(p.seed, "campaign").normal());
  const names = p.stage_names.split(",").map((x) => x.trim());
  const units = [p.units_1.split(","), p.units_2.split(",")].map((u) => u.map((x) => x.trim()));
  const pick = rng(p.seed, "anomalies");
  const surpriseIdx = p.anomalies ? Math.floor(pick.next() * p.n_batches) : -1;
  const gapIdx = p.anomalies ? (surpriseIdx + 1 + Math.floor(pick.next() * (p.n_batches - 1))) % p.n_batches : -1;
  const fmt = localFormatter(p.tz);
  const start = Date.parse(p.start);
  const out = { batches: [], online: [], counts: [] };

  for (let i = 0; i < p.n_batches; i++) {
    const batch = { id: p.prefix + String(p.first_number + i).padStart(4, "0"), surprise: i === surpriseIdx, gap: i === gapIdx };
    const inoc = start + i * p.every_h * H;
    let stageStart = inoc;
    for (const s of [1, 2]) {
      if (stageStart > nowMs) {   // the inoculation is planned; the next stage starts at a transfer not known yet
        out.batches.push({ batch: batch.id, campaign: p.prefix, stage: names[s - 1], unit: units[s - 1][i % units[s - 1].length],
          start_local: fmt(stageStart), end_local: null, status: "planned" });
        break;
      }
      const st = runStage(p, batch, s, stageStart, campaignFactor);
      const unit = units[s - 1][i % units[s - 1].length];
      const done = st.endMs <= nowMs;
      out.batches.push({ batch: batch.id, campaign: p.prefix, stage: names[s - 1], unit,
        start_local: fmt(stageStart), end_local: done ? fmt(st.endMs) : null, status: done ? "done" : "running" });

      // sensor: every step_min minutes until the end of the stage or now
      const rs = rng(p.seed, batch.id, "sensor" + s);
      const last = Math.min(st.endMs, nowMs);
      const gapFrom = batch.gap && s === 1 ? stageStart + 0.4 * (st.endMs - stageStart) : Infinity;
      const gapTo = gapFrom + 3 * H;
      for (let ms = stageStart; ms <= last; ms += p.step_min * 60 * 1000) {
        if (ms >= gapFrom && ms < gapTo) continue;   // a sensor outage of three hours
        const h = (ms - stageStart) / H;
        const uptake = Math.pow(st.density(h) / st.c, 1 / st.gamma) * Math.exp(p.uptake_noise_rel * rs.normal());
        out.online.push({ batch: batch.id, stage: names[s - 1], unit, ts_local: fmt(ms), duration_h: +h.toFixed(4),
          uptake: +uptake.toFixed(5), ph: +(p["ph_" + s] + 0.01 * rs.normal()).toFixed(4), do_pct: +(p.do_pct + 1.5 * rs.normal()).toFixed(3),
          temp_c: +(p.temp_c + 0.03 * rs.normal()).toFixed(3), weight_kg: +(p["weight_" + s] * (1 + 0.0002 * h) + 0.3 * rs.normal()).toFixed(2) });
      }

      // lab counts up to now
      const rc = rng(p.seed, batch.id, "counts" + s);
      let ivc = 0, prev = null;
      for (const c of st.counts) {
        const ms = stageStart + c.h * H;
        if (ms > nowMs || ms > st.endMs + 1) break;
        if (prev) ivc += ((prev.vcc + c.vcc) / 2) * ((c.h - prev.h) / 24);
        out.counts.push({ batch: batch.id, stage: names[s - 1], unit, rank: c.rank, time_local: fmt(ms), duration_h: +c.h.toFixed(4),
          vcc: +c.vcc.toFixed(2), viability: +(p.viab_0 - p.viab_drop_per_h * c.h + 0.6 * rc.normal()).toFixed(1),
          ph: +(p["ph_" + s] + 0.03 * rc.normal()).toFixed(2), glucose: +Math.max(0.5, p.glucose_0 - p.glucose_use * c.h * st.density(c.h) / 2).toFixed(2),
          lactate: +(p.lactate_0 + p.lactate_make * c.h * st.density(c.h) / 2).toFixed(2), osmo: Math.round(p.osmo + 4 * rc.normal()),
          pco2: +(p.pco2 + 3 * rc.normal()).toFixed(1), ivc: +(c.rank === 0 ? c.vcc : ivc).toFixed(2) });
        prev = c;
      }
      if (!done) break;          // the next stage has not started yet
      stageStart = st.endMs;     // the next stage starts at the transfer
    }
  }
  return out;
}
