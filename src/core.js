/* ---------- core: sun maths, route geometry, journey analysis (no DOM) ---------- */
const RAD = Math.PI / 180;
const R0 = 6371000, LAT0 = 51.5 * RAD;
const KX = Math.cos(LAT0) * R0 * RAD, KY = R0 * RAD;   // metres per degree, matches the data build
const BUS_MPS = 9 * 1609.344 / 3600;                  // London buses average about 9 mph
const SIDE_MIN = 0.2;                                 // sideways share of sunlight below which the sun counts as ahead/behind

function decodeLine(str) {
  const out = []; let i = 0, lat = 0, lon = 0;
  const next = () => { let r = 0, s = 0, b; do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << s; s += 5; } while (b >= 32); return (r & 1) ? ~(r >> 1) : (r >> 1); };
  while (i < str.length) { lat += next(); lon += next(); out.push({ x: lon / 1e5 * KX, y: lat / 1e5 * KY }); }
  return out;
}

/* Sun position: azimuth in degrees clockwise from north, elevation in degrees above the horizon. */
function sunAt(ms, latDeg, lonDeg) {
  const d = ms / 86400000 - 0.5 + 2440588 - 2451545;
  const M = RAD * (357.5291 + 0.98560028 * d);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI, e = RAD * 23.4397;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
  const phi = RAD * latDeg;
  const H = RAD * (280.16 + 360.9856235 * d) + RAD * lonDeg - ra;
  const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)) + Math.PI;
  return { az: ((az / RAD) % 360 + 360) % 360, el: el / RAD };
}

/* London clock time <-> UTC, independent of the viewer's own time zone. */
const LDN_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
function londonParts(ms) {
  const p = {}; for (const part of LDN_FMT.formatToParts(new Date(ms))) p[part.type] = part.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute };
}
function londonToUtc(y, m, d, h, mi) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off = ms => { const p = londonParts(ms); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(ms / 60000) * 60000; };
  let t = guess - off(guess);
  return guess - off(t);
}
const pad2 = n => String(n).padStart(2, '0');
function fmtTime(ms) { const p = londonParts(ms); return pad2(p.h) + ':' + pad2(p.mi); }

const WINDS = ['north', 'north-north-east', 'north-east', 'east-north-east', 'east', 'east-south-east', 'south-east', 'south-south-east', 'south', 'south-south-west', 'south-west', 'west-south-west', 'west', 'west-north-west', 'north-west', 'north-north-west'];
const WINDS_SHORT = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const windIdx = deg => Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
const wrap180 = a => ((a + 540) % 360) - 180;

/* One direction of a route: its line in metres plus the stops along it. */
function buildLine(DATA, routeId, dirIdx) {
  const d = DATA.routes[routeId][dirIdx];
  if (!d._line) {
    const pts = decodeLine(d.p), cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    const stops = []; let t = 0;
    for (let i = 0; i < d.s.length; i += 2) { t += d.s[i + 1]; const s = DATA.stops[d.s[i]]; stops.push({ name: s[0], letter: s[1] || '', t: Math.min(t, cum[cum.length - 1]) }); }
    d._line = { pts, cum, stops, dest: d.d, total: cum[cum.length - 1] };
  }
  return d._line;
}

function pointAt(line, t) {
  const { pts, cum } = line; let lo = 0, hi = cum.length - 1;
  t = Math.max(0, Math.min(t, cum[hi]));
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= t) lo = mid; else hi = mid; }
  const span = cum[hi] - cum[lo] || 1, u = (t - cum[lo]) / span;
  return { x: pts[lo].x + u * (pts[hi].x - pts[lo].x), y: pts[lo].y + u * (pts[hi].y - pts[lo].y), i: lo };
}

/* The part of the line between two stops, as straight pieces with a compass heading each. */
function makeJourney(line, iFrom, iTo) {
  const a = line.stops[iFrom], b = line.stops[iTo];
  const pa = pointAt(line, a.t), pb = pointAt(line, b.t);
  const pts = [{ x: pa.x, y: pa.y }];
  for (let i = pa.i + 1; i <= pb.i; i++) pts.push(line.pts[i]);
  pts.push({ x: pb.x, y: pb.y });
  const segs = []; let cum = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y, len = Math.hypot(dx, dy);
    if (len < 0.5) continue;
    segs.push({ x0: pts[i - 1].x, y0: pts[i - 1].y, x1: pts[i].x, y1: pts[i].y, len, cum0: cum, heading: (Math.atan2(dx, dy) / RAD + 360) % 360 });
    cum += len;
  }
  const stops = line.stops.slice(iFrom, iTo + 1).map(s => ({ name: s.name, letter: s.letter, at: Math.max(0, Math.min(cum, s.t - a.t)) }));
  const mid = segs.length ? segs[segs.length >> 1] : { x0: pa.x, y0: pa.y };
  return { segs, total: cum, stops, lat: mid.y0 / KY, lon: mid.x0 / KX, from: a, to: b };
}

/* How the sun falls on the bus for one heading: side > 0 means the right-hand side is lit. */
function sunOnBus(sun, heading) {
  const rel = wrap180(sun.az - heading);
  const up = sun.el > 0.5;
  const side = up ? Math.sin(rel * RAD) * Math.cos(sun.el * RAD) : 0;
  let cls = 'N';
  if (up) cls = side > SIDE_MIN ? 'R' : side < -SIDE_MIN ? 'L' : (Math.cos(rel * RAD) >= 0 ? 'F' : 'B');
  return { rel, side, cls };
}

function analyse(j, departMs) {
  let eL = 0, eR = 0; const share = { L: 0, R: 0, F: 0, B: 0, N: 0 };
  const segs = j.segs.map(s => {
    const tMid = departMs + (s.cum0 + s.len / 2) / BUS_MPS * 1000;
    const sun = sunAt(tMid, j.lat, j.lon), on = sunOnBus(sun, s.heading);
    if (on.side > 0) eR += on.side * s.len; else eL += -on.side * s.len;
    share[on.cls] += s.len;
    return { ...s, tMid, az: sun.az, el: sun.el, rel: on.rel, side: on.side, cls: on.cls };
  });
  const total = j.total || 1;
  for (const k in share) share[k] /= total;
  const lit = eL + eR;
  let kind, side = null;
  if (share.N > 0.95) kind = 'night';
  else if (lit / total < 0.06) kind = 'weak';
  else if (Math.abs(eL - eR) / lit < 0.15) kind = 'even';
  else { kind = 'side'; side = eL < eR ? 'L' : 'R'; }
  return { segs, share, eL, eR, kind, side, total, departMs, durMs: total / BUS_MPS * 1000, stretches: stretches(segs, total) };
}

/* Merge the straight pieces into a few stretches where the sun stays on one side. */
function stretches(segs, total) {
  let runs = [];
  for (const s of segs) {
    const last = runs[runs.length - 1];
    if (last && last.cls === s.cls) { last.len += s.len; last.end = s.cum0 + s.len; }
    else runs.push({ cls: s.cls, start: s.cum0, end: s.cum0 + s.len, len: s.len });
  }
  const minLen = Math.max(300, total * 0.07);
  for (;;) {
    let k = -1;
    for (let i = 0; i < runs.length; i++) if (runs[i].len < minLen && (k < 0 || runs[i].len < runs[k].len)) k = i;
    if (k < 0 || runs.length === 1) break;
    const prev = runs[k - 1], next = runs[k + 1];
    const into = !prev ? next : !next ? prev : (prev.len >= next.len ? prev : next);
    into.len += runs[k].len; into.start = Math.min(into.start, runs[k].start); into.end = Math.max(into.end, runs[k].end);
    runs.splice(k, 1);
    const merged = [];
    for (const r of runs) { const l = merged[merged.length - 1]; if (l && l.cls === r.cls) { l.len += r.len; l.end = r.end; } else merged.push(r); }
    runs = merged;
  }
  return runs;
}

/* Position, heading and sun for a point part-way through the journey (for the slider). */
function liveAt(j, an, frac) {
  const dist = Math.max(0, Math.min(1, frac)) * j.total;
  let s = an.segs[an.segs.length - 1];
  for (const c of an.segs) if (dist <= c.cum0 + c.len) { s = c; break; }
  const u = s.len ? Math.max(0, Math.min(1, (dist - s.cum0) / s.len)) : 0;
  const ms = an.departMs + dist / BUS_MPS * 1000;
  const sun = sunAt(ms, j.lat, j.lon), on = sunOnBus(sun, s.heading);
  let stop = j.stops[0];
  for (const st of j.stops) if (st.at <= dist + 1) stop = st;
  return { dist, ms, x: s.x0 + u * (s.x1 - s.x0), y: s.y0 + u * (s.y1 - s.y0), heading: s.heading, sun, ...on, stop };
}

/* The sun's height through one London day, with sunrise and sunset. */
function dayCurve(y, m, d, lat, lon) {
  const start = londonToUtc(y, m, d, 0, 0), pts = []; let rise = null, set = null, peak = { el: -90, ms: start };
  let prev = null;
  for (let k = 0; k <= 288; k++) {
    const ms = start + k * 300000, el = sunAt(ms, lat, lon).el;
    pts.push({ ms, el });
    if (el > peak.el) peak = { el, ms };
    if (prev !== null) {
      const h0 = -0.833;
      if (prev < h0 && el >= h0 && rise === null) rise = ms - 300000 * (el - h0) / (el - prev);
      if (prev >= h0 && el < h0 && rise !== null) set = ms - 300000 * (el - h0) / (el - prev);
    }
    prev = el;
  }
  return { pts, rise, set, peak, start };
}

if (typeof module !== 'undefined') module.exports = { decodeLine, sunAt, londonParts, londonToUtc, fmtTime, buildLine, makeJourney, analyse, liveAt, dayCurve, sunOnBus, WINDS, windIdx };
