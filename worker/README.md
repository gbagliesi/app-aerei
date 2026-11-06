# Worker Cloudflare per i tabelloni ufficiali

L'app gira nel browser, che non può leggere direttamente i tabelloni dei siti degli aeroporti.
Questo piccolo Worker (gratuito) li legge al posto suo e li restituisce all'app.

Aeroporti supportati: **Pisa (PSA)**, **Firenze (FLR)**, **Ginevra (GVA)**.
Fonti: l'API pubblica dei siti di Toscana Aeroporti (Pisa, Firenze) e il feed dell'app dell'aeroporto di Ginevra.
Dati: gate, check-in, nastro, orario stimato e stato; per Ginevra anche le marche dell'aereo.

## Pubblicarlo (una volta sola, ~5 minuti)

1. Entra su [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Create Worker**.
2. Nome: `tabellone-voli` → **Deploy**.
3. Premi **Edit code**, cancella tutto il codice di esempio e incolla il contenuto di [`worker.js`](worker.js) → **Deploy**.
4. Copia l'indirizzo del Worker (tipo `https://tabellone-voli.TUONOME.workers.dev`).
5. Nell'app: ⚙︎ Impostazioni → incolla l'indirizzo nel campo del Worker → **Prova il Worker** → **Salva**.

## Verifica e diagnostica

- `https://…workers.dev/board?airport=PSA&nature=D` — partenze di Pisa (`nature=A` per gli arrivi)
- `https://…workers.dev/debug?airport=FLR&nature=D` — mostra l'indirizzo letto, i tempi e l'inizio della risposta

Di default il Worker risponde solo all'app su `https://gbagliesi.github.io` e a `http://localhost:8000`.
Per cambiarlo aggiungi in **Settings → Variables** una variabile `ALLOWED_ORIGINS` con gli indirizzi separati da virgola.

Le risposte restano in cache 90 secondi: l'aeroporto riceve al massimo poche richieste al minuto.
