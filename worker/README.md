# Worker Cloudflare per i tabelloni ufficiali

L'app gira nel browser, che non può leggere direttamente i tabelloni dei siti degli aeroporti.
Questo piccolo Worker (gratuito) li legge al posto suo e li restituisce all'app.

Aeroporti supportati: **Pisa (PSA)**, **Firenze (FLR)**, **Fiumicino (FCO)**, **Ciampino (CIA)**, **Bari, Brindisi, Foggia, Taranto**,
**Milano Malpensa (MXP)** e **Linate (LIN)**, **Bologna (BLQ)**, **Catania (CTA)**, **Palermo (PMO)**,
**Torino (TRN)**, **Cagliari (CAG)**, **Ginevra (GVA)**, **Zurigo (ZRH)**, **Francoforte (FRA)**, **Monaco (MUC)**,
**Madrid (MAD)**, **Barcellona (BCN)**, **Lisbona (LIS)**, **Londra Gatwick (LGW)**, **Stansted (STN)**, **Luton (LTN)**, **City (LCY)**,
**Lione (LYS)**, **Parigi Beauvais (BVA)**, **Amsterdam (AMS)**.

Fonti (tutte pubbliche, usate dai siti o dalle app degli aeroporti):
- Pisa, Firenze: API dei siti di Toscana Aeroporti. Puglia: backend dell'app ufficiale. Ginevra: feed dell'app.
- Fiumicino, Ciampino: pagina "Voli in tempo reale" di adr.it (HTML).
- Milano: API SEA dei siti milanomalpensa-airport.com / milanolinate-airport.com (header `keyId`, la chiave pubblica del sito;
  se SEA la cambia, impostala nella variabile `SEA_KEY_ID` del Worker).
- Zurigo: `flightdata.flughafen-zuerich.ch/flights` (JSON). Francoforte: JSON del sito frankfurt-airport.com.
- Catania: API GraphQL del sito aeroporto.catania.it. Monaco, Palermo, Bologna: tabelloni HTML dei siti.
- Madrid, Barcellona: tabellone di aena.es. Lisbona: proxy voli di aeroportolisboa.pt. Cagliari: JSON di sogaer.it.
  Torino, Luton, Beauvais: tabelloni HTML dei siti. Gatwick: FetchFlights del sito. Stansted: API GraphQL del sito.
  London City: API voli del sito. Lione: `/api/flights/list` di lyonaeroports.com.
- Amsterdam: Public Flight API 4.2 ufficiale di Schiphol (developer.schiphol.nl, token OAuth). Client ID e secret dell'app, salvati
  come segreti del Worker `SCHIPHOL_APP_ID` e `SCHIPHOL_APP_KEY` (Settings → Variables and Secrets, tipo Secret).
- Non disponibili (protezioni anti-bot o chiave/registrazione): Napoli, Venezia, Genova, Orio al Serio, Olbia, Alghero,
  Heathrow, Parigi CDG/Orly.

Dati: gate, check-in, nastro, orario stimato e stato (dove l'aeroporto li pubblica); marche dell'aereo per Milano,
Ginevra, Zurigo e Francoforte. Monaco non pubblica il gate nell'elenco; Palermo e Bologna solo i voli di oggi.

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
