import json, math, sys, glob, os, re, collections
GEO_DIR, STOPS_JSON, RSTOPS_JSON, DEST_JSON, OUT = sys.argv[1:6]
S = json.load(open(STOPS_JSON))['stops']
RS = json.load(open(RSTOPS_JSON))
DEST = json.load(open(DEST_JSON))['routes']
R0 = 6371000.0
LAT0 = math.radians(51.5); KX = math.cos(LAT0)*R0*math.pi/180; KY = R0*math.pi/180
def xy(lon, lat): return (lon*KX, lat*KY)

def prep(line):
    pts = [xy(a, b) for a, b in line]
    cum = [0.0]
    for i in range(1, len(pts)):
        cum.append(cum[-1] + math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]))
    return pts, cum

def candidates(pts, cum, p):
    """per segment closest point: (t_along, dist, signed_left_offset)"""
    out = []
    px, py = p
    for i in range(len(pts)-1):
        ax, ay = pts[i]; bx, by = pts[i+1]
        dx, dy = bx-ax, by-ay; L2 = dx*dx+dy*dy
        if L2 == 0: continue
        u = max(0.0, min(1.0, ((px-ax)*dx+(py-ay)*dy)/L2))
        cx, cy = ax+u*dx, ay+u*dy
        d = math.hypot(px-cx, py-cy)
        cross = dx*(py-ay) - dy*(px-ax)   # >0 => point is left of travel
        out.append((cum[i]+u*math.sqrt(L2), d, d if cross > 0 else -d))
    return out

def fit(cands, total, reverse=False):
    """greedy sequential snap of an ordered stop list; cands[i] = per-segment candidates of stop i.
    returns per-stop (t, dist, left) and the running cost after each stop"""
    res = []; run = []; cost = 0.0
    prev = total if reverse else 0.0
    order = range(len(cands)-1, -1, -1) if reverse else range(len(cands))
    for i in order:
        best = None
        for t, d, l in cands[i]:
            pen = d
            back = (t - prev) if reverse else (prev - t)
            if back > 40: pen += 150 + 0.3*back
            elif back < -2500: pen += 0.03*(-back - 2500)
            if l < -4: pen += 12          # right-hand side of travel: unlikely in the UK
            if best is None or pen < best[0]: best = (pen, t, d, l)
        pen, t, d, l = best
        t = min(t, prev) if reverse else max(t, prev); prev = t
        res.append((t, d, l)); cost += min(pen, 400); run.append(cost)
    return res, run

routes_geo = {}
src_date = None
for fn in glob.glob(os.path.join(GEO_DIR, '*.geojson')):
    g = json.load(open(fn))
    rid = g['metadata']['routeId']; src_date = g['metadata'].get('sourceDate', src_date)
    dirs = collections.OrderedDict()
    for f in sorted(g['features'], key=lambda f: f['properties']['direction']):
        geom = f['geometry']
        parts = [geom['coordinates']] if geom['type'] == 'LineString' else geom['coordinates']
        dirs[f['properties']['direction']] = [p for p in parts if len(p) >= 2]
    routes_geo[rid] = dirs

def enc_num(v):
    v = ~(v << 1) if v < 0 else (v << 1)
    o = ''
    while v >= 0x20:
        o += chr((0x20 | (v & 0x1f)) + 63); v >>= 5
    return o + chr(v + 63)
def enc_poly(line):
    o = ''; pa = pb = 0
    for lon, lat in line:
        a = round(lat*1e5); b = round(lon*1e5)
        o += enc_num(a-pa) + enc_num(b-pb); pa, pb = a, b
    return o

def disp(sid):
    s = S[sid]; ind = (s.get('indicator') or '').strip()
    m = re.match(r'^Stop\s+(\S+)$', ind)
    return s['name'].replace('  ', ' ').strip(), (m.group(1) if m else '')

stop_index = {}; stop_table = []
def sidx(sid):
    if sid not in stop_index:
        stop_index[sid] = len(stop_table); n, l = disp(sid); stop_table.append([n, l] if l else [n])
    return stop_index[sid]

out_routes = {}; report = []; skipped = []
FAR = 60
def words(s): return set(w for w in re.sub(r"[^a-z0-9 ]", " ", s.lower().replace("'", "")).split() if len(w) > 2 and w not in ('the','station','road','street','bus','and'))
for rid, seq in RS['routes'].items():
    geo = routes_geo.get(rid)
    ids = [x['id'] for x in seq]
    if not geo or len(ids) < 4: skipped.append(rid); continue
    n = len(ids)
    P = [xy(S[i]['lon'], S[i]['lat']) for i in ids]
    dkeys = list(geo.keys())
    V = {}   # (dk, vi) -> (pts, cum, cands)
    for dk in dkeys:
        for vi, part in enumerate(geo[dk]):
            pts, cum = prep(part); V[(dk, vi)] = (pts, cum, [candidates(pts, cum, p) for p in P])
    if len(dkeys) == 1:
        k0 = dkeys[0]
        vi = min(range(len(geo[k0])), key=lambda vi: fit(V[(k0, vi)][2], V[(k0, vi)][1][-1])[1][-1])
        chosen = [(k0, vi, 0, n)]
    else:
        a, b = dkeys[0], dkeys[1]; best = None
        for first, second in ((a, b), (b, a)):
            # prefix cost on `first` (forward greedy) and suffix cost on `second` (backward greedy), per variant
            pre = {vi: fit(V[(first, vi)][2], V[(first, vi)][1][-1])[1] for vi in range(len(geo[first]))}
            suf = {vi: fit(V[(second, vi)][2], V[(second, vi)][1][-1], reverse=True)[1] for vi in range(len(geo[second]))}
            for k in range(2, n-1):
                pv = min(pre, key=lambda vi: pre[vi][k-1]); sv = min(suf, key=lambda vi: suf[vi][n-k-1])
                tot = pre[pv][k-1] + suf[sv][n-k-1]
                if best is None or tot < best[0]: best = (tot, [(first, pv, 0, k), (second, sv, k, n)])
        chosen = sorted(best[1], key=lambda c: c[0])
    dest = DEST.get(rid, {})
    built = []; far = 0; worst = 0
    for dk, vi, i0, i1 in chosen:
        pts, cum, cands = V[(dk, vi)]
        r, _ = fit(cands[i0:i1], cum[-1])
        keep = [(ids[i0+j], t) for j, (t, d, l) in enumerate(r) if d <= FAR]
        far += (i1 - i0) - len(keep); worst = max([worst] + [d for t, d, l in r if d <= FAR])
        if len(keep) < 2: continue
        built.append((dk, geo[dk][vi], keep))
    if not built: skipped.append(rid); continue
    # which end is which: match the published destinations to the last stops of each direction
    labs = [(dest.get(k) or {}) for k in ('outbound', 'inbound')]
    def score(lab, keep):
        w = words((lab.get('full') or '') + ' ' + (lab.get('qualifier') or ''))
        tail = words(' '.join(S[s]['name'] for s, _ in keep[-5:])); head = words(' '.join(S[s]['name'] for s, _ in keep[:5]))
        return len(w & tail) - len(w & head)
    if len(built) == 2:
        straight = score(labs[0], built[0][2]) + score(labs[1], built[1][2])
        swapped = score(labs[1], built[0][2]) + score(labs[0], built[1][2])
        if swapped > straight: labs = labs[::-1]; report.append((rid, 'swapped-labels'))
    dirs_out = []
    for (dk, line, keep), lab in zip(built, labs):
        refs = []; prev = 0
        for sid, t in keep:
            ti = int(round(t)); refs += [sidx(sid), ti - prev]; prev = ti
        dirs_out.append({'d': lab.get('destination') or S[keep[-1][0]]['name'], 'p': enc_poly(line), 's': refs})
    out_routes[rid] = dirs_out
    report.append((rid, n, [len(b[2]) for b in built], far, round(worst)))

def rkey(r):
    m = re.match(r'^([A-Za-z]*)(\d*)([A-Za-z]*)$', r)
    return (0 if not m.group(1) else 1, m.group(1), int(m.group(2) or 0), m.group(3))
out = {'geoDate': src_date, 'stopsDate': RS.get('generated_at_utc', '')[:10], 'stops': stop_table,
       'routes': {k: out_routes[k] for k in sorted(out_routes, key=rkey)}}
json.dump(out, open(OUT, 'w'), separators=(',', ':'), ensure_ascii=False)
json.dump(report, open(OUT + '.report.json', 'w'))
print('routes', len(out_routes), 'skipped', len(skipped), skipped[:40])
print('stops in table', len(stop_table), 'bytes', os.path.getsize(OUT))
