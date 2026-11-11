/* ---------- page ---------- */
const DATA = JSON.parse(document.getElementById('bus-data').textContent);
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = v => Math.round(v * 100) + '%';
const SIDE_WORD = { L: 'left', R: 'right' };
const STORE = 'shady-side-v1';
const st = { route: '24', dir: 0, from: 0, to: 1, date: '', time: '', scrub: 0 };
let line = null, journey = null, an = null, day = null, mapView = null;

function stopLabel(s) { return s.name + (s.letter ? ' (stop ' + s.letter + ')' : ''); }
function nowParts() { const p = londonParts(Date.now()); return { date: p.y + '-' + pad2(p.m) + '-' + pad2(p.d), time: pad2(p.h) + ':' + pad2(p.mi) }; }
function departMs() {
  const [y, m, d] = st.date.split('-').map(Number), [h, mi] = st.time.split(':').map(Number);
  return londonToUtc(y, m, d, h, mi);
}

/* ----- planner ----- */
function fillRoutes() { $('route-list').innerHTML = Object.keys(DATA.routes).map(r => '<option value="' + esc(r) + '">').join(''); }

function setRoute(id, opts) {
  opts = opts || {};
  st.route = id; $('f-route').value = id; $('f-err').textContent = '';
  const dirs = DATA.routes[id];
  st.dir = Math.min(opts.dir || 0, dirs.length - 1);
  const box = $('f-dir'); box.className = 'seg' + (dirs.length === 1 ? ' single' : '');
  box.innerHTML = dirs.map((d, i) => { const l = buildLine(DATA, id, i); return '<button type="button" data-dir="' + i + '" aria-pressed="' + (i === st.dir) + '">to ' + esc(l.dest) + '<small>from ' + esc(l.stops[0].name) + '</small></button>'; }).join('');
  setDir(st.dir, opts);
}

function setDir(i, opts) {
  opts = opts || {};
  st.dir = i;
  for (const b of $('f-dir').children) b.setAttribute('aria-pressed', String(+b.dataset.dir === i));
  line = buildLine(DATA, st.route, i);
  const n = line.stops.length;
  st.from = Number.isInteger(opts.from) && opts.from < n - 1 ? opts.from : 0;
  $('f-from').innerHTML = line.stops.slice(0, n - 1).map((s, k) => '<option value="' + k + '">' + esc(stopLabel(s)) + '</option>').join('');
  $('f-from').value = st.from;
  fillTo(Number.isInteger(opts.to) ? opts.to : n - 1);
  if (!opts.silent) update();
}

function fillTo(want) {
  const n = line.stops.length;
  st.to = want > st.from && want < n ? want : n - 1;
  $('f-to').innerHTML = line.stops.map((s, k) => k > st.from ? '<option value="' + k + '">' + esc(stopLabel(s)) + '</option>' : '').join('');
  $('f-to').value = st.to;
}

function tryRoute(raw, final) {
  const v = raw.trim().toUpperCase();
  if (DATA.routes[v]) { if (v !== st.route) { st.scrub = 0; setRoute(v); } else $('f-err').textContent = ''; }
  else if (final && v) $('f-err').textContent = 'No route ' + v + ' in TfL’s list. Try 24, N29 or SL8.';
}

/* ----- compute + render ----- */
function update() {
  journey = makeJourney(line, st.from, st.to);
  if (!journey.segs.length) { $('f-err').textContent = 'Those two stops sit at the same point on the route. Pick a later stop to get off at.'; return; }
  an = analyse(journey, departMs());
  const [y, m, d] = st.date.split('-').map(Number);
  day = dayCurve(y, m, d, journey.lat, journey.lon);
  mapView = makeMapView();
  renderBlind(); renderSplit(); renderStretches(); renderTimes(); renderLegend(); renderLive();
  $('f-scrub').value = Math.round(st.scrub * 1000);
  try { localStorage.setItem(STORE, JSON.stringify({ route: st.route, dir: st.dir, from: st.from, to: st.to, fromName: journey.from.name, toName: journey.to.name })); } catch (e) {}
}

const ref = () => an.side || 'L';
const tone = cls => (cls === 'L' || cls === 'R') ? (cls === ref() ? 'sun' : 'shade') : '';
function stopNear(dist) { let best = journey.stops[0]; for (const s of journey.stops) if (Math.abs(s.at - dist) < Math.abs(best.at - dist)) best = s; return best; }
const timeAt = dist => an.departMs + dist / BUS_MPS * 1000;

function renderBlind() {
  $('b-num').textContent = st.route;
  let say, via;
  if (an.kind === 'side') {
    const s = an.side;
    say = 'Sit on the ' + SIDE_WORD[s];
    via = (s === 'L' ? 'The door side.' : 'The driver’s side.') + ' In shade for ' + pct(1 - an.share[s]) + ' of the ride.';
    const turn = an.stretches.find(r => r.cls === s && r.len / an.total >= 0.2);
    if (turn) via += turn.start < 1 ? ' The sun is on this side until ' + stopNear(turn.end).name + '.' : ' The sun comes round to this side after ' + stopNear(turn.start).name + '.';
  } else if (an.kind === 'even') {
    say = 'Either side'; via = 'It evens out: sun on the left for ' + pct(an.share.L) + ' of the ride, on the right for ' + pct(an.share.R) + '.';
  } else if (an.kind === 'weak') {
    say = 'Either side'; via = 'The sun stays ahead of or behind the bus, so neither side gets much.';
  } else { say = 'Sit anywhere'; via = 'The sun is down for this journey.'; }
  $('b-say').textContent = say; $('b-via').textContent = via;
  const km = an.total / 1000;
  $('b-foot').textContent = 'About ' + Math.max(1, Math.round(an.durMs / 60000)) + ' min · ' + (km < 10 ? km.toFixed(1) : Math.round(km)) + ' km · ' + fmtTime(an.departMs) + ' to ' + fmtTime(an.departMs + an.durMs);
}

function renderSplit() {
  const sh = an.share, mid = sh.F + sh.B + sh.N;
  $('s-bar').innerHTML = '<i class="l" style="width:' + sh.L * 100 + '%"></i><i class="mid" style="width:' + mid * 100 + '%"></i><i class="r" style="width:' + sh.R * 100 + '%"></i>';
  $('s-bar').setAttribute('aria-label', 'Sun on the left for ' + pct(sh.L) + ' of the ride, on the right for ' + pct(sh.R));
  $('s-labels').innerHTML = '<span>Sun on left <b>' + pct(sh.L) + '</b></span><span>' + (sh.N > 0.95 ? 'Sun down' : 'Ahead or behind') + ' <b>' + pct(mid) + '</b></span><span>Sun on right <b>' + pct(sh.R) + '</b></span>';
}

function renderStretches() {
  const words = { L: 'Sun on left', R: 'Sun on right', F: 'Sun ahead', B: 'Sun behind', N: 'Sun down' };
  $('st-list').innerHTML = an.stretches.map(r => {
    const a = stopNear(r.start), b = stopNear(r.end), km = r.len / 1000;
    return '<li><span class="stripe ' + tone(r.cls) + '"></span><span class="where">' + esc(a.name) + ' to ' + esc(b.name) + '</span><span class="chip ' + tone(r.cls) + '">' + words[r.cls] + '</span><span class="when">' + fmtTime(timeAt(r.start)) + ' to ' + fmtTime(timeAt(r.end)) + ' · ' + (km < 1 ? Math.round(r.len / 10) * 10 + ' m' : km.toFixed(1) + ' km') + '</span></li>';
  }).join('');
  const side = SIDE_WORD[ref()];
  $('st-sub').textContent = an.kind === 'night' ? 'No direct sun on this journey.' : an.stretches.length === 1 ? 'The sun holds one position the whole way.' : 'Blue: the ' + side + ' side is in shade. Yellow: the sun reaches it.';
}

function renderLegend() {
  const side = SIDE_WORD[ref()], cap = side[0].toUpperCase() + side.slice(1);
  $('map-legend').innerHTML = '<li><i style="background:var(--shade)"></i>' + cap + ' side in shade</li><li><i style="background:var(--sun)"></i>' + cap + ' side in sun</li><li><i style="background:var(--muted)"></i>Sun ahead, behind or down</li>';
}

/* ----- top-down bus ----- */
function busSvg(lv) {
  const cx = 150, cy = 150, R = 126, up = lv.sun.el > 0.5;
  const rel = lv.rel * RAD, sx = cx + R * Math.sin(rel), sy = cy - R * Math.cos(rel);
  const litR = lv.cls === 'R', litL = lv.cls === 'L';
  let o = '<svg viewBox="-12 -12 324 324" role="img" aria-label="Bus seen from above with the sun ' + (up ? relPhrase(lv.rel) : 'below the horizon') + '">';
  o += '<circle cx="150" cy="150" r="' + R + '" fill="none" class="s-line" stroke-width="1.5" stroke-dasharray="2 5"/>';
  // north marker on the ring
  const nr = -lv.heading * RAD, nx = cx + (R + 17) * Math.sin(nr), ny = cy - (R + 17) * Math.cos(nr);
  o += '<text x="' + nx.toFixed(1) + '" y="' + (ny + 4).toFixed(1) + '" text-anchor="middle" class="t-label t-muted">N</text>';
  if (up) {
    // shadow: longer when the sun is lower
    const sl = Math.min(64, 9 / Math.tan(Math.max(lv.sun.el, 3) * RAD)), dx = -Math.sin(rel) * sl, dy = Math.cos(rel) * sl;
    o += '<rect x="' + (118 + dx).toFixed(1) + '" y="' + (72 + dy).toFixed(1) + '" width="64" height="156" rx="12" class="f-ink" opacity=".16"/>';
    const side = Math.abs(Math.sin(rel)) > 0.34, tx = Math.sin(rel) > 0 ? 182 : 118, ty = Math.cos(rel) > 0 ? 72 : 228;
    const targets = side ? [[tx, 105], [tx, 150], [tx, 195]] : [[132, ty], [150, ty], [168, ty]];
    for (const [ax, ay] of targets) {
      const L = Math.hypot(ax - sx, ay - sy), ux = (ax - sx) / L, uy = (ay - sy) / L;
      o += '<line x1="' + (sx + ux * 18).toFixed(1) + '" y1="' + (sy + uy * 18).toFixed(1) + '" x2="' + (ax - ux * 3).toFixed(1) + '" y2="' + (ay - uy * 3).toFixed(1) + '" class="s-sun" stroke-width="2.2" stroke-linecap="round"/>';
    }
  }
  o += '<rect x="118" y="72" width="64" height="156" rx="12" class="f-red"/>';
  o += '<rect x="125" y="78" width="50" height="9" rx="4" class="f-surface" opacity=".55"/>';         // windscreen
  o += '<rect x="116" y="94" width="4" height="20" rx="1.5" class="f-surface"/>';                        // front door, on the left
  o += '<circle cx="167" cy="99" r="5" fill="none" class="s-ink" stroke-width="2" opacity=".55"/>';       // driver, on the right
  for (let r = 0; r < 6; r++) {
    const y = 112 + r * 18.5;
    for (const [x, lit] of [[123, litL], [135, litL], [154, litR], [166, litR]]) o += '<rect x="' + x + '" y="' + y.toFixed(1) + '" width="11" height="14" rx="3" class="' + (lit ? 'f-sun' : 'f-shadesoft') + '"/>';
  }
  o += '<path d="M143 62 L150 54 L157 62" fill="none" class="s-muted" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
  o += '<text x="134" y="243" text-anchor="middle" class="t-label t-ink">left</text><text x="134" y="255" text-anchor="middle" class="t-tiny t-muted">doors</text><text x="166" y="243" text-anchor="middle" class="t-label t-ink">right</text><text x="166" y="255" text-anchor="middle" class="t-tiny t-muted">driver</text>';
  if (an.kind === 'side') {
    const lx = an.side === 'L' ? 108 : 192;
    o += '<text x="' + lx + '" y="146" text-anchor="' + (an.side === 'L' ? 'end' : 'start') + '" class="t-label t-ink halo">Sit here</text>';
    o += '<path d="M' + lx + ' 154 h' + (an.side === 'L' ? 8 : -8) + '" class="s-ink" stroke-width="2" stroke-linecap="round"/>';
  }
  if (up) o += '<circle cx="' + sx.toFixed(1) + '" cy="' + sy.toFixed(1) + '" r="15" class="f-sun" opacity=".3"/><circle cx="' + sx.toFixed(1) + '" cy="' + sy.toFixed(1) + '" r="10" class="f-sun"/>';
  else o += '<text x="150" y="30" text-anchor="middle" class="t-label t-muted">Sun below the horizon</text>';
  return o + '</svg>';
}

function relPhrase(rel) {
  const a = Math.abs(rel), side = rel > 0 ? 'right' : 'left';
  if (a < 20) return 'dead ahead';
  if (a > 160) return 'directly behind you';
  if (a < 70) return 'ahead on your ' + side;
  if (a <= 110) return 'square on your ' + side;
  return 'behind you on the ' + side;
}

/* ----- route map ----- */
function makeMapView() {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const s of journey.segs) for (const [x, y] of [[s.x0, s.y0], [s.x1, s.y1]]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const w = Math.max(x1 - x0, 500), h = Math.max(y1 - y0, 500), k = Math.min(232 / w, 214 / h);
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  return { k, px: x => 150 + (x - mx) * k, py: y => 152 - (y - my) * k };
}

function mapSvg(lv) {
  const { k, px, py } = mapView, f = v => v.toFixed(1);
  let o = '<svg viewBox="0 0 300 300" role="img" aria-label="Map of the journey, north at the top, coloured by where the sun falls"><rect width="300" height="300" rx="8" class="f-bg"/>';
  o += '<clipPath id="mapclip"><rect width="300" height="300" rx="8"/></clipPath><g clip-path="url(#mapclip)">';
  const up = lv.sun.el > 0.5, A = lv.sun.az * RAD, ux = Math.sin(A), uy = -Math.cos(A);
  if (up) for (let i = -3; i <= 3; i++) {
    const bx = 150 + uy * i * 48, by = 150 - ux * i * 48;
    o += '<line x1="' + f(bx - ux * 260) + '" y1="' + f(by - uy * 260) + '" x2="' + f(bx + ux * 260) + '" y2="' + f(by + uy * 260) + '" class="s-sun" stroke-width="1.2" stroke-dasharray="1 7" stroke-linecap="round" opacity=".6"/>';
  }
  o += '<polyline points="' + line.pts.map(p => f(px(p.x)) + ',' + f(py(p.y))).join(' ') + '" fill="none" class="s-line" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>';
  const cls = { sun: 's-sun', shade: 's-shade', '': 's-muted' };
  for (const s of an.segs) o += '<line x1="' + f(px(s.x0)) + '" y1="' + f(py(s.y0)) + '" x2="' + f(px(s.x1)) + '" y2="' + f(py(s.y1)) + '" class="' + cls[tone(s.cls)] + '" stroke-width="5.5" stroke-linecap="round"/>';
  if (journey.stops.length <= 70) for (const sp of journey.stops.slice(1, -1)) { const p = pointOnJourney(sp.at); o += '<circle cx="' + f(px(p.x)) + '" cy="' + f(py(p.y)) + '" r="1.7" class="f-surface"/>'; }
  const a = an.segs[0], b = an.segs[an.segs.length - 1];
  const ax = px(a.x0), ay = py(a.y0), bx2 = px(b.x1), by2 = py(b.y1);
  o += '<circle cx="' + f(bx2) + '" cy="' + f(by2) + '" r="5.5" class="f-surface s-red" stroke-width="3"/><circle cx="' + f(ax) + '" cy="' + f(ay) + '" r="6.5" class="f-red"/>';
  const lab = (x, y, text, other) => {
    const anchor = x > 190 ? 'end' : x < 110 ? 'start' : 'middle';
    let below = y > other; if (y < 40) below = true; if (y > 268) below = false;
    return '<text x="' + f(Math.max(8, Math.min(292, x))) + '" y="' + f(below ? y + 19 : y - 11) + '" text-anchor="' + anchor + '" class="t-label t-ink halo">' + esc(text.length > 26 ? text.slice(0, 25) + '…' : text) + '</text>';
  };
  o += lab(ax, ay, journey.from.name, by2) + lab(bx2, by2, journey.to.name, ay);
  o += '<g transform="translate(' + f(px(lv.x)) + ' ' + f(py(lv.y)) + ') rotate(' + f(lv.heading) + ')"><rect x="-4.5" y="-9" width="9" height="18" rx="2.5" class="f-red" stroke-width="1.5" style="stroke:var(--surface)"/><rect x="-2.5" y="-7" width="5" height="3" rx="1" class="f-surface"/></g>';
  if (up) { const t = Math.min(130 / Math.max(Math.abs(ux), 1e-6), 130 / Math.max(Math.abs(uy), 1e-6)), qx = 150 + ux * t, qy = 150 + uy * t; o += '<circle cx="' + f(qx) + '" cy="' + f(qy) + '" r="14" class="f-sun" opacity=".3"/><circle cx="' + f(qx) + '" cy="' + f(qy) + '" r="9" class="f-sun"/>'; }
  o += '</g>';
  o += '<path d="M17 21 v-13 m-4 5 l4 -5 l4 5" fill="none" class="s-muted" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><text x="26" y="20" class="t-tiny t-muted">N</text>';
  const bar = [5000, 2000, 1000, 500, 200, 100].find(m => m * k <= 84) || 100;
  o += '<path d="M' + f(288 - bar * k) + ' 17 h' + f(bar * k) + '" class="s-muted" stroke-width="2"/><text x="288" y="12" text-anchor="end" class="t-tiny t-muted">' + (bar >= 1000 ? bar / 1000 + ' km' : bar + ' m') + '</text>';
  return o + '</svg>';
}

function pointOnJourney(dist) {
  let s = an.segs[an.segs.length - 1];
  for (const c of an.segs) if (dist <= c.cum0 + c.len) { s = c; break; }
  const u = s.len ? Math.max(0, Math.min(1, (dist - s.cum0) / s.len)) : 0;
  return { x: s.x0 + u * (s.x1 - s.x0), y: s.y0 + u * (s.y1 - s.y0) };
}

/* ----- sun height through the day ----- */
function skySvg(lv) {
  const W = 340, H = 176, L = 30, Rm = 10, T = 12, B = 24;
  const t0 = (day.rise || day.start + 6 * 3600000) - 2700000, t1 = (day.set || day.start + 18 * 3600000) + 2700000;
  const X = ms => L + (ms - t0) / (t1 - t0) * (W - L - Rm), Y = el => T + (65 - el) / 71 * (H - T - B), f = v => v.toFixed(1);
  let o = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Height of the sun above the horizon through the day">';
  for (const g of [15, 30, 45, 60]) o += '<line x1="' + L + '" x2="' + (W - Rm) + '" y1="' + f(Y(g)) + '" y2="' + f(Y(g)) + '" class="s-line" stroke-width="1"/><text x="' + (L - 5) + '" y="' + f(Y(g) + 3.5) + '" text-anchor="end" class="t-tiny t-muted">' + g + '°</text>';
  const pts = day.pts.filter(p => p.ms >= t0 && p.ms <= t1);
  const above = pts.filter(p => p.el >= 0);
  if (above.length) o += '<polygon points="' + f(X(above[0].ms)) + ',' + f(Y(0)) + ' ' + above.map(p => f(X(p.ms)) + ',' + f(Y(p.el))).join(' ') + ' ' + f(X(above[above.length - 1].ms)) + ',' + f(Y(0)) + '" class="f-sunsoft"/>';
  const j0 = Math.max(t0, Math.min(t1, an.departMs)), j1 = Math.max(t0, Math.min(t1, an.departMs + an.durMs));
  if (j1 > j0) o += '<rect x="' + f(X(j0)) + '" y="' + T + '" width="' + f(Math.max(2, X(j1) - X(j0))) + '" height="' + f(Y(0) - T) + '" class="f-red" opacity=".2"/>';
  o += '<polyline points="' + pts.map(p => f(X(p.ms)) + ',' + f(Y(p.el))).join(' ') + '" fill="none" class="s-sun" stroke-width="2.5" stroke-linejoin="round"/>';
  o += '<line x1="' + L + '" x2="' + (W - Rm) + '" y1="' + f(Y(0)) + '" y2="' + f(Y(0)) + '" class="s-ink" stroke-width="1.5"/><text x="' + (L - 5) + '" y="' + f(Y(0) + 3.5) + '" text-anchor="end" class="t-tiny t-muted">0°</text>';
  const hrs = (t1 - t0) / 3600000, step = hrs > 13 ? 3 : 2, first = londonParts(t0);
  let tick = londonToUtc(first.y, first.m, first.d, first.h, 0) + 3600000;
  for (; tick < t1; tick += 3600000) { const p = londonParts(tick); if (p.h % step === 0 && X(tick) > L + 12 && X(tick) < W - Rm - 12) o += '<text x="' + f(X(tick)) + '" y="' + (H - 7) + '" text-anchor="middle" class="t-tiny t-muted">' + pad2(p.h) + ':00</text><line x1="' + f(X(tick)) + '" x2="' + f(X(tick)) + '" y1="' + f(Y(0)) + '" y2="' + f(Y(0) + 4) + '" class="s-ink" stroke-width="1"/>'; }
  if (lv.ms >= t0 && lv.ms <= t1 && lv.sun.el > -5) {
    const mx = X(lv.ms), my = Y(lv.sun.el);
    o += '<circle cx="' + f(mx) + '" cy="' + f(my) + '" r="6.5" class="f-sun s-ink" stroke-width="1.5"/>';
    if (lv.sun.el > 0.5) o += '<text x="' + f(Math.max(L + 24, Math.min(W - Rm - 24, mx))) + '" y="' + f(Math.max(T + 9, my - 12)) + '" text-anchor="middle" class="t-label t-ink halo">' + Math.round(lv.sun.el) + '° up</text>';
  }
  return o + '</svg>';
}

/* ----- other departure times ----- */
function renderTimes() {
  if (!day.rise || !day.set) { $('times').innerHTML = ''; return; }
  const slot = 1800000, first = Math.ceil(day.rise / slot) * slot, slots = [];
  for (let t = first; t < day.set; t += slot) slots.push(t);
  const res = slots.map(t => analyse(journey, t));
  const lane = side => '<div class="lane">' + slots.map((t, i) => {
    const r = res[i], on = r.kind === 'side' ? r.side === side : false, half = r.kind === 'even' || r.kind === 'weak';
    const now = an.departMs >= t && an.departMs < t + slot;
    const say = r.kind === 'side' ? 'sit on the ' + SIDE_WORD[r.side] : r.kind === 'night' ? 'sun down' : 'either side';
    return '<button type="button" data-t="' + t + '" class="' + (on ? 'on' : half ? 'half' : '') + (now ? ' now' : '') + '" aria-label="' + fmtTime(t) + ', ' + say + '" title="' + fmtTime(t) + ', ' + say + '"></button>';
  }).join('') + '</div>';
  const every = slots.length > 20 ? 6 : 4;
  const hours = '<div class="hours">' + slots.map((t, i) => { const p = londonParts(t); return '<span>' + (p.mi === 0 && p.h % (every / 2) === 0 && i < slots.length - 2 ? pad2(p.h) + ':00' : '') + '</span>'; }).join('') + '</div>';
  $('times').innerHTML = '<span class="lab">Left</span>' + lane('L') + '<span class="lab">Right</span>' + lane('R') + '<span></span>' + hours;
}

/* ----- live parts (follow the slider) ----- */
function renderLive() {
  const lv = liveAt(journey, an, st.scrub);
  $('fig-bus').innerHTML = busSvg(lv);
  $('fig-map').innerHTML = mapSvg(lv);
  $('fig-sky').innerHTML = skySvg(lv);
  $('scrub-where').textContent = (st.scrub >= 0.999 ? 'Arriving at ' : st.scrub <= 0.001 ? 'Leaving ' : 'After ') + (st.scrub >= 0.999 ? journey.to.name : lv.stop.name);
  $('scrub-when').textContent = fmtTime(lv.ms);
  const up = lv.sun.el > 0.5;
  $('cap-live').innerHTML = '<b>' + fmtTime(lv.ms) + '</b>, heading ' + WINDS[windIdx(lv.heading)] + '. ' + (up
    ? 'The sun is in the ' + WINDS[windIdx(lv.sun.az)] + ', ' + Math.round(lv.sun.el) + '° above the horizon: <b>' + relPhrase(lv.rel) + '</b>.'
    : 'The sun is below the horizon.');
  const pk = day.peak;
  $('sky-sub').textContent = (day.rise && day.set ? 'Sunrise ' + fmtTime(day.rise) + ', sunset ' + fmtTime(day.set) + '. ' : '') + 'Highest point ' + Math.round(pk.el) + '° at ' + fmtTime(pk.ms) + '. The red band is your journey. A low sun reaches further across the bus.';
}

/* ----- wiring ----- */
function start(saved) {
  fillRoutes();
  const now = nowParts();
  let init = { route: '24', dir: 0 };
  try { const s = JSON.parse(localStorage.getItem(STORE) || 'null'); if (s && DATA.routes[s.route]) init = s; } catch (e) {}
  if (saved && saved.route && DATA.routes[saved.route]) init = saved;
  st.date = (saved && saved.date) || now.date; st.time = (saved && saved.time) || now.time; st.scrub = (saved && saved.scrub) || 0;
  $('f-date').value = st.date; $('f-time').value = st.time;
  if (init.from === undefined && init.route === '24') {
    const l = buildLine(DATA, '24', 0);
    init.from = l.stops.findIndex(s => s.name === 'Victoria Station'); init.to = l.stops.findIndex(s => s.name === 'Camden Town Station');
    if (init.from < 0 || init.to <= init.from) { init.from = 0; init.to = l.stops.length - 1; }
  } else if (init.fromName) {
    const l = buildLine(DATA, init.route, Math.min(init.dir || 0, DATA.routes[init.route].length - 1));
    if (!l.stops[init.from] || l.stops[init.from].name !== init.fromName || !l.stops[init.to] || l.stops[init.to].name !== init.toName) { init.from = undefined; init.to = undefined; }
  }
  setRoute(init.route, { dir: init.dir || 0, from: init.from, to: init.to });

  $('f-route').addEventListener('input', e => tryRoute(e.target.value, false));
  $('f-route').addEventListener('change', e => tryRoute(e.target.value, true));
  $('planner').addEventListener('submit', e => { e.preventDefault(); tryRoute($('f-route').value, true); });
  $('f-dir').addEventListener('click', e => { const b = e.target.closest('button'); if (b && +b.dataset.dir !== st.dir) { st.scrub = 0; setDir(+b.dataset.dir); } });
  $('f-from').addEventListener('change', e => { st.from = +e.target.value; st.scrub = 0; fillTo(st.to); update(); });
  $('f-to').addEventListener('change', e => { st.to = +e.target.value; st.scrub = 0; update(); });
  $('f-date').addEventListener('change', e => { if (e.target.value) { st.date = e.target.value; update(); } });
  $('f-time').addEventListener('change', e => { if (e.target.value) { st.time = e.target.value; update(); } });
  $('f-now').addEventListener('click', () => { const n = nowParts(); st.date = n.date; st.time = n.time; $('f-date').value = n.date; $('f-time').value = n.time; update(); });
  $('f-scrub').addEventListener('input', e => { st.scrub = e.target.value / 1000; renderLive(); });
  $('times').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; st.time = fmtTime(+b.dataset.t); $('f-time').value = st.time; update(); });

  const gd = DATA.geoDate || '', nice = iso => new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  $('data-note').innerHTML = 'Routes and stops: Powered by TfL Open Data. Contains OS data © Crown copyright and database rights 2016 and Geomni UK Map data © and database rights 2019. ' + Object.keys(DATA.routes).length + ' routes, with route lines from ' + nice(gd.slice(0, 4) + '-' + gd.slice(4, 6) + '-' + gd.slice(6, 8)) + ' and stop lists from ' + nice(DATA.stopsDate) + '. A few stops on recently changed routes may be missing, and diversions are not included.';
}
try { window.claude && window.claude.hot && window.claude.hot.snapshot && window.claude.hot.snapshot(() => ({ route: st.route, dir: st.dir, from: st.from, to: st.to, date: st.date, time: st.time, scrub: st.scrub })); } catch (e) {}
if (window.claude && window.claude.hot && window.claude.hot.ready) window.claude.hot.ready(start); else start((window.claude && window.claude.hot && window.claude.hot.data) || {});
