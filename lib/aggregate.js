import 'dotenv/config';
import {
  fetchParaglidable, fetchOpenMeteo, fetchOpenMeteoMulti, fetchDwdAlerts, fetchDwdCurrent
} from './sources.js';

const SITE = {
  name: process.env.SITE_NAME || 'Deisterflieger Feggendorf',
  lat: parseFloat(process.env.SITE_LAT || '52.29384'),
  lon: parseFloat(process.env.SITE_LON || '9.37743'),
  type: 'winch',
  region: process.env.DWD_REGION || 'EDZH'
};

// DWD aviation forecast (Luftsportbericht) — LINK ONLY, never ingested (terms forbid reuse).
const DWD_LINKS = {
  EDZH: 'https://www.dwd.de/DE/fachnutzer/luftfahrt/teaser/luftsportberichte/fbeu40_edzh_node.html',
  EDZF: 'https://www.dwd.de/DE/fachnutzer/luftfahrt/teaser/luftsportberichte/fbeu40_edzf_node.html',
  EDZM: 'https://www.dwd.de/DE/fachnutzer/luftfahrt/teaser/luftsportberichte/fbeu40_edzm_node.html'
};

// ---- tiny in-memory TTL cache ----
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

const DOW = ['So','Mo','Di','Mi','Do','Fr','Sa'];
const card16 = d => ['N','NNO','NO','ONO','O','OSO','SO','SSO','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(d/22.5)%16];

function verdict(fly) {
  if (fly >= 0.85) return { level: 4, label: 'Top-Tag' };
  if (fly >= 0.72) return { level: 3, label: 'Guter Tag' };
  if (fly >= 0.55) return { level: 2, label: 'Möglich' };
  if (fly >= 0.40) return { level: 1, label: 'Grenzwertig' };
  return { level: 0, label: 'Bleib unten' };
}

function compress(hours) {
  if (!hours.length) return [];
  const out = []; let s = hours[0], p = hours[0];
  for (let i = 1; i < hours.length; i++) {
    if (hours[i] === p + 1) p = hours[i];
    else { out.push(s === p ? `${s}h` : `${s}-${p+1}h`); s = p = hours[i]; }
  }
  out.push(s === p ? `${s}h` : `${s}-${p+1}h`);
  return out;
}

// Parse Paraglidable response -> { 'YYYY-MM-DD': {fly, xc} }
function pgByDate(pg) {
  const out = {};
  if (!pg || !pg.ok || !pg.data) return out;
  for (const [date, arr] of Object.entries(pg.data)) {
    const e = Array.isArray(arr) ? arr[0] : arr;
    const f = e && e.forecast ? e.forecast : {};
    if (f) out[date] = { fly: f.fly ?? null, xc: f.XC ?? f.xc ?? null };
  }
  return out;
}

// Build per-day aggregates from Open-Meteo hourly arrays (window 9-20h local)
function aggregateDays(om, pg, multi) {
  const days = {};
  if (!om || !om.ok || !om.data || !om.data.hourly) return [];
  const h = om.data.hourly, t = h.time;
  const get = (k, i) => (h[k] ? h[k][i] : null);

  for (let i = 0; i < t.length; i++) {
    const date = t[i].slice(0, 10);
    const hour = +t[i].slice(11, 13);
    (days[date] ||= []).push({
      h: hour, ws: get('wind_speed_10m', i), wg: get('wind_gusts_10m', i), wd: get('wind_direction_10m', i),
      ws850: get('wind_speed_850hPa', i), wd850: get('wind_direction_850hPa', i), ws700: get('wind_speed_700hPa', i),
      cc: get('cloud_cover', i), ccl: get('cloud_cover_low', i), ccm: get('cloud_cover_mid', i), cch: get('cloud_cover_high', i),
      pp: get('precipitation_probability', i), cape: get('cape', i), cin: get('convective_inhibition', i),
      blh: get('boundary_layer_height', i), fz: get('freezing_level_height', i),
      rad: get('shortwave_radiation', i), sun: get('sunshine_duration', i),
      t2: get('temperature_2m', i), td: get('dew_point_2m', i)
    });
  }

  const pgMap = pgByDate(pg);
  const conf = confidenceByDate(multi);

  return Object.keys(days).sort().map(date => {
    const all = days[date], win = all.filter(x => x.h >= 9 && x.h <= 20);
    const mx = k => Math.max(...win.map(x => x[k] || 0));
    const avgW = win.reduce((a, x) => a + (x.ws || 0), 0) / win.length;
    const maxG = mx('wg'), maxGh = (win.find(x => x.wg === maxG) || {}).h ?? null;
    const mid = win.find(x => x.h === 14) || win[Math.floor(win.length / 2)];
    const sun = win.reduce((a, x) => a + (x.sun || 0), 0) / 3600;
    const base = mid && mid.t2 != null && mid.td != null ? Math.max(0, Math.round(122 * (mid.t2 - mid.td))) : null;
    const shear = mid ? Math.abs((mid.ws850 || 0) - (mid.ws || 0)) : null;
    const best = compress(win.filter(x => x.wg <= 30 && x.ws >= 6 && x.ws <= 28 && (x.pp || 0) < 30).map(x => x.h));

    const flags = [];
    if (maxG > 40) flags.push('gusts_high'); else if (maxG > 32) flags.push('gusts');
    if (shear != null && shear > 20) flags.push('shear');
    if (mx('pp') >= 40) flags.push('rain'); else if (mx('pp') >= 20) flags.push('showers');
    if (mx('cape') >= 800) flags.push('cb'); else if (mx('cape') >= 300) flags.push('unstable');

    const pgDay = pgMap[date] || { fly: null, xc: null };
    const v = pgDay.fly != null ? verdict(pgDay.fly) : { level: null, label: '—' };
    const d = new Date(date + 'T12:00');

    return {
      date, weekday: DOW[d.getDay()],
      paraglidable: pgDay,
      verdict: { ...v, reason: reasonText(v, flags, maxG) },
      wind: {
        avg_kmh: round1(avgW), max_gust_kmh: round1(maxG), max_gust_hour: maxGh,
        gust_factor: round1(maxG / Math.max(1, avgW)),
        dir_deg_14: mid ? Math.round(mid.wd) : null, dir_card_14: mid ? card16(mid.wd) : null,
        upper_850_kmh: mid ? round1(mid.ws850) : null, upper_850_card: mid ? card16(mid.wd850) : null,
        shear_kmh: shear != null ? round1(shear) : null
      },
      thermal: {
        blh_max_m: Math.round(mx('blh')), cloud_base_m: base, sun_hours: round1(sun),
        rad_max_wm2: Math.round(mx('rad')), cape_max: Math.round(mx('cape')),
        cin_14: mid && mid.cin != null ? Math.round(mid.cin) : null
      },
      sky: {
        cloud_avg_pct: Math.round(win.reduce((a, x) => a + (x.cc || 0), 0) / win.length),
        cloud_low: mid ? mid.ccl : null, cloud_mid: mid ? mid.ccm : null, cloud_high: mid ? mid.cch : null,
        precip_prob_max: mx('pp')
      },
      best_window: best,
      flags,
      confidence: conf[date] || { models_agree: null, note: 'keine Multi-Modell-Daten' }
    };
  });
}

function reasonText(v, flags, maxG) {
  const parts = [];
  if (flags.includes('gusts_high')) parts.push(`Böen bis ${Math.round(maxG)} km/h`);
  else if (flags.includes('gusts')) parts.push('böig');
  if (flags.includes('cb')) parts.push('CB-Potenzial');
  if (flags.includes('rain')) parts.push('Niederschlag');
  if (flags.includes('shear')) parts.push('Scherung');
  return parts.length ? `${v.label} — aber: ${parts.join(', ')}.` : v.label;
}

// Multi-model agreement per day from daily gust/precip across icon/ecmwf/gfs
// Returns { date: { models_agree, gust_spread_kmh, note, details: { icon: {gust,rain}, ecmwf: {gust,rain}, gfs: {gust,rain} } } }
function confidenceByDate(multi) {
  const out = {};
  if (!multi || !multi.ok || !multi.data) return out;
  const d = multi.data, time = d.time || (d.daily && d.daily.time);
  if (!time) return out;
  const models = ['icon_seamless', 'ecmwf_ifs025', 'gfs_seamless'];
  const gustKeys = models.map(m => `wind_gusts_10m_max_${m}`);
  const rainKeys = models.map(m => `precipitation_sum_${m}`);
  const src = d.daily || d;
  for (let i = 0; i < time.length; i++) {
    const gusts = gustKeys.map(k => src[k] && src[k][i]);
    const rains = rainKeys.map(k => src[k] && src[k][i]);
    const gustVals = gusts.filter(x => x != null);
    const rainVals = rains.filter(x => x != null);
    if (!gustVals.length) continue;
    const gSpread = Math.max(...gustVals) - Math.min(...gustVals);
    const rainDisagree = rainVals.length >= 2 && (Math.max(...rainVals) - Math.min(...rainVals)) > 3;
    const agree = gSpread <= 12 && !rainDisagree;
    out[time[i]] = {
      models_agree: agree,
      gust_spread_kmh: Math.round(gSpread),
      note: agree ? 'ICON/ECMWF/GFS einig' : 'Modelle uneinig — niedrigere Verlässlichkeit',
      models: {
        icon:  { gust: round1(gusts[0]), rain: round1(rains[0]) },
        ecmwf: { gust: round1(gusts[1]), rain: round1(rains[1]) },
        gfs:   { gust: round1(gusts[2]), rain: round1(rains[2]) }
      }
    };
  }
  return out;
}

const round1 = x => (x == null || isNaN(x)) ? null : Math.round(x * 10) / 10;

function parseAlerts(a) {
  if (!a || !a.ok || !a.data || !a.data.alerts) return [];
  return a.data.alerts.map(x => ({
    event: x.event_de || x.event_en || x.event,
    severity: x.severity, urgency: x.urgency,
    headline: x.headline_de || x.headline_en || x.headline,
    onset: x.onset, expires: x.expires
  }));
}

function parseCurrent(c) {
  if (!c || !c.ok || !c.data || !c.data.weather) return null;
  const w = c.data.weather, s = c.data.sources && c.data.sources[0];
  return {
    station: s ? s.station_name : null, timestamp: w.timestamp,
    temperature_c: w.temperature, wind_kmh: w.wind_speed, wind_gust_kmh: w.wind_gust_speed,
    wind_dir_deg: w.wind_direction, condition: w.condition
  };
}

export async function buildBriefing() {
  const key = process.env.PARAGLIDABLE_KEY;
  const [pg, om, multi, alerts, current] = await Promise.all([
    cached('pg', 6 * 3600e3, () => fetchParaglidable(key)),
    cached('om', 1 * 3600e3, () => fetchOpenMeteo(SITE.lat, SITE.lon)),
    cached('multi', 3 * 3600e3, () => fetchOpenMeteoMulti(SITE.lat, SITE.lon)),
    cached('alerts', 15 * 60e3, () => fetchDwdAlerts(SITE.lat, SITE.lon)),
    cached('current', 15 * 60e3, () => fetchDwdCurrent(SITE.lat, SITE.lon))
  ]);

  return {
    generated_at: new Date().toISOString(),
    site: SITE,
    sources: [
      { name: 'Paraglidable', license: 'free API', ok: pg.ok, error: pg.error },
      { name: 'Open-Meteo (DWD ICON)', license: 'CC-BY 4.0', ok: om.ok, error: om.error },
      { name: 'Open-Meteo multi-model', license: 'CC-BY 4.0', ok: multi.ok, error: multi.error },
      { name: 'DWD via Bright Sky (alerts)', license: 'DWD GeoNutzV', ok: alerts.ok, error: alerts.error },
      { name: 'DWD via Bright Sky (current)', license: 'DWD GeoNutzV', ok: current.ok, error: current.error }
    ],
    days: aggregateDays(om, pg, multi),
    hourly: om.ok ? om.data.hourly : null,   // raw arrays for the frontend charts
    dwd_warnings: parseAlerts(alerts),
    dwd_current: parseCurrent(current),
    links: {
      // Link only — open yourself for personal flight prep. DWD terms forbid embedding/redistribution.
      dwd_fliegerprognose: DWD_LINKS[SITE.region] || DWD_LINKS.EDZH,
      dwd_region: SITE.region
    },
    attribution: 'Wetterdaten: Open-Meteo (CC-BY 4.0) · DWD (GeoNutzV, via Bright Sky) · Flyability: Paraglidable'
  };
}
