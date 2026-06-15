// Source adapters. Each returns parsed data or { ok:false, error } — never throws.
// Only sources that may be redistributed (CC-BY / DWD GeoNutzV) are pulled here.
// The DWD "Fliegerprognose / Luftsportbericht" is NOT fetched: its terms forbid
// re-processing / embedding / redistribution. It is offered as a link only.

const UA = { headers: { 'User-Agent': 'feggendorf-briefing/1.0 (personal flight prep)' } };

async function getJSON(url) {
  const r = await fetch(url, UA);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

// ---- Paraglidable (AI flyability, server-side key) ----
export async function fetchParaglidable(key) {
  try {
    if (!key) return { ok: false, error: 'no PARAGLIDABLE_KEY set' };
    const data = await getJSON(`https://api.paraglidable.com/?key=${encodeURIComponent(key)}&format=JSON`);
    return { ok: true, data };
  } catch (e) { return { ok: false, error: String(e) }; }
}

// ---- Open-Meteo: rich hourly from DWD ICON (best_match) ----
const HOURLY = [
  'wind_speed_10m','wind_gusts_10m','wind_direction_10m',
  'wind_speed_850hPa','wind_direction_850hPa','wind_speed_700hPa',
  'cloud_cover','cloud_cover_low','cloud_cover_mid','cloud_cover_high',
  'precipitation_probability','cape','convective_inhibition','boundary_layer_height',
  'freezing_level_height','shortwave_radiation','sunshine_duration','temperature_2m','dew_point_2m'
].join(',');

export async function fetchOpenMeteo(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
      + `&hourly=${HOURLY}&wind_speed_unit=kmh&timezone=Europe%2FBerlin&forecast_days=10`;
    return { ok: true, data: await getJSON(url) };
  } catch (e) { return { ok: false, error: String(e) }; }
}

// ---- Open-Meteo multi-model: cheap daily call for a confidence/agreement signal ----
export async function fetchOpenMeteoMulti(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
      + `&daily=wind_gusts_10m_max,precipitation_sum&wind_speed_unit=kmh`
      + `&models=icon_seamless,ecmwf_ifs025,gfs_seamless&timezone=Europe%2FBerlin&forecast_days=10`;
    return { ok: true, data: await getJSON(url) };
  } catch (e) { return { ok: false, error: String(e) }; }
}

// ---- Bright Sky: DWD official warnings (GeoNutzV open data) ----
export async function fetchDwdAlerts(lat, lon) {
  try { return { ok: true, data: await getJSON(`https://api.brightsky.dev/alerts?lat=${lat}&lon=${lon}`) }; }
  catch (e) { return { ok: false, error: String(e) }; }
}

// ---- Bright Sky: nearest DWD station current obs (real measurement) ----
export async function fetchDwdCurrent(lat, lon) {
  try { return { ok: true, data: await getJSON(`https://api.brightsky.dev/current_weather?lat=${lat}&lon=${lon}`) }; }
  catch (e) { return { ok: false, error: String(e) }; }
}
