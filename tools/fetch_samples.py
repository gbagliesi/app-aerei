#!/usr/bin/env python3
"""Scarica le richieste di tools/fetch.json (pagine pubbliche e endpoint) in samples/ per analizzarle.
Ogni voce: {"id","url","body"?,"headers"?}. Scrive samples/<id>.txt con stato e intestazioni in testa."""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from discover import get
os.makedirs('samples', exist_ok=True)
for it in json.load(open(sys.argv[1])):
    st, hd, b, fu, dt = get(it['url'], it.get('body'), it.get('headers'), limit=3_000_000)
    print(f"{it['id']}: {st} {len(b)} {dt:.1f}s {it['url']}")
    with open(f"samples/{it['id']}.txt", 'w') as f:
        f.write(f"# {it['url']}\n# status {st} final {fu}\n# " + json.dumps(hd) + "\n\n" + b)
