/* Feggendorf flight-briefing frontend.
   Consumes /api/briefing (backend). Falls back to direct calls if no backend. */

const GLOSSARY = {
  fly:        ['fly', 'Paraglidable-KI: Wahrscheinlichkeit, dass an dem Tag überhaupt geflogen/gemeldet wird (0–100%). Quelle: Paraglidable API.'],
  xc:         ['XC', 'Wahrscheinlichkeit für einen 60+-Punkte-Streckenflug (PWC-Wertung). An Schleppgeländen meist niedrig. Quelle: Paraglidable API.'],
  verdict:    ['Verdict', 'Gesamteinschätzung aus fly plus Wind/Böen/Thermik.'],
  avgWind:    ['Ø Bodenwind', 'Mittlerer Wind in 10 m über das Fenster 9–20 h. Fürs Schleppen brauchst du stetigen Gegenwind. Quelle: DWD ICON via Open-Meteo.'],
  maxGust:    ['Max Böe (km/h)', 'Stärkste Böe im Tagesfenster — der kritische Wert beim Windenschlepp. >32 km/h = böig, >40 km/h = kritisch. Quelle: DWD ICON via Open-Meteo.'],
  gustFactor: ['Böenfaktor', 'Böe geteilt durch Mittelwind. Über ~1,8 wird es böig und ruppig.'],
  upper850:   ['Höhenwind 850 hPa', 'Wind auf 850 hPa (~1500 m). Zeigt Oberwind und Drift der Thermik. Quelle: DWD ICON via Open-Meteo.'],
  shear:      ['Scherung (km/h)', 'Windunterschied Boden↔850 hPa. Hoch (>20) = Scherung/Turbulenz möglich.'],
  blh:        ['Thermikobergrenze (m)', 'Grenzschichthöhe ≈ wie hoch die Thermik trägt. Quelle: DWD ICON via Open-Meteo.'],
  cloudbase:  ['Wolkenbasis (m AGL)', 'Geschätzte Basis aus Spread Temp/Taupunkt, in m über Grund. Berechnung aus ICON-Daten.'],
  sun:        ['Sonnenstunden', 'Sonne im Fenster 9–20 h — Antrieb für die Thermik. Quelle: DWD ICON via Open-Meteo.'],
  rad:        ['Einstrahlung (W/m²)', 'Maximale Globalstrahlung (W/m²) — Energie für Thermik. Quelle: DWD ICON via Open-Meteo.'],
  cape:       ['CAPE (J/kg)', 'Labilität. Hoch (>800) = Schauer/Gewitter möglich. Quelle: DWD ICON via Open-Meteo.'],
  cin:        ['CIN (J/kg)', 'Deckel, der Thermik bremst. Stark negativ = Auslöse schwer. Quelle: DWD ICON via Open-Meteo.'],
  cloud:      ['Bewölkung (%)', 'Mittlere Gesamtbewölkung; Klammer = tief/mittel/hoch. Quelle: DWD ICON via Open-Meteo.'],
  precip:     ['Regen (%)', 'Maximale Niederschlagswahrscheinlichkeit im Fenster. Quelle: DWD ICON via Open-Meteo.'],
  dir:        ['Windrichtung', 'Pfeile zeigen die Schlepprichtung, also wohin der Wind weht. Schirm in Pfeilrichtung ausrichten.'],
  confidence: ['Konfidenz', 'Stimmen ICON, ECMWF und GFS überein? Übereinstimmung = verlässlicher. Quelle: Open-Meteo Multi-Modell.'],
  warning:    ['DWD-Warnung', 'Amtliche Unwetterwarnung des DWD (über Bright Sky API).'],
  crosswind:  ['Querwind (Crosswind)', 'Windkomponente quer zur Schlepprichtung O/W (90°/270°). ≤15 km/h = ok für Start · >15 km/h = aufpassen · >25 km/h = kritisch. Berechnung: ws·|sin(wd−90°)|.'],
  headwind:   ['Längswind', 'Windkomponente entlang der Schlepprichtung. Positiv (Gegenwind) = ideal für Schlepp in der angezeigten Richtung. Negativ = Rückenwind. Berechnung: ws·cos(wd−90°).']
};

/* embedded Paraglidable snapshot — only used in fallback (no backend). */
const PG_SNAPSHOT = {
 "2026-06-15":{fly:0.2118,XC:0.0039},"2026-06-16":{fly:0.6314,XC:0.0078},
 "2026-06-17":{fly:0.6392,XC:0.0078},"2026-06-18":{fly:0.8588,XC:0.0275},
 "2026-06-19":{fly:0.8588,XC:0.102 },"2026-06-20":{fly:0.7333,XC:0.1373},
 "2026-06-21":{fly:0.9059,XC:0.1725},"2026-06-22":{fly:0.9333,XC:0.1882},
 "2026-06-23":{fly:0.4667,XC:0.0353},"2026-06-24":{fly:0.9137,XC:0.0275}
};

const DOW = ['So','Mo','Di','Mi','Do','Fr','Sa'];
const MON = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez'];
const $ = id => document.getElementById(id);
let B = null, selected = null, mode = 'day';
const todayISO = new Date().toISOString().slice(0,10);

function flyColor(f){if(f==null)return'#44617C';if(f>=0.85)return'#EF8A4C';if(f>=0.72)return'#E3B24A';if(f>=0.60)return'#8FB95C';if(f>=0.45)return'#4FA47F';if(f>=0.30)return'#3E8E9A';return'#44617C';}
function subText(level){return['Geringe Flugwahrscheinlichkeit für die lokale Szene.','Eher zäh — nur mit gutem Stundenfenster.','Geht wahrscheinlich — hängt am Detail. Wind & Böen unten entscheiden.','Gute Chancen. Auf Böen und Tagesfenster achten.','Klar fliegbare Bedingungen. Stundenfenster prüfen.'][level] ?? '';}
function card16(d){return['N','NNO','NO','ONO','O','OSO','SO','SSO','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(d/22.5)%16];}
function compress(hs){if(!hs.length)return[];const o=[];let s=hs[0],p=hs[0];for(let i=1;i<hs.length;i++){if(hs[i]===p+1)p=hs[i];else{o.push(s===p?`${s}h`:`${s}-${p+1}h`);s=p=hs[i];}}o.push(s===p?`${s}h`:`${s}-${p+1}h`);return o;}

/* ---------- tooltip ---------- */
const tip = $('tip');
function showTip(el){
  const k = el.getAttribute('data-tip'); const g = GLOSSARY[k]; if(!g) return;
  tip.innerHTML = `<b>${g[0]}</b>${g[1]}`;
  const r = el.getBoundingClientRect();
  tip.style.left = Math.min(r.left, window.innerWidth-280) + 'px';
  tip.style.top = (r.bottom + 8) + 'px';
  tip.classList.add('on');
}
function hideTip(){ tip.classList.remove('on'); }
document.addEventListener('mouseover', e=>{const el=e.target.closest('[data-tip]'); if(el) showTip(el);});
document.addEventListener('mouseout', e=>{if(e.target.closest('[data-tip]')) hideTip();});
document.addEventListener('focusin', e=>{const el=e.target.closest('[data-tip]'); if(el) showTip(el);});
document.addEventListener('focusout', hideTip);

/* ---------- load ---------- */
async function load(){
  try {
    const r = await fetch('/api/briefing');
    if (!r.ok) throw new Error('no backend');
    B = await r.json();
    $('wsrc').textContent = 'Backend · ' + new Date(B.generated_at).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
  } catch (e) {
    B = await buildFallback();
    $('wsrc').textContent = 'Direktabruf (kein Backend) · ' + new Date().toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
  }
  render();
}

/* fallback: assemble a briefing-shaped object client-side */
async function buildFallback(){
  const lat=52.29384, lon=9.37743;
  const HOURLY=['wind_speed_10m','wind_gusts_10m','wind_direction_10m','wind_speed_850hPa','wind_direction_850hPa','wind_speed_700hPa','cloud_cover','cloud_cover_low','cloud_cover_mid','cloud_cover_high','precipitation_probability','cape','convective_inhibition','boundary_layer_height','freezing_level_height','shortwave_radiation','sunshine_duration','temperature_2m','dew_point_2m'];
  let hourly=null, alerts=[], current=null;
  try{ const j=await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${HOURLY.join(',')}&wind_speed_unit=kmh&timezone=Europe%2FBerlin&forecast_days=10`)).json(); hourly=j.hourly; }catch(e){}
  try{ const j=await (await fetch(`https://api.brightsky.dev/alerts?lat=${lat}&lon=${lon}`)).json(); alerts=(j.alerts||[]).map(x=>({event:x.event_de||x.event,severity:x.severity,headline:x.headline_de||x.headline})); }catch(e){}
  try{ const j=await (await fetch(`https://api.brightsky.dev/current_weather?lat=${lat}&lon=${lon}`)).json(); const w=j.weather,s=j.sources&&j.sources[0]; current={station:s?s.station_name:null,timestamp:w.timestamp,temperature_c:w.temperature,wind_kmh:w.wind_speed,wind_gust_kmh:w.wind_gust_speed,wind_dir_deg:w.wind_direction}; }catch(e){}
  return {
    generated_at:new Date().toISOString(),
    site:{name:'Deisterflieger Feggendorf',lat,lon,type:'winch',region:'EDZH'},
    days: clientAggregate(hourly, PG_SNAPSHOT),
    hourly, dwd_warnings:alerts, dwd_current:current,
    links:{dwd_fliegerprognose:'https://www.dwd.de/DE/fachnutzer/luftfahrt/teaser/luftsportberichte/fbeu40_edzh_node.html',dwd_region:'EDZH'},
    attribution:'Open-Meteo (CC-BY 4.0) · DWD (GeoNutzV, via Bright Sky) · Paraglidable'
  };
}
function clientAggregate(hourly, pg){
  if(!hourly) return Object.keys(pg).sort().map(date=>({date,weekday:DOW[new Date(date+'T12:00').getDay()],paraglidable:pg[date],verdict:vd(pg[date].fly),wind:{},thermal:{},sky:{},best_window:[],flags:[],confidence:{models_agree:null}}));
  const days={},t=hourly.time,g=(k,i)=>hourly[k]?hourly[k][i]:null;
  for(let i=0;i<t.length;i++){const date=t[i].slice(0,10),h=+t[i].slice(11,13);(days[date]||=[]).push({h,ws:g('wind_speed_10m',i),wg:g('wind_gusts_10m',i),wd:g('wind_direction_10m',i),ws850:g('wind_speed_850hPa',i),wd850:g('wind_direction_850hPa',i),cc:g('cloud_cover',i),ccl:g('cloud_cover_low',i),ccm:g('cloud_cover_mid',i),cch:g('cloud_cover_high',i),pp:g('precipitation_probability',i),cape:g('cape',i),cin:g('convective_inhibition',i),blh:g('boundary_layer_height',i),rad:g('shortwave_radiation',i),sun:g('sunshine_duration',i),t2:g('temperature_2m',i),td:g('dew_point_2m',i)});}
  return Object.keys(days).sort().map(date=>{
    const win=days[date].filter(x=>x.h>=9&&x.h<=20),mx=k=>Math.max(...win.map(x=>x[k]||0));
    const avgW=win.reduce((a,x)=>a+(x.ws||0),0)/win.length,maxG=mx('wg'),maxGh=(win.find(x=>x.wg===maxG)||{}).h;
    const mid=win.find(x=>x.h===14)||win[Math.floor(win.length/2)];
    const sun=win.reduce((a,x)=>a+(x.sun||0),0)/3600;
    const base=mid&&mid.t2!=null?Math.max(0,Math.round(122*(mid.t2-mid.td))):null;
    const shear=mid?Math.abs((mid.ws850||0)-(mid.ws||0)):null;
    const flags=[];if(maxG>40)flags.push('gusts_high');else if(maxG>32)flags.push('gusts');if(shear>20)flags.push('shear');if(mx('pp')>=40)flags.push('rain');if(mx('cape')>=800)flags.push('cb');
    const pgd=pg[date]||{fly:null,XC:null};
    return {date,weekday:DOW[new Date(date+'T12:00').getDay()],paraglidable:{fly:pgd.fly,xc:pgd.XC??pgd.xc},verdict:vd(pgd.fly),
      wind:{avg_kmh:r1(avgW),max_gust_kmh:r1(maxG),max_gust_hour:maxGh,gust_factor:r1(maxG/Math.max(1,avgW)),dir_deg_14:mid?Math.round(mid.wd):null,dir_card_14:mid?card16(mid.wd):null,upper_850_kmh:mid?r1(mid.ws850):null,upper_850_card:mid?card16(mid.wd850):null,shear_kmh:shear!=null?r1(shear):null},
      thermal:{blh_max_m:Math.round(mx('blh')),cloud_base_m:base,sun_hours:r1(sun),rad_max_wm2:Math.round(mx('rad')),cape_max:Math.round(mx('cape')),cin_14:mid&&mid.cin!=null?Math.round(mid.cin):null},
      sky:{cloud_avg_pct:Math.round(win.reduce((a,x)=>a+(x.cc||0),0)/win.length),cloud_low:mid?mid.ccl:null,cloud_mid:mid?mid.ccm:null,cloud_high:mid?mid.cch:null,precip_prob_max:mx('pp')},
      best_window:compress(win.filter(x=>{if(x.wg>30||x.ws<6||x.ws>28||(x.pp||0)>=30)return false;if(x.wd==null)return true;const a=(x.wd-90)*Math.PI/180;return Math.abs((x.ws||0)*Math.sin(a))<=15&&(x.ws||0)*Math.cos(a)>=-15;}).map(x=>x.h)),
      flags,confidence:{models_agree:null,note:'—'}};
  });
}
function vd(f){if(f==null)return{level:null,label:'—'};if(f>=0.85)return{level:4,label:'Top-Tag'};if(f>=0.72)return{level:3,label:'Guter Tag'};if(f>=0.55)return{level:2,label:'Möglich'};if(f>=0.40)return{level:1,label:'Grenzwertig'};return{level:0,label:'Bleib unten'};}
const r1=x=>(x==null||isNaN(x))?null:Math.round(x*10)/10;

/* ---------- render ---------- */
function render(){
  $('site').textContent=B.site.name;
  $('coords').textContent=B.site.lat.toFixed(3)+', '+B.site.lon.toFixed(3);
  renderSourcesBar(); renderAlerts(); renderNow(); renderRibbon(); renderDwdLink(); renderFooter();
  if (!B.days || !B.days.length) { $('ribbon').innerHTML = '<div class=\"alert\">Keine Tagesdaten verfügbar — Open-Meteo ist evtl. im Rate-Limit.</div>'; return; }
  selected = B.days.find(d=>d.date===todayISO)?.date || B.days[0].date;
  setMode('day'); select(selected);
}

/* ---------- sources status bar (NEU) ---------- */
function renderSourcesBar(){
  const bar = $('sourcesbar');
  const sources = [
    {name: 'Paraglidable', ok: B.days && B.days.length && B.days[0].paraglidable && B.days[0].paraglidable.fly != null},
    {name: 'Open-Meteo', ok: B.hourly && B.hourly.time && B.hourly.time.length > 0},
    {name: 'DWD Alerts', ok: B.dwd_warnings !== undefined},
    {name: 'DWD Current', ok: B.dwd_current && B.dwd_current.temperature_c != null},
    {name: 'DWD Station', ok: B.dwd_station && B.dwd_station.days && B.dwd_station.days.length > 0},
    {name: 'Convek', ok: B.convek && B.convek.day_rating != null},
    {name: 'Multi-Modell', ok: B.days && B.days[0] && B.days[0].confidence && B.days[0].confidence.models != null}
  ];
  bar.innerHTML = sources.map(s => {
    const cls = s.ok ? 'ok' : 'error';
    return `<span class="source-chip ${cls}"><span class="dot"></span>${s.name}</span>`;
  }).join('');
}

function renderAlerts(){
  const box=$('alertbar');
  if(!B.dwd_warnings||!B.dwd_warnings.length){box.innerHTML='';return;}
  box.innerHTML=B.dwd_warnings.slice(0,4).map(a=>`<div class="alert" data-tip="warning"><span class="ev">${a.event||'Warnung'}</span><span>${a.headline||''}</span></div>`).join('');
}
function renderNow(){
  const c=B.dwd_current,s=$('nowstrip');
  if(!c){s.innerHTML='';return;}
  s.innerHTML=`<span>Jetzt (DWD ${c.station||'Station'}):</span>
    <span><b>${c.temperature_c!=null?c.temperature_c.toFixed(0)+'°C':'–'}</b></span>
    <span data-tip="dir">Wind <b>${c.wind_kmh!=null?Math.round(c.wind_kmh):'–'} km/h</b>${c.wind_dir_deg!=null?' '+card16(c.wind_dir_deg):''}</span>
    <span data-tip="maxGust">Böe <b>${c.wind_gust_kmh!=null?Math.round(c.wind_gust_kmh):'–'} km/h</b></span>`;
}
function renderRibbon(){
  const rib=$('ribbon'); rib.innerHTML='';
  B.days.forEach(d=>{
    const f=d.paraglidable.fly,xc=d.paraglidable.xc,c=flyColor(f),dt=new Date(d.date+'T12:00');
    const conf=d.confidence&&d.confidence.models_agree;
    const dot=conf===true?'#4FA47F':conf===false?'#EF8A4C':'transparent';
    const el=document.createElement('button');
    el.className='cell'+(d.date===todayISO?' today':'');
    el.style.setProperty('--cellc',c); el.dataset.date=d.date;
    el.setAttribute('aria-label',`${d.weekday} ${dt.getDate()}. ${MON[dt.getMonth()]}, fly ${f!=null?Math.round(f*100):'–'} Prozent`);
    el.innerHTML=`<span class="conf-dot" style="background:${dot}" ${conf!=null?'data-tip="confidence"':''}></span>
      <div class="dow">${d.weekday}</div><div class="dom">${dt.getDate()}.${dt.getMonth()+1}.</div>
      <div class="fly" style="color:${c}">${f!=null?Math.round(f*100):'–'}</div>
      <div class="xc">XC <span>${xc!=null?Math.round(xc*100):'–'}%</span></div>`;
    el.onclick=()=>{select(d.date);if(mode!=='day')setMode('day');};
    rib.appendChild(el);
  });
}
function renderDwdLink(){
  const l=B.links&&B.links.dwd_fliegerprognose;if(!l){$('dwdlink').innerHTML='';return;}
  $('dwdlink').innerHTML=`<a href="${l}" target="_blank" rel="noopener">DWD-Luftsportbericht ${B.links.dwd_region||''} öffnen ↗</a>
    <span class="note">Offizielle DWD-Fliegerprognose — zur persönlichen Flugvorbereitung selbst öffnen. (DWD-Nutzungsbedingungen: kein Einbinden/Weitergeben, daher nur Link.)</span>`;
}
function renderFooter(){
  $('footer').innerHTML=`<strong>Schichtung:</strong> Paraglidable (täglich) = welcher Tag · Open-Meteo ICON (stündlich, live) = welche Stunden + warum · DWD via Bright Sky = Warnungen + Messwerte.
    Im Hermes-Agent: <code>GET /api/briefing</code> liefert dieses JSON; Paraglidable-Key bleibt server-seitig.
    Kein Go/No-Go — Freigabe trifft Pilot + Flugleiter.<br><span style="color:var(--ink-faint)">${B.attribution||''}</span>`;
}

function setMode(m){
  mode=m;
  $('btnDay').setAttribute('aria-pressed',m==='day'); $('btnWeek').setAttribute('aria-pressed',m==='week');
  $('btnWindy').setAttribute('aria-pressed',m==='windy'); $('btnBurnair').setAttribute('aria-pressed',m==='burnair');
  $('dayview').classList.toggle('hidden',m!=='day');
  $('weekview').classList.toggle('hidden',m!=='week');
  $('windyview').classList.toggle('hidden',m!=='windy');
  $('burnairview').classList.toggle('hidden',m!=='burnair');
  $('modelcompare').classList.toggle('hidden',m==='windy'||m==='burnair');
  $('convsection').classList.toggle('hidden',m==='windy'||m==='burnair');
  $('selNote').textContent=m==='day'?'Tagesansicht':m==='week'?'Wochenansicht':m==='windy'?'Windy.com':m==='burnair'?'burnair.cloud':'';
  if(m==='week') renderWeek();
  if(m==='windy') loadWindy();
  if(m==='burnair') loadBurnair();
}
$('btnDay').onclick=()=>setMode('day');
$('btnWeek').onclick=()=>setMode('week');
$('btnWindy').onclick=()=>setMode('windy');
$('btnBurnair').onclick=()=>setMode('burnair');

function select(date){
  selected=date;
  [...$('ribbon').children].forEach(c=>c.classList.toggle('sel',c.dataset.date===date));
  const d=B.days.find(x=>x.date===date); if(!d) return;
  const f=d.paraglidable.fly,c=flyColor(f),dt=new Date(date+'T12:00');
  const vl=$('vlabel');vl.textContent=d.verdict.label;vl.style.color=c;vl.setAttribute('data-tip','verdict');
  const vf=$('vfly');vf.textContent=f!=null?Math.round(f*100)+'%':'–';vf.style.color=c;
  $('vsub').innerHTML=`<b>${d.weekday}, ${dt.getDate()}. ${MON[dt.getMonth()]}</b> — ${subText(d.verdict.level)} · XC ${d.paraglidable.xc!=null?Math.round(d.paraglidable.xc*100):'–'}%`;
  if(mode==='day') renderDay(d);
  renderWindRose(d);
  renderCloudLayers(d);
  renderModelComparison(d);
  renderConvekSection();
  renderDwdStation();
}

function renderConvekSection() {
  var cvk = B.convek;
  var cvb = document.getElementById('convbody');
  if (!cvk) { cvb.innerHTML = ''; return; }
  var rat = cvk.day_rating || '–';
  var rlabel = rat === 'excellent' ? '🔥 Exzellent' : rat === 'good' ? '✅ Gut' : rat === 'fair' ? '👍 Ordentlich' : rat === 'marginal' ? '⚠️ Grenzwertig' : rat === 'poor' ? '❌ Schwach' : rat;
  var wstar = cvk.wstar_ms;
  var wstarTxt = wstar != null ? (wstar < 0.5 ? 'Keine' : wstar < 1.5 ? 'Schwach (' + wstar.toFixed(1) + ' m/s)' : wstar < 2.5 ? 'Mittel (' + wstar.toFixed(1) + ' m/s)' : 'Stark (' + wstar.toFixed(1) + ' m/s)') : '–';
  var cb = cvk.cloudbase_agl_ft ? Math.round(cvk.cloudbase_agl_ft * 0.3048) + ' m AGL' : '–';
  var cu = cvk.cu_potential ? '✅ Ja' : '—';
  var od = cvk.od_potential ? '⚠️ Ja' : '—';
  var sfcWind = cvk.surface_wind_ms ? Math.round(cvk.surface_wind_ms * 3.6) : null;
  var sfcDir = cvk.surface_wind_dir_deg ? Math.round(cvk.surface_wind_dir_deg) : null;
  var w850 = cvk.wind_850_speed_ms ? Math.round(cvk.wind_850_speed_ms * 3.6) : null;
  cvb.innerHTML = '<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">' +
    '<div style="flex:none"><span style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280">Convek Soaring</span>' +
    '<div style="font-size:28px;font-weight:700;margin-top:2px;color:#1f2937">' + rlabel + '</div>' +
    '<div style="font-size:10px;color:#6b7280;margin-top:2px">Tages-Rating</div></div>' +
    '<div style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:6px 18px;font-size:13px">' +
    '<span style="color:#6b7280">Thermik (w*)</span><span style="color:#1f2937">' + wstarTxt + '</span>' +
    '<span style="color:#6b7280">Wolkenbasis</span><span style="color:#1f2937">' + cb + '</span>' +
    '<span style="color:#6b7280">Cu-Potenzial</span><span style="color:#1f2937">' + cu + '</span>' +
    '<span style="color:#6b7280">Überentw.</span><span style="color:#1f2937">' + od + '</span>' +
    (sfcWind != null ? '<span style="color:#6b7280">Bodenwind</span><span style="color:#1f2937">' + sfcWind + ' km/h ' + (sfcDir ? card16(sfcDir) : '') + '</span>' : '') +
    (w850 != null ? '<span style="color:#6b7280">Wind 850hPa</span><span style="color:#1f2937">' + w850 + ' km/h</span>' : '') +
    '</div></div>';
}

function renderDwdStation() {
  var ds = B.dwd_station;
  if (!ds || !ds.days || !ds.days.length) return;
  // Add 10-day temp trend as a small line to the Convek card
  var cvb = document.getElementById('convbody');
  if (!cvb.innerHTML) return;
  var temps = ds.days.map(function(d){return d.temp_max_c;}).filter(function(x){return x!=null;});
  if (temps.length < 3) return;
  var tmin = Math.min.apply(null,temps), tmax = Math.max.apply(null,temps), trange = tmax-tmin || 1;
  var W = temps.length * 32, H = 36;
  var pts = temps.map(function(t,i){return (i*32+8).toFixed(0)+','+(H-4-((t-tmin)/trange)*(H-12)).toFixed(0);}).join(' ');
  var svg = '<svg width="' + W + '" height="' + H + '" style="vertical-align:middle"><polyline points="' + pts + '" fill="none" stroke="#f97316" stroke-width="1.8"/></svg>';
  var today = ds.days[0];
  cvb.innerHTML += '<div style="margin-top:10px;font-size:11px;color:#6b7280">DWD Station 10d: ' +
    'Tmin <b style="color:#1f2937">' + (today.temp_min_c||'–') + '°</b> / Tmax <b style="color:#1f2937">' + (today.temp_max_c||'–') + '°C</b> ' + svg +
    ' · Druck <b style="color:#1f2937">' + (ds.hourly_pressure ? ds.hourly_pressure[14] : '–') + ' hPa</b></div>';
}

/* ---------- burnair ---------- */
function loadBurnair() {
  var f = document.getElementById('burnairframe');
  if (f.src.indexOf('burnair.cloud') >= 0) return;
  f.src = 'https://www.burnair.cloud/?lat=52.294&lon=9.377&zoom=10';
}

function hoursFor(date){
  if(!B.hourly) return null;
  const t=B.hourly.time,out=[];
  const g=(k,i)=>B.hourly[k]?B.hourly[k][i]:null;
  for(let i=0;i<t.length;i++) if(t[i].slice(0,10)===date) out.push({
    h:+t[i].slice(11,13),
    ws:g('wind_speed_10m',i), wg:g('wind_gusts_10m',i), wd:g('wind_direction_10m',i),
    ws850:g('wind_speed_850hPa',i),
    cc:g('cloud_cover',i), ccl:g('cloud_cover_low',i), ccm:g('cloud_cover_mid',i), cch:g('cloud_cover_high',i),
    pp:g('precipitation_probability',i), cape:g('cape',i), cin:g('convective_inhibition',i),
    blh:g('boundary_layer_height',i), t2:g('temperature_2m',i), td:g('dew_point_2m',i)
  });
  return out.length?out:null;
}

function renderDay(d){
  const wbody=$('wbody'),tbody=$('tbody'),hrs=hoursFor(d.date);
  $('tsrc').textContent='DWD ICON · '+(B.hourly?'19 Variablen':'—');
  if(!hrs){wbody.innerHTML='<div class="errbox">Für diesen Tag keine Stundendaten (Modellreichweite).</div>';tbody.innerHTML='';return;}
  const W=560,H=200,padL=30,padR=12,padT=14,padB=42,x0=6,x1=21;
  const X=h=>padL+(h-x0)/(x1-x0)*(W-padL-padR);
  const ymax=Math.max(40,Math.ceil(Math.max(...hrs.map(h=>Math.max(h.wg,h.ws850||0)))/5)*5);
  const Y=v=>padT+(1-v/ymax)*(H-padT-padB);
  const seg=hrs.filter(h=>h.h>=x0&&h.h<=x1);
  const P=k=>seg.map(h=>`${X(h.h).toFixed(1)},${Y(h[k]||0).toFixed(1)}`).join(' ');
  const area=`${X(seg[0].h)},${Y(0)} ${P('ws')} ${X(seg[seg.length-1].h)},${Y(0)}`;
  let gridY='';for(let v=0;v<=ymax;v+=10)gridY+=`<line x1="${padL}" y1="${Y(v)}" x2="${W-padR}" y2="${Y(v)}" stroke="#e8eaed"/><text x="${padL-5}" y="${Y(v)+3}" fill="#6b7280" font-size="9" text-anchor="end">${v}</text>`;
  let xlab='';for(let h=x0;h<=x1;h+=3)xlab+=`<text x="${X(h)}" y="${H-padB+16}" fill="#6b7280" font-size="9" text-anchor="middle">${h}</text>`;
  let dirs='';for(let h=x0;h<=x1;h+=3){const hh=seg.find(s=>s.h===h);if(hh)dirs+=`<g transform="translate(${X(h)},${H-10}) rotate(${hh.wd+180})"><line x1="0" y1="5" x2="0" y2="-5" stroke="#6b7280" stroke-width="1.4"/><path d="M0,-5 L-2.5,-1 M0,-5 L2.5,-1" stroke="#6b7280" stroke-width="1.4" fill="none"/></g>`;}
  const w=d.wind,th=d.thermal,sk=d.sky;

  wbody.innerHTML=`
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Wind, Böen, Höhenwind">
      <rect x="${padL}" y="${Y(25)}" width="${W-padL-padR}" height="${Y(8)-Y(25)}" fill="#10b981" opacity="0.08"/>
      <text x="${W-padR}" y="${Y(25)-3}" fill="#10b981" font-size="9" text-anchor="end" opacity=".8">Bodenwind ideal 8–25</text>
      ${gridY}${xlab}
      <polygon points="${area}" fill="#0ea5e9" opacity="0.08"/>
      <polyline points="${P('ws850')}" fill="none" stroke="#8b5cf6" stroke-width="1.5"/>
      <polyline points="${P('wg')}" fill="none" stroke="#f97316" stroke-width="1.6" stroke-dasharray="3 3"/>
      <polyline points="${P('ws')}" fill="none" stroke="#0ea5e9" stroke-width="2.2"/>
      ${dirs}
    </svg>
    <div class="chips" style="margin-bottom:4px">
      <span class="chip" style="border-color:#0ea5e9;color:#0ea5e9" data-tip="avgWind">Bodenwind 10m</span>
      <span class="chip" style="border-color:#f97316;color:#f97316" data-tip="maxGust">Böen</span>
      <span class="chip" style="border-color:#8b5cf6;color:#8b5cf6" data-tip="upper850">Höhenwind 850</span>
    </div>
    <div class="stat-row">
      <div class="stat"><span class="k" data-tip="avgWind">Ø Bodenwind</span><span class="v">${fmt(w.avg_kmh)} <small>km/h</small></span></div>
      <div class="stat"><span class="k" data-tip="maxGust">Max Böe</span><span class="v" style="color:${w.max_gust_kmh>35?'#f97316':'inherit'}">${fmt(w.max_gust_kmh)} <small>km/h · ${w.max_gust_hour??'–'}h</small></span></div>
      <div class="stat"><span class="k" data-tip="gustFactor">Böenfaktor</span><span class="v">${fmt(w.gust_factor)}×</span></div>
      <div class="stat"><span class="k" data-tip="shear">850 · Scherung</span><span class="v">${fmt(w.upper_850_kmh)} <small>km/h · Δ${fmt(w.shear_kmh)}</small></span></div>
    </div>
    <div class="compass">${w.dir_deg_14!=null?arrow(w.dir_deg_14):''}
      <div data-tip="dir" style="font-size:13px;color:#4b5563">Windrichtung 14h: <b style="color:#1f2937">${w.dir_deg_14??'–'}° ${w.dir_card_14||''}</b><br><span style="color:#6b7280;font-size:12px">in Schlepprichtung ausrichten</span></div>
    </div>
    ${w.crosswind_kmh!=null?`<div class="schlepp-row" data-tip="crosswind">
      <span class="schlepp-label">Schlepp (O/W):</span>
      <span class="schlepp-val">${fmt(Math.abs(w.headwind_kmh))} km/h Längs</span>
      <span class="schlepp-sep">·</span>
      <span class="schlepp-val schlepp-cw" style="color:${w.crosswind_kmh>25?'#ef4444':w.crosswind_kmh>15?'#f59e0b':'#10b981'}" data-tip="crosswind">${fmt(w.crosswind_kmh)} km/h Quer</span>
      <span class="schlepp-dir">(${w.ideal_dir||'–'})</span>
    </div>`:''}`;

  const warns=[];
  if(d.flags.includes('gusts_high'))warns.push(['bad',`Böen bis ${fmt(w.max_gust_kmh)} km/h — kritisch für den Schlepp.`]);
  else if(d.flags.includes('gusts'))warns.push(['','Böig — Böenfaktor und Startfenster prüfen.']);
  if(d.flags.includes('shear'))warns.push(['',`Windscherung (Δ${fmt(w.shear_kmh)} km/h) — Turbulenz möglich.`]);
  if(d.flags.includes('rain'))warns.push(['bad',`Niederschlag wahrscheinlich (bis ${sk.precip_prob_max}%).`]);
  if(d.flags.includes('cb'))warns.push(['bad',`CB-/Gewitterpotenzial — CAPE bis ${th.cape_max} J/kg.`]);
  else if(d.flags.includes('unstable'))warns.push(['',`Labile Schichtung (CAPE ${th.cape_max}) — Überentwicklung beobachten.`]);
  if(d.flags.includes('crosswind_high'))warns.push(['bad',`Starker Querwind (${fmt(w.crosswind_kmh)} km/h) — Schlepp kritisch.`]);
  else if(d.flags.includes('crosswind'))warns.push(['',`Querwind (${fmt(w.crosswind_kmh)} km/h) — Startfenster mit weniger Quer-Anteil wählen.`]);
  if(d.confidence&&d.confidence.models_agree===false)warns.push(['',`Modelle uneinig (Böen-Streuung ${d.confidence.gust_spread_kmh??'?'} km/h) — niedrigere Verlässlichkeit.`]);
  const ww=document.createElement('div');ww.className='warns';
  ww.innerHTML=warns.map(x=>`<div class="warn-item ${x[0]}"><span class="dot"></span><span>${x[1]}</span></div>`).join('');
  wbody.appendChild(ww);

  tbody.innerHTML=`
    <div class="stat-row">
      <div class="stat"><span class="k" data-tip="blh">Thermikobergr.</span><span class="v">${fmt(th.blh_max_m)} <small>m</small></span></div>
      <div class="stat"><span class="k" data-tip="cloudbase">Wolkenbasis</span><span class="v">${fmt(th.cloud_base_m)} <small>m AGL</small></span></div>
      <div class="stat"><span class="k" data-tip="sun">Sonne</span><span class="v">${fmt(th.sun_hours)}<small>h</small></span></div>
      <div class="stat"><span class="k" data-tip="rad">Einstrahlung</span><span class="v">${fmt(th.rad_max_wm2)}<small>W/m²</small></span></div>
    </div>
    <div class="stat-row">
      <div class="stat"><span class="k" data-tip="cape">CAPE max</span><span class="v">${fmt(th.cape_max)}<small>J/kg</small></span></div>
      <div class="stat"><span class="k" data-tip="cin">CIN 14h</span><span class="v">${fmt(th.cin_14)}<small>J/kg</small></span></div>
      <div class="stat"><span class="k" data-tip="cloud">Bewölkung</span><span class="v">${fmt(sk.cloud_avg_pct)}<small>% (${fmt(sk.cloud_low)}/${fmt(sk.cloud_mid)}/${fmt(sk.cloud_high)})</small></span></div>
    </div>
    <div style="margin-top:14px">
      <div class="stat" style="margin-bottom:6px"><span class="k" data-tip="maxGust">Bestes Stundenfenster</span></div>
      <div class="chips">${d.best_window.length?d.best_window.map(r=>`<span class="chip good">${r}</span>`).join(''):'<span class="chip">kein klares Fenster 9–20h</span>'}</div>
    </div>`;
}

function renderWeek(){
  const tb=$('weekbody');
  tb.innerHTML=B.days.map(d=>{
    const c=flyColor(d.paraglidable.fly),w=d.wind||{},th=d.thermal||{},sk=d.sky||{},dt=new Date(d.date+'T12:00');
    const conf=d.confidence&&d.confidence.models_agree;
    const confTxt=conf===true?'<span style="color:#10b981">einig</span>':conf===false?'<span style="color:#f59e0b">uneinig</span>':'–';
    return `<tr data-date="${d.date}" class="${d.date===todayISO?'today':''}">
      <td><span class="flytag" style="background:${c}">${d.paraglidable.fly!=null?Math.round(d.paraglidable.fly*100):'–'}</span></td>
      <td>${d.paraglidable.xc!=null?Math.round(d.paraglidable.xc*100):'–'}%</td>
      <td>${d.weekday} ${dt.getDate()}.${dt.getMonth()+1}.</td>
      <td>${fmt(w.avg_kmh)}</td>
      <td style="color:${w.max_gust_kmh>35?'#f97316':'inherit'}">${fmt(w.max_gust_kmh)}</td>
      <td>${fmt(th.sun_hours)}h</td>
      <td style="color:${sk.precip_prob_max>=40?'#f97316':'inherit'}">${fmt(sk.precip_prob_max)}%</td>
      <td style="color:${th.cape_max>=800?'#f97316':'inherit'}">${fmt(th.cape_max)}</td>
      <td>${w.upper_850_kmh!=null?fmt(w.upper_850_kmh)+' '+(w.upper_850_card||''):'–'}</td>
      <td>${confTxt}</td>
    </tr>`;
  }).join('');
  [...tb.querySelectorAll('tr')].forEach(tr=>tr.onclick=()=>{select(tr.dataset.date);setMode('day');});
}

const fmt=x=>(x==null||x==='')?'–':x;
function arrow(d){return '<svg class="arrow" viewBox="0 0 40 40" data-tip="dir"><circle cx="20" cy="20" r="18" fill="none" stroke="#d4d9e0"/><g transform="rotate('+(d+180)+' 20 20)"><line x1="20" y1="32" x2="20" y2="8" stroke="#1a56db" stroke-width="2.4"/><path d="M20,8 L15,15 M20,8 L25,15" stroke="#1a56db" stroke-width="2.4" fill="none"/></g><text x="20" y="23" fill="#6b7280" font-size="7" text-anchor="middle">N&#8593;</text></svg>';}

/* ---------- text briefing toggle ---------- */
document.getElementById('btnBriefing').onclick = function() {
  var tb = document.getElementById('textbriefing');
  var bt = document.getElementById('briefingtext');
  if (tb.classList.contains('hidden')) {
    bt.innerHTML = generateBriefing();
    tb.classList.remove('hidden');
    this.textContent = '📋 Schließen';
  } else {
    tb.classList.add('hidden');
    this.textContent = '📋 Briefing';
  }
};

function generateBriefing() {
  if (!B || !B.days || !B.days.length) return 'Keine Daten.';
  var d0 = B.days[0], d1 = B.days[1];
  function f(x) { return (x == null || x === '') ? '–' : x; }
  function pct(x) { return x != null ? Math.round(x * 100) : '–'; }
  function cvkLbl(r) { var m = {poor:'Schwach',marginal:'Grenzwertig',fair:'Ordentlich',good:'Gut',excellent:'Exzellent'}; return m[r] || '–'; }
  function flbl(x) { var m = {gusts:'Böig',gusts_high:'Starkböen',shear:'Scherung',rain:'Regen',cb:'CB-Gefahr',showers:'Schauer',unstable:'Labil',crosswind:'Querwind',crosswind_high:'Starker Querwind'}; return x.map(function(f){return m[f]||f;}).join(', '); }
  var w0 = d0.wind || {}, th0 = d0.thermal || {}, sk0 = d0.sky || {}, conf0 = d0.confidence || {};
  var cvk = B.convek || {}, cur = B.dwd_current || {}, alerts = B.dwd_warnings || [];
  var pg = d0.paraglidable || {};

  // Build the natural-language briefing text
  var txt = '';
  var flyPct = pct(pg.fly);
  var flyLabel = (d0.verdict||{}).label || '–';
  var windDesc = f(w0.avg_kmh) + ' km/h';
  if (w0.dir_card_14) windDesc += ' aus ' + w0.dir_card_14;
  if (w0.max_gust_kmh > 25) windDesc += ', böig mit ' + f(w0.max_gust_kmh) + ' km/h Spitzen';
  else windDesc += ', Böen ' + f(w0.max_gust_kmh) + ' km/h';

  txt += 'Am <b>' + d0.weekday + ', ' + d0.date.split('-')[2] + '.' + d0.date.split('-')[1] + '.</b> zeigt Paraglidable <b>' + flyPct + '% Fly-Wahrscheinlichkeit</b> – das bedeutet „' + flyLabel + '". ';
  txt += 'Convek bewertet den Tag als <b>' + cvkLbl(cvk.day_rating) + '</b>. ';

  if (flyPct >= 72) txt += 'Die Chancen stehen gut, ';
  else if (flyPct >= 55) txt += 'Es könnte klappen, ';
  else if (flyPct >= 40) txt += 'Eher durchwachsen, ';
  else txt += 'Schwierige Bedingungen, ';

  txt += 'der Wind liegt bei ' + windDesc + '. ';
  if (th0.blh_max_m > 1500) txt += 'Die Thermik reicht bis etwa ' + f(th0.blh_max_m) + ' m – das ist ordentlich. ';
  else if (th0.blh_max_m > 800) txt += 'Die Thermik trägt auf rund ' + f(th0.blh_max_m) + ' m. ';
  else txt += 'Die Thermik ist mit ' + f(th0.blh_max_m) + ' m eher flach. ';

  if (sk0.cloud_avg_pct > 80) txt += 'Allerdings ist der Himmel mit ' + f(sk0.cloud_avg_pct) + '% Bewölkung ziemlich dicht. ';
  else if (sk0.cloud_avg_pct > 40) txt += 'Der Himmel ist mit ' + f(sk0.cloud_avg_pct) + '% Bewölkung teils bezogen. ';
  else txt += 'Der Himmel ist mit ' + f(sk0.cloud_avg_pct) + '% recht frei. ';

  if (d0.best_window && d0.best_window.length) txt += 'Das beste Flugfenster liegt zwischen <b>' + d0.best_window.join(', ') + '</b>. ';
  if (d0.flags.length) txt += 'Zu beachten: ' + flbl(d0.flags) + '. ';

  if (d1) {
    txt += '\n\n<b>Morgen (' + d1.weekday + '):</b> ' + pct(d1.paraglidable.fly) + '% Fly – ' + (d1.verdict||{}).label + '. ';
    txt += 'Wind um ' + f((d1.wind||{}).avg_kmh) + ' km/h, Fenster ' + ((d1.best_window||[]).length ? d1.best_window.join(', ') : 'unklar') + '.';
  }

  if (cur.temperature_c != null) {
    txt += '\n\n<b>Aktuell:</b> ' + cur.temperature_c.toFixed(0) + '°C an der Station ' + (cur.station||'DWD') + ', Wind ' + (cur.wind_kmh != null ? Math.round(cur.wind_kmh)+' km/h' : '–') + '.';
  }
  if (alerts.length) {
    txt += '\n\n<span class="warn">⚠️ DWD-Warnung: ' + alerts[0].event + '</span>';
  }

  // Build the Steckbrief (fact card)
  var steck = '';
  steck += '<div class="steck-row"><span class="sk">Fly</span><span class="sv" style="color:' + flyColor(pg.fly) + '">' + flyPct + '%</span></div>';
  steck += '<div class="steck-row"><span class="sk">Convek</span><span class="sv">' + cvkLbl(cvk.day_rating) + '</span></div>';
  steck += '<div class="steck-row"><span class="sk">Wind Ø</span><span class="sv">' + f(w0.avg_kmh) + ' km/h ' + (w0.dir_card_14||'') + '</span></div>';
  steck += '<div class="steck-row"><span class="sk">Böen max</span><span class="sv' + (w0.max_gust_kmh>32 ? ' warn' : '') + '">' + f(w0.max_gust_kmh) + ' km/h</span></div>';
  steck += '<div class="steck-row"><span class="sk">Thermik</span><span class="sv">' + f(th0.blh_max_m) + ' m</span></div>';
  steck += '<div class="steck-row"><span class="sk">Wolken</span><span class="sv">' + f(sk0.cloud_avg_pct) + '%</span></div>';
  steck += '<div class="steck-row"><span class="sk">CAPE</span><span class="sv">' + f(th0.cape_max) + ' J/kg</span></div>';
  steck += '<div class="steck-row"><span class="sk">Fenster</span><span class="sv good">' + (d0.best_window.length ? d0.best_window.slice(0,2).join(', ') : '–') + '</span></div>';
  if (d0.flags.length) steck += '<div class="steck-row"><span class="sk">⚠️</span><span class="sv warn">' + flbl(d0.flags).substring(0,30) + '</span></div>';

  // Build hourly progression (Tagesverlauf)
  var hours = hoursFor(d0.date);
  var verlauf = '';
  if (hours && hours.length) {
    var win = hours.filter(function(h){return h.h>=8 && h.h<=20;});
    if (win.length) {
      verlauf += '<div class="verlauf"><h4>🕐 Tagesverlauf</h4><div class="verlauf-grid">';
      verlauf += '<span class="vh">Uhr</span><span class="vh">Wind</span><span class="vh">Böen</span><span class="vh">Richtung</span><span class="vh">Wolken</span>';
      // Show every 2 hours from 8-20
      for (var h=8; h<=20; h+=2) {
        var hr = win.find(function(x){return x.h===h;});
        if (!hr) hr = win.reduce(function(a,b){return Math.abs(a.h-h)<Math.abs(b.h-h)?a:b;});
        var wcol = hr.ws>25?'#EF8A4C':hr.ws>15?'#E3B24A':'#7FE0E8';
        var gcol = hr.wg>32?'#E2655A':hr.wg>22?'#EF8A4C':'var(--ink-dim)';
        var ws850 = hours.find(function(x){return x.h===h;});
        verlauf += '<span class="vh">' + h + '</span>';
        verlauf += '<span style="color:'+wcol+'">' + (hr.ws?hr.ws.toFixed(0):'–') + '</span>';
        verlauf += '<span style="color:'+gcol+'">' + (hr.wg?hr.wg.toFixed(0):'–') + '</span>';
        verlauf += '<span style="color:var(--ink-faint)">' + (hr.wd?card16(hr.wd):'–') + '</span>';
        verlauf += '<span style="color:var(--ink-faint)">' + (hr.cc!=null?Math.round(hr.cc)+'%':'–') + '</span>';
      }
      verlauf += '</div></div>';
    }
  }

  return '<div class="briefing-grid">' +
    '<div class="steckbrief-card"><h4>📋 Steckbrief ' + d0.weekday + '</h4>' + steck + '</div>' +
    '<div class="steckbrief-card"><h4>💬 Briefing</h4>' + txt + '</div>' +
    '</div>' +
    verlauf +
    '<div style="font-size:10px;color:var(--ink-faint);margin-top:10px;text-align:center">⚠️ Kein Go/No-Go — Freigabe durch Pilot + Flugleiter</div>';
}

/* ---------- wind rose ---------- */
function renderWindRose(d){
  var rose=document.getElementById('wrose');
  var hrs=hoursFor(d.date);
  if(!hrs||!hrs.length){rose.innerHTML='';return;}
  var win=hrs.filter(function(h){return h.h>=9&&h.h<=20;});
  if(!win.length){rose.innerHTML='';return;}
  var sectors={};
  var dirs=['N','NNO','NO','ONO','O','OSO','SO','SSO','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  dirs.forEach(function(dd){sectors[dd]={count:0,wsSum:0};});
  win.forEach(function(h){
    var idx=Math.round(h.wd/22.5)%16;
    sectors[dirs[idx]].count++;
    sectors[dirs[idx]].wsSum+=h.ws||0;
  });
  var maxCount=Math.max(1,dirs.reduce(function(m,dd){return Math.max(m,sectors[dd].count);},0));
  function wroseColor(ws){if(ws>=35)return'#ef4444';if(ws>=25)return'#f97316';if(ws>=15)return'#fbbf24';return'#0ea5e9';}
  var R=100,cx=110,cy=110;
  var paths='';
  dirs.forEach(function(dd,i){
    var s=sectors[dd];
    if(!s.count)return;
    var r=(s.count/maxCount)*R;
    var avgWS=s.wsSum/s.count;
    var a1=(i*22.5-90-11.25)*Math.PI/180,a2=((i+1)*22.5-90-11.25)*Math.PI/180;
    var x1=cx+r*Math.cos(a1),y1=cy+r*Math.sin(a1);
    var x2=cx+r*Math.cos(a2),y2=cy+r*Math.sin(a2);
    paths+='<path d="M'+cx+','+cy+' L'+x1.toFixed(1)+','+y1.toFixed(1)+' A'+r.toFixed(1)+','+r.toFixed(1)+' 0 0,1 '+x2.toFixed(1)+','+y2.toFixed(1)+' Z" fill="'+wroseColor(avgWS)+'" opacity="0.8" stroke="#e8eaed" stroke-width="0.5"><title>'+dd+': '+s.count+'x O'+avgWS.toFixed(0)+' km/h</title></path>';
  });
  var rings='';
  for(var r=R/3;r<=R;r+=R/3)rings+='<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" stroke="#d4d9e0" stroke-width="0.6"/>';
  var clabels='';
  [{d:'N',a:-90},{d:'O',a:0},{d:'S',a:90},{d:'W',a:180}].forEach(function(xx){
    var a=xx.a*Math.PI/180;
    clabels+='<text x="'+(cx+(R+14)*Math.cos(a)).toFixed(1)+'" y="'+(cy+(R+14)*Math.sin(a)+3).toFixed(1)+'" fill="#6b7280" font-size="9" text-anchor="middle">'+xx.d+'</text>';
  });
  rose.innerHTML='<h4>Windrose 9\u201320h</h4><svg class="wrose-svg" viewBox="0 0 220 220" role="img" aria-label="Windrose">'+rings+paths+clabels+'</svg><div class="wrose-legend"><span><span class="sw" style="background:#0ea5e9"></span>0\u201315</span><span><span class="sw" style="background:#fbbf24"></span>15\u201325</span><span><span class="sw" style="background:#f97316"></span>25\u201335</span><span><span class="sw" style="background:#ef4444"></span>35+ km/h</span></div>';
}

/* ---------- cloud layers ---------- */
function renderCloudLayers(d){
  var cl=document.getElementById('cloudlayers');
  var sk=d.sky||{};
  var l=sk.cloud_low,m=sk.cloud_mid,h=sk.cloud_high;
  if(l==null&&m==null&&h==null){cl.innerHTML='';return;}
  var maxH=72,tot=sk.cloud_avg_pct||0;
  var lh=l!=null?Math.max(4,(l/100)*maxH):0;
  var mh=m!=null?Math.max(4,(m/100)*maxH):0;
  var hh=h!=null?Math.max(4,(h/100)*maxH):0;
  cl.innerHTML='<h4>Bew\u00f6lkung 14h</h4><div class="cloudbars"><div style="flex:1;display:flex;flex-direction:column;align-items:center"><div style="height:'+(maxH-lh)+'px"></div><div class="cloudbar low" style="height:'+lh+'px" data-tip="cloud"></div><div class="cloudbar-label">Tief</div></div><div style="flex:1;display:flex;flex-direction:column;align-items:center"><div style="height:'+(maxH-mh)+'px"></div><div class="cloudbar mid" style="height:'+mh+'px" data-tip="cloud"></div><div class="cloudbar-label">Mittel</div></div><div style="flex:1;display:flex;flex-direction:column;align-items:center"><div style="height:'+(maxH-hh)+'px"></div><div class="cloudbar high" style="height:'+hh+'px" data-tip="cloud"></div><div class="cloudbar-label">Hoch</div></div></div><div class="cloud-total">'+tot+'<span>% Gesamt</span></div>';
}

/* ---------- model comparison (4-Tageszeiten-Tabelle für gewählten Tag) ---------- */
function renderModelComparison(d){
  var mb=document.getElementById('mbody');
  var hm=(d.confidence||{}).hourly_models;
  if(!hm||!hm.length){
    mb.innerHTML='<div class="loading">Keine stündlichen Multi-Modell-Daten verfügbar</div>';return;
  }

  var modelDefs=[
    {label:'ICON', key:'icon', color:'#7FE0E8'},
    {label:'ECMWF',key:'ecmwf',color:'#9C7BD0'},
    {label:'GFS',  key:'gfs',  color:'#E3B24A'}
  ];

  function angDiff(a,b){if(a==null||b==null)return 0;var diff=Math.abs(a-b);return diff>180?360-diff:diff;}

  // Windpfeil: zeigt Schlepprichtung (wohin der Wind weht = Schlepprichtung)
  function windArrow(deg){
    if(deg==null)return'';
    var arrows=['↑','↗','→','↘','↓','↙','←','↖'];
    return arrows[Math.round(deg/45)%8];
  }

  // Tabelle: Zeilen = Uhrzeiten, Spalten = Modelle
  var html='<div class="mc-hourly-wrap"><table class="model-table mc-hourly-tbl"><thead><tr>'
    +'<th class="mc-th-time">Uhr</th>';
  modelDefs.forEach(function(m){
    html+='<th style="color:'+m.color+'">'+m.label+'</th>';
  });
  html+='</tr></thead><tbody>';

  hm.forEach(function(entry){
    var hour=entry.hour;
    var models=entry.models||{};
    var iconWs=(models.icon||{}).ws;
    var iconWd=(models.icon||{}).wd;

    html+='<tr><td class="mc-hour-cell">'+String(hour).padStart(2,'0')+':00</td>';

    modelDefs.forEach(function(mdef){
      var m=models[mdef.key]||{};
      var ws=m.ws,wd=m.wd,wg=m.wg,temp=m.temp;

      var cellStyle='';
      // Wind-Geschwindigkeit: Abweichung von ICON markieren
      if(mdef.key!=='icon'&&ws!=null&&iconWs!=null){
        var wsDiff=Math.abs(ws-iconWs);
        if(wsDiff>20)cellStyle='background:rgba(249,115,22,.18)';
        else if(wsDiff>10)cellStyle='background:rgba(251,191,36,.18)';
      }

      var dirTxt=wd!=null?(card16(wd)+' '+windArrow(wd)):'–';
      var dirStyle='';
      // Windrichtung: Abweichung von ICON >45° markieren
      if(mdef.key!=='icon'&&angDiff(wd,iconWd)>45){
        dirStyle='color:#f59e0b;font-weight:600';
        dirTxt+=' ⚠';
      }

      var inner='';
      if(ws!=null||wg!=null){
        inner+='<span class="mc-ws">'+(ws!=null?ws+' km/h':'–')+'</span>'
          +' <span class="mc-dir" style="'+dirStyle+'">'+dirTxt+'</span>';
        if(wg!=null)inner+='<br><span class="mc-wg">&#8593;'+wg+' km/h</span>';
        if(temp!=null)inner+=' <span class="mc-temp">'+temp+'°</span>';
      }else{
        inner='–';
      }

      html+='<td class="mc-model-cell" style="'+cellStyle+'">'+inner+'</td>';
    });

    html+='</tr>';
  });

  html+='</tbody></table></div>';

  // Tages-Einigkeit (aus daily confidence) anzeigen
  var conf=d.confidence||{};
  var agreeEl=conf.models_agree===true
    ?'<span style="color:#10b981">✓ Modelle einig</span> · Streuung Böen: '+(conf.gust_spread_kmh||'–')+' km/h'
    :conf.models_agree===false
    ?'<span style="color:#f59e0b">⚠ Modelle uneinig</span> · Streuung Böen: '+(conf.gust_spread_kmh||'–')+' km/h'
    :'';
  if(agreeEl)html+='<div style="font-size:10px;color:var(--ink-faint);margin-top:6px">'+agreeEl+'</div>';

  html+='<div style="font-size:9px;color:var(--ink-faint);margin-top:5px">↑ = Böen · ⚠ = Windrichtung >45° od. Wind >10 km/h (gelb) / >20 km/h (orange) abweichend von ICON</div>';
  mb.innerHTML=html;
}

/* ---------- windy ---------- */
function loadWindy(){
  var f=document.getElementById('windyframe');
  if(f.src.indexOf('embed.windy.com')>=0)return;
  f.src='https://embed.windy.com/embed2.html?lat=52.294&lon=9.377&detailLat=52.294&detailLon=9.377&width=100%&height=480&zoom=9&level=surface&overlay=wind&product=ecmwf&menu=&message=&marker=&calendar=now&pressure=&type=map&location=coordinates&detail=&metricWind=km%2Fh&metricTemp=%C2%B0C&radarRange=-1';
}

load();
