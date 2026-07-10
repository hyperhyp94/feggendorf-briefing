import 'dotenv/config';
import {
  fetchParaglidable, fetchOpenMeteo, fetchOpenMeteoMulti, fetchOpenMeteoMultiHourly,
  fetchDwdAlerts, fetchDwdCurrent, fetchConvek, fetchDwdStation
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

// Crosswind / headwind components for Ost-West-Schlepprichtung (Runway-Achse 90°/270°)
// alpha = wd - 90° → crosswind = ws·|sin(alpha)|, headwind_E = ws·cos(alpha)
// Ideal direction: 'O' wenn Gegenwind aus Osten (hw >= 0), sonst 'W'
function calcWindComponents(wd_deg, ws_kmh) {
  const alpha = (wd_deg - 90) * Math.PI / 180;
  const crosswind_kmh = round1(Math.abs(ws_kmh * Math.sin(alpha)));
  const headwind_kmh = round1(ws_kmh * Math.cos(alpha)); // + = Gegenwind für Schlepp O
  const ideal_dir = headwind_kmh >= 0 ? 'O' : 'W';
  return { crosswind_kmh, headwind_kmh, ideal_dir };
}

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
function aggregateDays(om, pg, multi, hourlyModelsMap) {
  const days = {};
  const pgMap = pgByDate(pg);
  const conf = confidenceByDate(multi);

  // Fallback: wenn Open-Meteo down ist, trotzdem Tag-Einträge aus Paraglidable bauen
  if (!om || !om.ok || !om.data || !om.data.hourly) {
    return Object.keys(pgMap).sort().map(date => {
      const pgDay = pgMap[date] || { fly: null, xc: null };
      const v = pgDay.fly != null ? verdict(pgDay.fly) : { level: null, label: '—' };
      const d = new Date(date + 'T12:00');
      return {
        date, weekday: DOW[d.getDay()],
        paraglidable: pgDay,
        verdict: { ...v, reason: v.label + ' (nur Paraglidable — Open-Meteo nicht verfügbar)' },
        wind: { avg_kmh: null, max_gust_kmh: null, max_gust_hour: null, gust_factor: null, dir_deg_14: null, dir_card_14: null, upper_850_kmh: null, upper_850_card: null, shear_kmh: null },
        thermal: { blh_max_m: null, cloud_base_m: null, sun_hours: null, rad_max_wm2: null, cape_max: null, cin_14: null },
        sky: { cloud_avg_pct: null, cloud_low: null, cloud_mid: null, cloud_high: null, precip_prob_max: null },
        best_window: [],
        flags: [],
        confidence: { ...(conf[date] || { models_agree: null, note: 'keine Multi-Modell-Daten' }), hourly_models: (hourlyModelsMap && hourlyModelsMap[date]) || [] }
      };
    });
  }

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

  return Object.keys(days).sort().map(date => {
    const all = days[date], win = all.filter(x => x.h >= 9 && x.h <= 20);
    const mx = k => Math.max(...win.map(x => x[k] || 0));
    const avgW = win.reduce((a, x) => a + (x.ws || 0), 0) / win.length;
    const maxG = mx('wg'), maxGh = (win.find(x => x.wg === maxG) || {}).h ?? null;
    const mid = win.find(x => x.h === 14) || win[Math.floor(win.length / 2)];
    const sun = win.reduce((a, x) => a + (x.sun || 0), 0) / 3600;
    const base = mid && mid.t2 != null && mid.td != null ? Math.max(0, Math.round(122 * (mid.t2 - mid.td))) : null;
    const shear = mid ? Math.abs((mid.ws850 || 0) - (mid.ws || 0)) : null;
    const midWC = mid && mid.wd != null ? calcWindComponents(mid.wd, mid.ws || 0) : null;
    const best = compress(win.filter(x => {
      if (x.wg > 30 || x.ws < 6 || x.ws > 28 || (x.pp || 0) >= 30) return false;
      if (x.wd == null) return true;
      const alpha = (x.wd - 90) * Math.PI / 180;
      const cw = Math.abs((x.ws || 0) * Math.sin(alpha));
      const hw = (x.ws || 0) * Math.cos(alpha);
      return cw <= 15 && hw >= -15;
    }).map(x => x.h));

    const flags = [];
    if (maxG > 40) flags.push('gusts_high'); else if (maxG > 32) flags.push('gusts');
    if (shear != null && shear > 20) flags.push('shear');
    if (mx('pp') >= 40) flags.push('rain'); else if (mx('pp') >= 20) flags.push('showers');
    if (mx('cape') >= 800) flags.push('cb'); else if (mx('cape') >= 300) flags.push('unstable');
    if (midWC && midWC.crosswind_kmh > 20) flags.push('crosswind_high');
    else if (midWC && midWC.crosswind_kmh > 12) flags.push('crosswind');

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
        shear_kmh: shear != null ? round1(shear) : null,
        crosswind_kmh: midWC ? midWC.crosswind_kmh : null,
        headwind_kmh: midWC ? midWC.headwind_kmh : null,
        ideal_dir: midWC ? midWC.ideal_dir : null
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
      confidence: { ...(conf[date] || { models_agree: null, note: 'keine Multi-Modell-Daten' }), hourly_models: (hourlyModelsMap && hourlyModelsMap[date]) || [] }
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
  if (flags.includes('crosswind_high')) parts.push('starker Querwind');
  else if (flags.includes('crosswind')) parts.push('Querwind');
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
  const wsKeys  = models.map(m => `wind_speed_10m_max_${m}`);
  const wdKeys  = models.map(m => `wind_direction_10m_dominant_${m}`);
  const src = d.daily || d;
  for (let i = 0; i < time.length; i++) {
    const gusts = gustKeys.map(k => src[k] && src[k][i]);
    const rains = rainKeys.map(k => src[k] && src[k][i]);
    const wss   = wsKeys.map(k => src[k] && src[k][i]);
    const wds   = wdKeys.map(k => src[k] && src[k][i]);
    const gustVals = gusts.filter(x => x != null);
    const rainVals = rains.filter(x => x != null);
    if (!gustVals.length) continue;
    const gSpread = Math.max(...gustVals) - Math.min(...gustVals);
    const rainDisagree = rainVals.length >= 2 && (Math.max(...rainVals) - Math.min(...rainVals)) > 3;
    // Wind direction disagreement: check angular spread among available models
    const wdVals = wds.filter(x => x != null);
    let wdDisagree = false;
    if (wdVals.length >= 2) {
      const iconDir = wdVals[0];
      wdDisagree = wdVals.slice(1).some(wd => {
        const diff = Math.abs(wd - iconDir); return Math.min(diff, 360 - diff) > 45;
      });
    }
    const agree = gSpread <= 12 && !rainDisagree && !wdDisagree;
    out[time[i]] = {
      models_agree: agree,
      gust_spread_kmh: Math.round(gSpread),
      note: agree ? 'ICON/ECMWF/GFS einig' : 'Modelle uneinig — niedrigere Verlässlichkeit',
      models: {
        icon:  { gust: round1(gusts[0]), rain: round1(rains[0]), wind_speed: round1(wss[0]), wind_dir: wds[0] != null ? Math.round(wds[0]) : null },
        ecmwf: { gust: round1(gusts[1]), rain: round1(rains[1]), wind_speed: round1(wss[1]), wind_dir: wds[1] != null ? Math.round(wds[1]) : null },
        gfs:   { gust: round1(gusts[2]), rain: round1(rains[2]), wind_speed: round1(wss[2]), wind_dir: wds[2] != null ? Math.round(wds[2]) : null }
      }
    };
  }
  return out;
}

const round1 = x => (x == null || isNaN(x)) ? null : Math.round(x * 10) / 10;

// Stündliche Multi-Modell-Daten für die Stunden 6/13/16/19 pro Tag aufbereiten
// Eingabe: multiH-Response von fetchOpenMeteoMultiHourly
// Ausgabe: { 'YYYY-MM-DD': [ { hour, models: { icon:{ws,wd,wg,temp}, ecmwf:{...}, gfs:{...} } }, ... ] }
const TARGET_HOURS = [6, 13, 16, 19];
const MODEL_KEYS = ['icon_seamless', 'ecmwf_ifs025', 'gfs_seamless'];
const MODEL_SHORT = { icon_seamless: 'icon', ecmwf_ifs025: 'ecmwf', gfs_seamless: 'gfs' };

function hourlyModelsByDate(multiH) {
  const out = {};
  if (!multiH || !multiH.ok || !multiH.data || !multiH.data.hourly) return out;
  const h = multiH.data.hourly;
  const time = h.time;
  if (!time) return out;

  for (let i = 0; i < time.length; i++) {
    const hour = +time[i].slice(11, 13);
    if (!TARGET_HOURS.includes(hour)) continue;
    const date = time[i].slice(0, 10);

    const models = {};
    for (const mk of MODEL_KEYS) {
      const short = MODEL_SHORT[mk];
      const ws = h[`wind_speed_10m_${mk}`]?.[i] ?? null;
      const rawWd = h[`wind_direction_10m_${mk}`]?.[i] ?? null;
      const wd = rawWd != null ? Math.round(rawWd) : null;
      const wg = h[`wind_gusts_10m_${mk}`]?.[i] ?? null;
      const temp = h[`temperature_2m_${mk}`]?.[i] ?? null;
      const pp = h[`precipitation_probability_${mk}`]?.[i] ?? null;
      models[short] = {
        ws: round1(ws), wd, wg: round1(wg),
        temp: temp != null ? round1(temp) : null,
        pp: pp != null ? Math.round(pp) : null
      };
    }

    (out[date] ||= []).push({ hour, models });
  }

  // Sicherstellen dass die Stunden sortiert sind
  for (const date of Object.keys(out)) {
    out[date].sort((a, b) => a.hour - b.hour);
  }
  return out;
}

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
  const convekKey = process.env.CONVEK_API_KEY;
  const dwdStation = process.env.DWD_STATION_ID;
  const [pg, om, multi, multiH, alerts, current, cvk, dwdSt] = await Promise.all([
    cached('pg', 6 * 3600e3, () => fetchParaglidable(key)),
    cached('om', 1 * 3600e3, () => fetchOpenMeteo(SITE.lat, SITE.lon)),
    cached('multi', 3 * 3600e3, () => fetchOpenMeteoMulti(SITE.lat, SITE.lon)),
    cached('multiH', 1 * 3600e3, () => fetchOpenMeteoMultiHourly(SITE.lat, SITE.lon)),
    cached('alerts', 15 * 60e3, () => fetchDwdAlerts(SITE.lat, SITE.lon)),
    cached('current', 15 * 60e3, () => fetchDwdCurrent(SITE.lat, SITE.lon)),
    cached('cvk', 3 * 3600e3, () => fetchConvek(convekKey, SITE.lat, SITE.lon)),
    cached('dwdst', 30 * 60e3, () => fetchDwdStation(dwdStation))
  ]);

  const hourlyModelsMap = hourlyModelsByDate(multiH);

  return {
    generated_at: new Date().toISOString(),
    site: SITE,
    sources: [
      { name: 'Paraglidable', license: 'free API', ok: pg.ok, error: pg.error },
      { name: 'Convek Soaring', license: 'free API', ok: cvk.ok, error: cvk.error },
      { name: 'Open-Meteo (DWD ICON)', license: 'CC-BY 4.0', ok: om.ok, error: om.error },
      { name: 'Open-Meteo multi-model daily', license: 'CC-BY 4.0', ok: multi.ok, error: multi.error },
      { name: 'Open-Meteo multi-model hourly', license: 'CC-BY 4.0', ok: multiH.ok, error: multiH.error },
      { name: 'DWD via Bright Sky (alerts)', license: 'DWD GeoNutzV', ok: alerts.ok, error: alerts.error },
      { name: 'DWD via Bright Sky (current)', license: 'DWD GeoNutzV', ok: current.ok, error: current.error },
      { name: 'DWD Station', license: 'DWD OpenData', ok: dwdSt.ok, error: dwdSt.error }
    ],
    days: aggregateDays(om, pg, multi, hourlyModelsMap),
    hourly: om.ok ? om.data.hourly : null,
    multi_hourly: multiH.ok ? multiH.data.hourly : null,
    convek: parseConvek(cvk),
    dwd_warnings: parseAlerts(alerts),
    dwd_current: parseCurrent(current),
    dwd_station: parseDwdStation(dwdSt),
    links: {
      dwd_fliegerprognose: DWD_LINKS[SITE.region] || DWD_LINKS.EDZH,
      dwd_region: SITE.region
    },
    attribution: 'Wetterdaten: Open-Meteo (CC-BY 4.0) · DWD (GeoNutzV) · Convek · Flyability: Paraglidable'
  };
}

function parseConvek(cvk) {
  if (!cvk || !cvk.ok || !cvk.data || cvk.data.error) return null;
  const d = cvk.data;
  return {
    valid_date: d.valid_date,
    valid_time: d.valid_time,
    day_rating: d.site ? d.site.day_rating : null,
    wstar_ms: d.site ? d.site.wstar_ms : null,
    cloudbase_agl_ft: d.site ? d.site.cloudbase_agl_ft : null,
    cloudbase_msl_m: d.site ? d.site.cloudbase_msl_m : null,
    cu_potential: d.site ? d.site.cu_potential : null,
    od_potential: d.site ? d.site.od_potential : null,
    surface_temp_c: d.site ? d.site.surface_temp_c : null,
    dewpoint_2m_c: d.site ? d.site.dewpoint_2m_c : null,
    rh_2m_pct: d.site ? d.site.rh_2m_pct : null,
    surface_wind_ms: d.site ? d.site.surface_wind_speed_ms : null,
    surface_wind_dir_deg: d.site ? d.site.surface_wind_dir_deg : null,
    wind_850_speed_ms: d.site ? d.site.wind_850_speed_ms : null,
    wind_850_dir_deg: d.site ? d.site.wind_850_dir_deg : null,
    shear_surface_925_ms: d.site ? d.site.shear_surface_925_ms : null
  };
}

function parseDwdStation(dwdSt) {
  if (!dwdSt || !dwdSt.ok || !dwdSt.data) return null;
  const data = dwdSt.data;
  const stationId = Object.keys(data)[0];
  if (!stationId) return null;
  const s = data[stationId];
  const days = (s.days || []).map(d => ({
    date: d.dayDate,
    temp_min_c: d.temperatureMin != null ? d.temperatureMin / 10 : null,
    temp_max_c: d.temperatureMax != null ? d.temperatureMax / 10 : null,
    precip_mm: d.precipitation,
    wind_speed_kmh: d.windSpeed,
    wind_gust_kmh: d.windGust,
    wind_dir_deg: d.windDirection,
    sunshine_min: d.sunshine,
    icon: d.icon
  }));
  const fc1 = s.forecast1 || {};
  return {
    station_id: stationId,
    days,
    hourly_temp: fc1.temperature ? fc1.temperature.map(t => t / 10) : null,
    hourly_pressure: fc1.surfacePressure ? fc1.surfacePressure.map(p => p / 10) : null,
    hourly_humidity: fc1.humidity ? fc1.humidity.map(h => h / 10) : null
  };
}
