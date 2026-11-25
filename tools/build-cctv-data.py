#!/usr/bin/env python3
"""Ubah all_cctv_atcsindonesia.json -> cctv-data.json (ringkas, dibaca cctv-public.js).
Pakai:  python3 tools/build-cctv-data.py all_cctv_atcsindonesia.json cctv-data.json
Format keluaran: kolom paralel + tabel string (hemat ukuran, ~1/3 dari aslinya).
Kind (k): h=HLS  y=YouTube(iframe)  e=halaman embed(iframe)  i=gambar/MJPEG  v=video mp4  a=tak dikenal(coba gambar lalu HLS)  p=hanya portal
Status (s): 0=live 1=offline 2=tak diketahui     Flag (f): bit1=lokasi perkiraan, bit2=butuh header khusus (browser tak bisa), bit4=URL relatif (proxy atcsindonesia)"""
import json, sys, re, collections, hashlib
from urllib.parse import urlparse

src, out = (sys.argv + [None, None])[1:3]
src = src or 'all_cctv_atcsindonesia.json'; out = out or 'cctv-data.json'
data = json.load(open(src, encoding='utf-8'))['data']

def url_of(x): return (x.get('streamingUrl') or x.get('streamUrl') or '').strip()
def coords(x):
    la, ln = x.get('lat'), x.get('lng')
    if not isinstance(la, (int, float)) or not isinstance(ln, (int, float)):
        c = x.get('coordinates')
        la, ln = (c[0], c[1]) if isinstance(c, list) and len(c) == 2 else (None, None)
    if not isinstance(la, (int, float)) or not isinstance(ln, (int, float)): return None
    if la == 0 and ln == 0: return None
    if abs(la) > 90 or abs(ln) > 180: la, ln = (ln, la) if abs(ln) <= 90 and abs(la) <= 180 else (None, None)
    if la is None: return None
    if -12 <= la <= 7 and 0 < ln < 10: ln += 100          # bujur kehilangan "10" di depan (mis. 5.26 -> 105.26)
    return la, ln

def kind(u, src_name):
    l = u.lower(); p = urlparse(u).path.lower(); last = p.rsplit('/', 1)[-1]
    if not u: return 'p'
    if '.m3u8' in l: return 'h'
    if 'youtube.com/embed' in l or 'youtu.be' in l: return 'y'
    if p.endswith(('.jpg', '.jpeg', '.png')) or '/img?' in l or 'nph-zms' in l or 'snapshot' in l: return 'i'
    if p.endswith('.mp4'): return 'v'
    if p.endswith(('.html', '.htm', '.php')): return 'e'
    if p.endswith(('.flv', '.m3u', '.ts')): return 'p'     # tak bisa diputar langsung di browser
    return 'a'

S, SI = [], {}
def st(s):
    s = (s or '').strip()
    if not s: return -1
    if s not in SI: SI[s] = len(S); S.append(s)
    return SI[s]

rows = []
for x in data:
    u = url_of(x)
    title = (x.get('title') or x.get('name') or '').strip() or 'CCTV'
    c = coords(x)
    status = {'live': 0, 'offline': 1}.get(x.get('status'), 2)
    flags = (2 if x.get('headers') else 0) | (4 if u.startswith('/') else 0)
    prov = x.get('province') or ''
    city = x.get('city') or x.get('regency') or ''
    if not city and ',' in (x.get('location') or ''): city = x['location'].rsplit(',', 1)[-1].strip()
    rows.append(dict(id=str(x['id']), t=title, c=c, u=u, k=kind(u, x.get('source')), s=status, f=flags,
                     pr=prov, ci=city, so=x.get('source') or x.get('region') or '', pu=x.get('sourceUrl') or '',
                     au=(x.get('auditComment') or '')[:160], de=(x.get('description') or '')[:160]))

# titik tanpa koordinat: taruh di tengah rata-rata kota/provinsi yang sama (ditandai perkiraan)
def mean(g): return (sum(a for a, _ in g) / len(g), sum(b for _, b in g) / len(g))
by_city, by_prov = collections.defaultdict(list), collections.defaultdict(list)
for r in rows:
    if r['c']:
        if r['ci']: by_city[(r['pr'], r['ci'])].append(r['c'])
        if r['pr']: by_prov[r['pr']].append(r['c'])
placed = unplaced = 0
for r in rows:
    if r['c']: continue
    g = by_city.get((r['pr'], r['ci'])) or by_prov.get(r['pr'])
    if not g: unplaced += 1; continue
    la, ln = mean(g); h = int(hashlib.md5(r['id'].encode()).hexdigest()[:8], 16)
    r['c'] = (la + ((h % 1000) / 1000 - .5) * .02, ln + (((h >> 10) % 1000) / 1000 - .5) * .02)
    r['f'] |= 1; placed += 1

rows = [r for r in rows if r['c']]
cols = dict(i=[r['id'] for r in rows], t=[r['t'] for r in rows],
            la=[round(r['c'][0], 6) for r in rows], ln=[round(r['c'][1], 6) for r in rows],
            u=[r['u'] for r in rows], k=''.join(r['k'] for r in rows), s=''.join(str(r['s']) for r in rows),
            f=[r['f'] for r in rows], pr=[st(r['pr']) for r in rows], ci=[st(r['ci']) for r in rows],
            so=[st(r['so']) for r in rows], pu=[st(r['pu']) for r in rows],
            n=[st(r['au'] or r['de']) for r in rows])
doc = dict(v=1, count=len(rows), S=S, **cols)
json.dump(doc, open(out, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
import os
print(f'total sumber {len(data)} -> ditulis {len(rows)} titik ({os.path.getsize(out)/1e6:.1f} MB)')
print(f'koordinat diperkirakan: {placed} | dibuang karena tak bisa ditempatkan: {unplaced}')
print('kind:', collections.Counter(r['k'] for r in rows)); print('status:', collections.Counter(r['s'] for r in rows))
