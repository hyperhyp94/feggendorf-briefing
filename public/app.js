/* Feggendorf flight-briefing frontend.
   Consumes /api/briefing (backend). Falls back to direct calls if no backend. */

const GLOSSARY = {
  fly:        ['fly', 'Paraglidable-KI: Wahrscheinlichkeit, dass an dem Tag überhaupt geflogen/gemeldet wird (0–100%).'],
  xc:         ['XC', 'Wahrscheinlichkeit für einen 60+-Punkte-Streckenflug (PWC-Wertung). An Schleppgeländen meist niedrig.'],
  verdict:    ['Verdict', 'Gesamteinschätzung aus fly plus Wind/Böen/Thermik.'],
  avgWind:    ['Ø Bodenwind', 'Mittlerer Wind in 10 m über das Fenster 9–20 h. Fürs Schleppen brauchst du stetigen Gegenwind.'],
  maxGust:    ['Max Böe', 'Stärkste Böe im Tagesfenster — der kritische Wert beim Windenschlepp.'],
  gustFactor: ['Böenfaktor', 'Böe geteilt durch Mittelwind. Über ~1,8 wird es böig und ruppig.'],
  upper850:   ['Höhenwind 850', 'Wind auf 850 hPa (~1500 m). Zeigt Oberwind und Drift der Thermik.'],
  shear:      ['Scherung', 'Windunterschied Boden↔850 hPa. Hoch (>20) = Scherung/Turbulenz möglich.'],
  blh:        ['Thermikobergrenze', 'Grenzschichthöhe ≈ wie hoch die Thermik trägt.'],
  cloudbase:  ['Wolkenbasis', 'Geschätzte Basis aus Spread Temp/Taupunkt, in m über Grund.'],
  sun:        ['Sonnenstunden', 'Sonne im Fenster 9–20 h — Antrieb für die Thermik.'],
  rad:        ['Einstrahlung', 'Maximale Globalstrahlung (W/m²) — Energie für Thermik.'],
  cape:       ['CAPE', 'Labilität. Hoch (>800) = Schauer/Gewitter möglich.'],
  cin:        ['CIN', 'Deckel, der Thermik bremst. Stark negativ = Auslöse schwer.'],
  cloud:      ['Bewölkung', 'Mittlere Gesamtbewölkung; Klammer = tief/mittel/hoch.'],
  precip:     ['Regen', 'Maximale Niederschlagswahrscheinlichkeit im Fenster.'],
  dir:        ['Windrichtung', 'Pfeile zeigen, wohin der Wind weht. Gegen die Schlepprichtung ausrichten.'],
  confidence: ['Konfidenz', 'Stimmen ICON, ECMWF und GFS überein? Übereinstimmung = verlässlicher.'],
  warning:    ['DWD-Warnung', 'Amtliche Unwetterwarnung des DWD (über Bright Sky).']
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
      best_window:compress(win.filter(x=>x.wg<=30&&x.ws>=6&&x.ws<=28&&(x.pp||0)<30).map(x=>x.h)),
      flags,confidence:{models_agree:null,note:'—'}};
  });
}
function vd(f){if(f==null)return{level:null,label:'—'};if(f>=0.85)return{level:4,label:'Top-Tag'};if(f>=0.72)return{level:3,label:'Guter Tag'};if(f>=0.55)return{level:2,label:'Möglich'};if(f>=0.40)return{level:1,label:'Grenzwertig'};return{level:0,label:'Bleib unten'};}
const r1=x=>(x==null||isNaN(x))?null:Math.round(x*10)/10;

/* ---------- render ---------- */
function render(){
  $('site').textContent=B.site.name;
  $('coords').textContent=B.site.lat.toFixed(3)+', '+B.site.lon.toFixed(3);
  renderAlerts(); renderNow(); renderRibbon(); renderDwdLink(); renderFooter();
  selected = B.days.find(d=>d.date===todayISO)?.date || B.days[0].date;
  setMode('day'); select(selected);
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
  $('dayview').classList.toggle('hidden',m!=='day'); $('weekview').classList.toggle('hidden',m!=='week');
  $('selNote').textContent=m==='day'?'Tagesansicht — ein Tag, Stunde für Stunde.':'Wochenansicht — alle 10 Tage im Vergleich.';
  if(m==='week') renderWeek();
}
$('btnDay').onclick=()=>setMode('day');
$('btnWeek').onclick=()=>setMode('week');

function select(date){
  selected=date;
  [...$('ribbon').children].forEach(c=>c.classList.toggle('sel',c.dataset.date===date));
  const d=B.days.find(x=>x.date===date); if(!d) return;
  const f=d.paraglidable.fly,c=flyColor(f),dt=new Date(date+'T12:00');
  const vl=$('vlabel');vl.textContent=d.verdict.label;vl.style.color=c;vl.setAttribute('data-tip','verdict');
  const vf=$('vfly');vf.textContent=f!=null?Math.round(f*100)+'%':'–';vf.style.color=c;
  $('vsub').innerHTML=`<b>${d.weekday}, ${dt.getDate()}. ${MON[dt.getMonth()]}</b> — ${subText(d.verdict.level)} · XC ${d.paraglidable.xc!=null?Math.round(d.paraglidable.xc*100):'–'}%`;
  if(mode==='day') renderDay(d);
}

function hoursFor(date){
  if(!B.hourly) return null;
  const t=B.hourly.time,out=[];
  for(let i=0;i<t.length;i++) if(t[i].slice(0,10)===date) out.push({h:+t[i].slice(11,13),ws:B.hourly.wind_speed_10m[i],wg:B.hourly.wind_gusts_10m[i],wd:B.hourly.wind_direction_10m[i],ws850:B.hourly.wind_speed_850hPa?B.hourly.wind_speed_850hPa[i]:null});
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
  let gridY='';for(let v=0;v<=ymax;v+=10)gridY+=`<line x1="${padL}" y1="${Y(v)}" x2="${W-padR}" y2="${Y(v)}" stroke="#284058"/><text x="${padL-5}" y="${Y(v)+3}" fill="#5E748B" font-size="9" text-anchor="end" font-family="JetBrains Mono">${v}</text>`;
  let xlab='';for(let h=x0;h<=x1;h+=3)xlab+=`<text x="${X(h)}" y="${H-padB+16}" fill="#5E748B" font-size="9" text-anchor="middle" font-family="JetBrains Mono">${h}</text>`;
  let dirs='';for(let h=x0;h<=x1;h+=3){const hh=seg.find(s=>s.h===h);if(hh)dirs+=`<g transform="translate(${X(h)},${H-10}) rotate(${hh.wd})"><line x1="0" y1="5" x2="0" y2="-5" stroke="#90A6BC" stroke-width="1.4"/><path d="M0,-5 L-2.5,-1 M0,-5 L2.5,-1" stroke="#90A6BC" stroke-width="1.4" fill="none"/></g>`;}
  const w=d.wind,th=d.thermal,sk=d.sky;

  wbody.innerHTML=`
    <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Wind, Böen, Höhenwind">
      <rect x="${padL}" y="${Y(25)}" width="${W-padL-padR}" height="${Y(8)-Y(25)}" fill="#4FA47F" opacity="0.10"/>
      <text x="${W-padR}" y="${Y(25)-3}" fill="#4FA47F" font-size="9" text-anchor="end" font-family="JetBrains Mono" opacity=".8">Bodenwind ideal 8–25</text>
      ${gridY}${xlab}
      <polygon points="${area}" fill="#7FE0E8" opacity="0.10"/>
      <polyline points="${P('ws850')}" fill="none" stroke="#9C7BD0" stroke-width="1.5"/>
      <polyline points="${P('wg')}" fill="none" stroke="#EF8A4C" stroke-width="1.6" stroke-dasharray="3 3"/>
      <polyline points="${P('ws')}" fill="none" stroke="#7FE0E8" stroke-width="2.2"/>
      ${dirs}
    </svg>
    <div class="chips" style="margin-bottom:4px">
      <span class="chip" style="border-color:#7FE0E8;color:#7FE0E8" data-tip="avgWind">Bodenwind 10m</span>
      <span class="chip" style="border-color:#EF8A4C;color:#EF8A4C" data-tip="maxGust">Böen</span>
      <span class="chip" style="border-color:#9C7BD0;color:#b79fe0" data-tip="upper850">Höhenwind 850</span>
    </div>
    <div class="stat-row">
      <div class="stat"><span class="k" data-tip="avgWind">Ø Bodenwind</span><span class="v">${fmt(w.avg_kmh)} <small>km/h</small></span></div>
      <div class="stat"><span class="k" data-tip="maxGust">Max Böe</span><span class="v" style="color:${w.max_gust_kmh>35?'#EF8A4C':'inherit'}">${fmt(w.max_gust_kmh)} <small>km/h · ${w.max_gust_hour??'–'}h</small></span></div>
      <div class="stat"><span class="k" data-tip="gustFactor">Böenfaktor</span><span class="v">${fmt(w.gust_factor)}×</span></div>
      <div class="stat"><span class="k" data-tip="shear">850 · Scherung</span><span class="v">${fmt(w.upper_850_kmh)} <small>km/h · Δ${fmt(w.shear_kmh)}</small></span></div>
    </div>
    <div class="compass">${w.dir_deg_14!=null?arrow(w.dir_deg_14):''}
      <div data-tip="dir" style="font-family:'JetBrains Mono',monospace;font-size:11px;color:#90A6BC">Windrichtung 14h: <b style="color:#EAF2FA">${w.dir_deg_14??'–'}° ${w.dir_card_14||''}</b><br><span style="color:#5E748B">gegen Schlepprichtung ausrichten</span></div>
    </div>`;

  const warns=[];
  if(d.flags.includes('gusts_high'))warns.push(['bad',`Böen bis ${fmt(w.max_gust_kmh)} km/h — kritisch für den Schlepp.`]);
  else if(d.flags.includes('gusts'))warns.push(['','Böig — Böenfaktor und Startfenster prüfen.']);
  if(d.flags.includes('shear'))warns.push(['',`Windscherung (Δ${fmt(w.shear_kmh)} km/h) — Turbulenz möglich.`]);
  if(d.flags.includes('rain'))warns.push(['bad',`Niederschlag wahrscheinlich (bis ${sk.precip_prob_max}%).`]);
  if(d.flags.includes('cb'))warns.push(['bad',`CB-/Gewitterpotenzial — CAPE bis ${th.cape_max} J/kg.`]);
  else if(d.flags.includes('unstable'))warns.push(['',`Labile Schichtung (CAPE ${th.cape_max}) — Überentwicklung beobachten.`]);
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
    const confTxt=conf===true?'<span style="color:#4FA47F">einig</span>':conf===false?'<span style="color:#EF8A4C">uneinig</span>':'–';
    return `<tr data-date="${d.date}" class="${d.date===todayISO?'today':''}">
      <td><span class="flytag" style="background:${c}">${d.paraglidable.fly!=null?Math.round(d.paraglidable.fly*100):'–'}</span></td>
      <td>${d.paraglidable.xc!=null?Math.round(d.paraglidable.xc*100):'–'}%</td>
      <td>${d.weekday} ${dt.getDate()}.${dt.getMonth()+1}.</td>
      <td>${fmt(w.avg_kmh)}</td>
      <td style="color:${w.max_gust_kmh>35?'#EF8A4C':'inherit'}">${fmt(w.max_gust_kmh)}</td>
      <td>${fmt(th.sun_hours)}h</td>
      <td style="color:${sk.precip_prob_max>=40?'#EF8A4C':'inherit'}">${fmt(sk.precip_prob_max)}%</td>
      <td style="color:${th.cape_max>=800?'#EF8A4C':'inherit'}">${fmt(th.cape_max)}</td>
      <td>${w.upper_850_kmh!=null?fmt(w.upper_850_kmh)+' '+(w.upper_850_card||''):'–'}</td>
      <td>${confTxt}</td>
    </tr>`;
  }).join('');
  [...tb.querySelectorAll('tr')].forEach(tr=>tr.onclick=()=>{select(tr.dataset.date);setMode('day');});
}

const fmt=x=>(x==null||x==='')?'–':x;
function arrow(d){return `<svg class="arrow" viewBox="0 0 40 40" data-tip="dir"><circle cx="20" cy="20" r="18" fill="none" stroke="#284058"/><g transform="rotate(${d} 20 20)"><line x1="20" y1="32" x2="20" y2="8" stroke="#7FE0E8" stroke-width="2.4"/><path d="M20,8 L15,15 M20,8 L25,15" stroke="#7FE0E8" stroke-width="2.4" fill="none"/></g><text x="20" y="23" fill="#5E748B" font-size="7" text-anchor="middle" font-family="JetBrains Mono">N↑</text></svg>`;}

load();
