#!/usr/bin/env python3
"""Ricerca fonti ufficiali: dal runner di GitHub scarica la home e le pagine voli
di ogni aeroporto, segue i bundle JS dello stesso sito e cerca URL di API.
Uso: python3 tools/discover.py tools/discover.json [CODICI...]"""
import json, re, sys, urllib.request, urllib.parse, ssl, time

UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'
LINK_KW = re.compile(r'(depart|arriv|flight|flug|abflug|ankunft|odlot|przylot|vuel|salid|llegad|indul|erkez|avgang|ankomst|lahtev|saapu|odlet|prilet|polasc|dolasc|polijet|vol|pti|afgang|vertrek|aankomst|abfl)', re.I)
API_KW = re.compile(r'(api|graphql|json|flight|flug|wp-json|ajax|rest/|appsync|odata|fids|board|departure|arrival)', re.I)
STR = re.compile(r'''["'`](https?://[^"'`\s<>]{4,220}|/[A-Za-z0-9_\-./?=&%{}$:]{3,220})["'`]''')
SKIP_EXT = re.compile(r'\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|css|mp4|pdf)(\?|$)', re.I)

def get(url, data=None, headers=None, limit=4_000_000):
    h = {'User-Agent': UA, 'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-GB,en;q=0.9'}
    h.update(headers or {})
    req = urllib.request.Request(url, data=data.encode() if isinstance(data, str) else data, headers=h)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=20, context=ssl.create_default_context()) as r:
            body = r.read(limit)
            return r.status, dict(r.headers), body.decode('utf-8', 'replace'), r.geturl(), time.time() - t0
    except urllib.error.HTTPError as e:
        b = e.read(20000).decode('utf-8', 'replace')
        return e.code, dict(e.headers), b, url, time.time() - t0
    except Exception as e:
        return 0, {}, f'ERR {e}', url, time.time() - t0

def blocked(st, hd, body):
    s = (hd.get('Server') or hd.get('server') or '')
    if st in (403, 429, 503) or re.search(r'cf-chl|challenge-platform|Just a moment|captcha|Incapsula|_Incapsula_|radware|perfdrive|px-captcha|Access Denied', body[:20000], re.I):
        return f'BLOCCO? status {st} server {s}'
    return ''

def probe(item):
    """Prova diretta di un endpoint: {url, method?, body?, headers?, grep?}"""
    st, hd, b, fu, dt = get(item['url'], item.get('body'), item.get('headers'))
    print(f"--- PROBE {item.get('method','POST' if item.get('body') else 'GET')} {item['url']}\n    status {st} {dt:.1f}s len {len(b)} type {hd.get('Content-Type')} server {hd.get('Server')} {blocked(st,hd,b)}")
    print('    start:', re.sub(r'\s+', ' ', b[:item.get('show', 700)]))
    if item.get('grep'):
        m = list(dict.fromkeys(re.findall(item['grep'], b, re.I)))[:40]
        print('    grep:', m)

def discover(code, cfg):
    print(f"\n######## {code} {cfg.get('name','')}")
    pages = list(cfg.get('pages', []))
    home = cfg['home']
    seen_pages, found, scripts = set(), {}, []
    base_host = urllib.parse.urlparse(home).hostname.split('.', 1)[-1] if home.count('.') > 1 else urllib.parse.urlparse(home).hostname
    queue = [home] + pages
    n = 0
    while queue and n < 5:
        u = queue.pop(0)
        if u in seen_pages: continue
        seen_pages.add(u); n += 1
        st, hd, b, fu, dt = get(u)
        print(f"PAGE {u} -> {st} {dt:.1f}s len {len(b)} server {hd.get('Server')} {blocked(st,hd,b)}")
        if st != 200: continue
        if u == home:
            links = [urllib.parse.urljoin(fu, x) for x in re.findall(r'href="([^"#]+)"', b)]
            links = [l for l in dict.fromkeys(links) if LINK_KW.search(urllib.parse.urlparse(l).path) and base_host in (urllib.parse.urlparse(l).hostname or '') and not SKIP_EXT.search(l)]
            print('  link voli:', links[:12])
            queue += links[:3]
        for s in re.findall(r'<script[^>]+src="([^"]+)"', b):
            s = urllib.parse.urljoin(fu, s)
            if s not in scripts and base_host in (urllib.parse.urlparse(s).hostname or '') : scripts.append(s)
        for x in STR.findall(b):
            if API_KW.search(x) and not SKIP_EXT.search(x): found.setdefault(x, 'html')
        for x in re.findall(r'data-(?:api|url|endpoint|src)[a-z-]*="([^"]+)"', b): found.setdefault(x, 'data-attr')
    for s in scripts[:14]:
        st, hd, b, fu, dt = get(s)
        if st != 200: continue
        k = 0
        for x in STR.findall(b):
            if API_KW.search(x) and not SKIP_EXT.search(x) and x not in found:
                found[x] = s.rsplit('/', 1)[-1][:40]; k += 1
        if k: print(f"  js {s} len {len(b)}: {k} stringhe")
    items = [x for x in found if not re.search(r'(google|facebook|gtm|analytics|hotjar|onetrust|cookie|youtube|twitter|linkedin|schema\.org|w3\.org)', x, re.I)]
    print(f"  URL candidati ({len(items)}):")
    for x in items[:90]: print('   ', x, f'[{found[x]}]')

if __name__ != "__main__": pass
else:
  cfg = json.load(open(sys.argv[1]))
  only = set(sys.argv[2:])
  for p in cfg.get('probes', []):
      if not only or p.get('code') in only: probe(p)
  for code, c in cfg.get('airports', {}).items():
      if not only or code in only:
          try: discover(code, c)
          except Exception as e: print(code, 'ERRORE', e)
